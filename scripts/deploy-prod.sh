#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-prod.sh — Deploy labs-mcp-gamma + labs-saas-ctrl to mcp.5pm.ai
#
# Builds Docker images (linux/amd64), pushes to Artifact Registry,
# runs db-migrate, and updates all Cloud Run services/jobs.
#
# CRITICAL: This deploys to PRODUCTION. All VITE_* build args for the SPA
# must be explicitly set — Dockerfile defaults are gamma values.
# See LESSONS_LEARNED.md: "Prod SPA deployed with gamma Auth0 client_id"
#
# Usage:
#   ./scripts/deploy-prod.sh [--skip-build] [--skip-migrate] [--dry-run]
#                            [--only <component>]...
#
# Components (repeatable via --only; default = all five):
#   mcp       : prod-mcp Cloud Run Service (mcp-server image)
#   worker    : prod-ingest-worker Cloud Run Job
#   ctrl-api  : prod-ctrl-api Cloud Run Service
#   ctrl      : prod-ctrl Cloud Run Service (SPA)
#   migrate   : db-migrate Cloud Run Job (applies both MCP + ctrl init.sql)
#
# Prerequisites:
#   1. gcloud authenticated (roles/owner on ai-5pm-mcp)
#   2. Docker running with buildx support
#   3. Artifact Registry auth: gcloud auth configure-docker us-east4-docker.pkg.dev
#   4. Deploy to gamma first and run all e2e tests before deploying to prod
#   5. `../labs-saas-ctrl` checked out alongside this repo (required for migrate
#      and ctrl-api / ctrl builds).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGION="us-east4"
PROJECT="ai-5pm-mcp"
REGISTRY="us-east4-docker.pkg.dev/${PROJECT}/prod-docker"
DOMAIN="https://mcp.5pm.ai"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
CTRL_REPO="$(cd "$SCRIPT_DIR/../../labs-saas-ctrl" 2>/dev/null && pwd)" || CTRL_REPO=""

SKIP_BUILD=false
SKIP_MIGRATE=false
DRY_RUN=false
ONLY_COMPONENTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)   SKIP_BUILD=true; shift ;;
    --skip-migrate) SKIP_MIGRATE=true; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --only)
      [[ $# -ge 2 ]] || { echo "--only requires a component name" >&2; exit 1; }
      ONLY_COMPONENTS+=("$2"); shift 2 ;;
    -h|--help)      head -22 "${BASH_SOURCE[0]}" | tail -20; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;35m[deploy-prod]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy-prod] ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy-prod] ⚠\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy-prod] ✗\033[0m %s\n' "$*" >&2; exit 1; }

# Component selection: empty ONLY_COMPONENTS means "all" (today's default).
ALL_COMPONENTS=(mcp worker ctrl-api ctrl migrate)
want() {
  local target="$1"
  if [[ ${#ONLY_COMPONENTS[@]} -eq 0 ]]; then return 0; fi
  for c in ${ONLY_COMPONENTS[@]+"${ONLY_COMPONENTS[@]}"}; do
    [[ "$c" == "$target" ]] && return 0
  done
  return 1
}

for c in ${ONLY_COMPONENTS[@]+"${ONLY_COMPONENTS[@]}"}; do
  valid=false
  for v in "${ALL_COMPONENTS[@]}"; do
    [[ "$c" == "$v" ]] && valid=true && break
  done
  $valid || die "--only $c is not a valid component (one of: ${ALL_COMPONENTS[*]})"
done

need_ctrl_repo=false
for t in ctrl-api ctrl migrate; do
  want "$t" && need_ctrl_repo=true
done
if $need_ctrl_repo && [[ -z "$CTRL_REPO" ]]; then
  die "labs-saas-ctrl not found at ../labs-saas-ctrl. Required for ctrl-api/ctrl/migrate."
fi

# ─── Prod SPA Build Args (CRITICAL — all must be explicit) ───────────────────
# Dockerfile defaults are gamma values. Omitting any of these will bake gamma
# config into the production SPA. See LESSONS_LEARNED.md.

PROD_AUTH0_CLIENT_ID="nsflJdrV8RsRoc6qarMWjl934jZkZkt0"
PROD_AUTH0_AUDIENCE="https://api.mcp.5pm.ai"
PROD_APP_ORIGIN="https://mcp.5pm.ai"
PROD_STRIPE_PK="pk_live_51T7k37A4ISKxBM0V6ElTU1AvCpHvSH76g3l8ferglld26a1M0xgPcEkc1Q7S5BRxXn3DTvq1jqAzW9X24L1w8V1l00rxjnhIDc"
PROD_DEPLOYMENT_ENV="production"
PROD_GA_MEASUREMENT_ID="G-NN1CKPZMTV"

# ─── Version bump ─────────────────────────────────────────────────────────────

current_image() {
  local kind="$1" name="$2"
  if [[ "$kind" == "service" ]]; then
    gcloud run services describe "$name" --region="$REGION" --project="$PROJECT" \
      --format='value(spec.template.spec.containers[0].image)' 2>/dev/null
  else
    gcloud run jobs describe "$name" --region="$REGION" --project="$PROJECT" \
      --format=json 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['spec']['template']['spec']['template']['spec']['containers'][0]['image'])"
  fi
}

next_version() {
  local img="$1"
  local tag="${img##*:}"
  local num="${tag#v}"
  echo "v$((num + 1))"
}

MCP_TAG=""; API_TAG=""; SPA_TAG=""; WORKER_TAG=""
MCP_VER=""; API_VER=""; SPA_VER=""; WORKER_VER=""

if want mcp || want migrate; then
  MCP_IMG=$(current_image service prod-mcp)
  MCP_VER=$(next_version "$MCP_IMG")
  MCP_TAG="${REGISTRY}/mcp-server:${MCP_VER}"
fi
if want ctrl-api; then
  API_IMG=$(current_image service prod-ctrl-api)
  API_VER=$(next_version "$API_IMG")
  API_TAG="${REGISTRY}/ctrl-api:${API_VER}"
fi
if want ctrl; then
  SPA_IMG=$(current_image service prod-ctrl)
  SPA_VER=$(next_version "$SPA_IMG")
  SPA_TAG="${REGISTRY}/ctrl-plane:${SPA_VER}"
fi
if want worker; then
  WORKER_IMG=$(current_image job prod-ingest-worker)
  WORKER_VER=$(next_version "$WORKER_IMG")
  WORKER_TAG="${REGISTRY}/ingest-worker:${WORKER_VER}"
fi

log "═══ PRODUCTION DEPLOYMENT ═══"
log ""
log "Deploy plan:"
if [[ ${#ONLY_COMPONENTS[@]} -gt 0 ]]; then
  log "  --only: ${ONLY_COMPONENTS[*]}"
fi
want mcp       && log "  mcp-server   : ${MCP_VER} → prod-mcp"
want ctrl-api  && log "  ctrl-api     : ${API_VER} → prod-ctrl-api"
want ctrl      && log "  ctrl-plane   : ${SPA_VER} → prod-ctrl"
want worker    && log "  ingest-worker: ${WORKER_VER} → prod-ingest-worker"
want migrate   && log "  db-migrate   : ${MCP_VER} image (applies mcp+ctrl init.sql)"
log ""
if want ctrl; then
  log "SPA build args (all explicit — no Dockerfile defaults used):"
  log "  VITE_AUTH0_CLIENT_ID : ${PROD_AUTH0_CLIENT_ID}"
  log "  VITE_AUTH0_AUDIENCE  : ${PROD_AUTH0_AUDIENCE}"
  log "  VITE_APP_ORIGIN      : ${PROD_APP_ORIGIN}"
  log "  VITE_STRIPE_PK       : ${PROD_STRIPE_PK:0:25}..."
  log "  VITE_DEPLOYMENT_ENV  : ${PROD_DEPLOYMENT_ENV}"
  log "  VITE_GA_MEASUREMENT_ID: ${PROD_GA_MEASUREMENT_ID}"
  log ""
fi

if $DRY_RUN; then
  log "[DRY-RUN] Would build, push, migrate, and deploy the above."
  exit 0
fi

read -r -p "[deploy-prod] Deploy to PRODUCTION? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || die "Aborted."

# ─── Stage ctrl init.sql for inclusion in mcp-server image ───────────────────
# See deploy-gamma.sh and LESSONS_LEARNED 2026-04-21 for rationale.
CTRL_SQL_STAGED=""
stage_ctrl_sql() {
  [[ -n "$CTRL_REPO" ]] || die "ctrl repo required to stage ctrl-init.sql"
  [[ -f "$CTRL_REPO/db/init.sql" ]] || die "missing $CTRL_REPO/db/init.sql"
  CTRL_SQL_STAGED="$MCP_REPO/db/ctrl-init.sql"
  cp "$CTRL_REPO/db/init.sql" "$CTRL_SQL_STAGED"
  ok "Staged ctrl init.sql → $CTRL_SQL_STAGED"
}
cleanup_ctrl_sql() {
  [[ -n "$CTRL_SQL_STAGED" && -f "$CTRL_SQL_STAGED" ]] && rm -f "$CTRL_SQL_STAGED"
}
trap cleanup_ctrl_sql EXIT

# ─── Build ────────────────────────────────────────────────────────────────────

if ! $SKIP_BUILD; then
  log "Building images (linux/amd64)..."

  [[ -d "$MCP_REPO" ]] || die "MCP repo not found: $MCP_REPO"

  if want mcp || want migrate; then
    stage_ctrl_sql
    docker buildx build --platform linux/amd64 \
      -t "$MCP_TAG" -f "$MCP_REPO/Dockerfile" "$MCP_REPO"
    ok "Built $MCP_TAG"
  fi

  if want worker; then
    docker buildx build --platform linux/amd64 \
      -t "$WORKER_TAG" -f "$MCP_REPO/Dockerfile.worker" "$MCP_REPO"
    ok "Built $WORKER_TAG"
  fi

  if want ctrl-api; then
    docker buildx build --platform linux/amd64 \
      -t "$API_TAG" -f "$CTRL_REPO/Dockerfile.api" "$CTRL_REPO"
    ok "Built $API_TAG"
  fi

  if want ctrl; then
    # CRITICAL: ALL VITE_* build args must be explicitly set for prod
    docker buildx build --platform linux/amd64 \
      --build-arg VITE_AUTH0_CLIENT_ID="$PROD_AUTH0_CLIENT_ID" \
      --build-arg VITE_AUTH0_AUDIENCE="$PROD_AUTH0_AUDIENCE" \
      --build-arg VITE_STRIPE_PUBLISHABLE_KEY="$PROD_STRIPE_PK" \
      --build-arg VITE_APP_ORIGIN="$PROD_APP_ORIGIN" \
      --build-arg VITE_DEPLOYMENT_ENV="$PROD_DEPLOYMENT_ENV" \
      --build-arg VITE_GA_MEASUREMENT_ID="$PROD_GA_MEASUREMENT_ID" \
      -t "$SPA_TAG" -f "$CTRL_REPO/Dockerfile" "$CTRL_REPO"
    ok "Built $SPA_TAG"
  fi

  # ─── Push ─────────────────────────────────────────────────────────────────

  log "Pushing images..."
  for tag in "$MCP_TAG" "$WORKER_TAG" "$API_TAG" "$SPA_TAG"; do
    [[ -n "$tag" ]] || continue
    docker push "$tag"
    ok "Pushed $tag"
  done
fi

# ─── DB Migrate ──────────────────────────────────────────────────────────────

if want migrate && ! $SKIP_MIGRATE; then
  MIGRATE_IMAGE="$MCP_TAG"
  if [[ -z "$MIGRATE_IMAGE" ]]; then
    MIGRATE_IMAGE=$(gcloud run jobs describe db-migrate --region="$REGION" --project="$PROJECT" \
      --format=json 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['spec']['template']['spec']['template']['spec']['containers'][0]['image'])")
    log "Re-running db-migrate at existing image: $MIGRATE_IMAGE"
  fi
  log "Running db-migrate..."
  gcloud run jobs update db-migrate --region="$REGION" --project="$PROJECT" \
    --image="$MIGRATE_IMAGE" --quiet
  gcloud run jobs execute db-migrate --region="$REGION" --project="$PROJECT" --wait
  ok "db-migrate complete"
fi

# ─── Deploy Services ─────────────────────────────────────────────────────────

log "Deploying services..."

# prod-mcp config pins (see LESSONS_LEARNED.md: "prod-mcp red dot from LB
# timeout + CPU throttling drift"). These MUST be re-asserted on every deploy
# so the service can't silently drift back to defaults:
#   --timeout=3600       Streamable HTTP SSE GET stream must outlive Cloud
#                        Run's default 300s LB cutoff (default would sever the
#                        notification stream every 5 min → Cursor red dot).
#   --no-cpu-throttling  CPU always-allocated on min instances so the Redis
#                        pub/sub subscription backing each session stays alive
#                        between requests (default throttling drops the sub →
#                        next request 404s "Session expired or not found").
if want mcp; then
  gcloud run services update prod-mcp --region="$REGION" --project="$PROJECT" \
    --image="$MCP_TAG" \
    --timeout=3600 \
    --no-cpu-throttling \
    --quiet
  ok "Deployed prod-mcp (${MCP_VER})"
fi

if want ctrl-api; then
  gcloud run services update prod-ctrl-api --region="$REGION" --project="$PROJECT" \
    --image="$API_TAG" --quiet
  ok "Deployed prod-ctrl-api (${API_VER})"
fi

if want ctrl; then
  gcloud run services update prod-ctrl --region="$REGION" --project="$PROJECT" \
    --image="$SPA_TAG" --quiet
  ok "Deployed prod-ctrl (${SPA_VER})"
fi

if want worker; then
  gcloud run jobs update prod-ingest-worker --region="$REGION" --project="$PROJECT" \
    --image="$WORKER_TAG" --quiet
  ok "Updated prod-ingest-worker (${WORKER_VER})"
fi

# ─── Verify ──────────────────────────────────────────────────────────────────

log ""
log "Verifying deployment..."

if want mcp; then
  PRM=$(curl -s "${DOMAIN}/.well-known/oauth-protected-resource/mcp" 2>/dev/null)
  if echo "$PRM" | grep -q "mcp.5pm.ai"; then
    ok "MCP server responding at ${DOMAIN}"
  else
    die "MCP server not responding correctly at ${DOMAIN}"
  fi
fi

if want ctrl; then
  BUNDLE_URL=$(curl -sL "${DOMAIN}/" 2>/dev/null | grep -oE 'src="[^"]*\.js"' | head -1 | sed 's/src="//;s/"//')
  if [[ -n "$BUNDLE_URL" ]]; then
    # BSD grep on macOS can false-negative on minified JS (treats bytes as binary).
    # Force locale + text mode so the verify never lies. See LESSONS_LEARNED 2026-04-16.
    BUNDLE=$(curl -sL "${DOMAIN}${BUNDLE_URL}" 2>/dev/null)
    bundle_has() { echo "$BUNDLE" | LC_ALL=C grep -a -q "$1"; }

    if bundle_has "$PROD_AUTH0_CLIENT_ID"; then
      ok "SPA Auth0 client_id: correct (prod)"
    else
      warn "SPA Auth0 client_id: MISMATCH — may have gamma values baked in!"
    fi

    if bundle_has "pk_live_"; then
      ok "SPA Stripe key: live mode"
    else
      warn "SPA Stripe key: NOT live — check VITE_STRIPE_PUBLISHABLE_KEY build arg!"
    fi

    if bundle_has "api.mcp.5pm.ai"; then
      ok "SPA Auth0 audience: correct (prod)"
    else
      warn "SPA Auth0 audience: MISMATCH — may have gamma values baked in!"
    fi

    if bundle_has "$PROD_GA_MEASUREMENT_ID"; then
      ok "SPA GA measurement ID: baked in (${PROD_GA_MEASUREMENT_ID})"
    else
      warn "SPA GA measurement ID: NOT found in bundle — check VITE_GA_MEASUREMENT_ID build arg!"
    fi
  fi
fi

log ""
ok "Production deployment complete!"
log ""
want mcp      && log "  mcp-server   : ${MCP_VER}"
want ctrl-api && log "  ctrl-api     : ${API_VER}"
want ctrl     && log "  ctrl-plane   : ${SPA_VER}"
want worker   && log "  ingest-worker: ${WORKER_VER}"
log ""
log "Next: run e2e tests (excluding billing/stripe)"
log "  cd $(dirname "$MCP_REPO")/labs-mcp-gamma && BASE_URI=${DOMAIN} npm run test:e2e:live"
log "  cd $(dirname "$MCP_REPO")/labs-saas-ctrl && npm run test:wizard  # (after patching .env for prod)"
