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
#
# Prerequisites:
#   1. gcloud authenticated (roles/owner on ai-5pm-mcp)
#   2. Docker running with buildx support
#   3. Artifact Registry auth: gcloud auth configure-docker us-east4-docker.pkg.dev
#   4. Deploy to gamma first and run all e2e tests before deploying to prod
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGION="us-east4"
PROJECT="ai-5pm-mcp"
REGISTRY="us-east4-docker.pkg.dev/${PROJECT}/prod-docker"
DOMAIN="https://mcp.5pm.ai"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
CTRL_REPO="$(cd "$SCRIPT_DIR/../../labs-saas-ctrl" 2>/dev/null && pwd)" || true

SKIP_BUILD=false
SKIP_MIGRATE=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)   SKIP_BUILD=true; shift ;;
    --skip-migrate) SKIP_MIGRATE=true; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    -h|--help)      head -18 "${BASH_SOURCE[0]}" | tail -14; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;35m[deploy-prod]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy-prod] ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy-prod] ⚠\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy-prod] ✗\033[0m %s\n' "$*" >&2; exit 1; }

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

MCP_IMG=$(current_image service prod-mcp)
API_IMG=$(current_image service prod-ctrl-api)
SPA_IMG=$(current_image service prod-ctrl)
WORKER_IMG=$(current_image job prod-ingest-worker)

MCP_VER=$(next_version "$MCP_IMG")
API_VER=$(next_version "$API_IMG")
SPA_VER=$(next_version "$SPA_IMG")
WORKER_VER=$(next_version "$WORKER_IMG")

MCP_TAG="${REGISTRY}/mcp-server:${MCP_VER}"
API_TAG="${REGISTRY}/ctrl-api:${API_VER}"
SPA_TAG="${REGISTRY}/ctrl-plane:${SPA_VER}"
WORKER_TAG="${REGISTRY}/ingest-worker:${WORKER_VER}"

log "═══ PRODUCTION DEPLOYMENT ═══"
log ""
log "Deploy plan:"
log "  mcp-server   : ${MCP_VER} → prod-mcp"
log "  ctrl-api     : ${API_VER} → prod-ctrl-api"
log "  ctrl-plane   : ${SPA_VER} → prod-ctrl"
log "  ingest-worker: ${WORKER_VER} → prod-ingest-worker"
log ""
log "SPA build args (all explicit — no Dockerfile defaults used):"
log "  VITE_AUTH0_CLIENT_ID : ${PROD_AUTH0_CLIENT_ID}"
log "  VITE_AUTH0_AUDIENCE  : ${PROD_AUTH0_AUDIENCE}"
log "  VITE_APP_ORIGIN      : ${PROD_APP_ORIGIN}"
log "  VITE_STRIPE_PK       : ${PROD_STRIPE_PK:0:25}..."
log "  VITE_DEPLOYMENT_ENV  : ${PROD_DEPLOYMENT_ENV}"
log "  VITE_GA_MEASUREMENT_ID: ${PROD_GA_MEASUREMENT_ID}"
log ""

if $DRY_RUN; then
  log "[DRY-RUN] Would build, push, migrate, and deploy the above."
  exit 0
fi

read -r -p "[deploy-prod] Deploy to PRODUCTION? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || die "Aborted."

# ─── Build ────────────────────────────────────────────────────────────────────

if ! $SKIP_BUILD; then
  log "Building images (linux/amd64)..."

  [[ -d "$MCP_REPO" ]] || die "MCP repo not found: $MCP_REPO"
  [[ -d "$CTRL_REPO" ]] || die "ctrl repo not found: $CTRL_REPO"

  docker buildx build --platform linux/amd64 \
    -t "$MCP_TAG" -f "$MCP_REPO/Dockerfile" "$MCP_REPO"
  ok "Built $MCP_TAG"

  docker buildx build --platform linux/amd64 \
    -t "$WORKER_TAG" -f "$MCP_REPO/Dockerfile.worker" "$MCP_REPO"
  ok "Built $WORKER_TAG"

  docker buildx build --platform linux/amd64 \
    -t "$API_TAG" -f "$CTRL_REPO/Dockerfile.api" "$CTRL_REPO"
  ok "Built $API_TAG"

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

  # ─── Push ─────────────────────────────────────────────────────────────────

  log "Pushing images..."
  for tag in "$MCP_TAG" "$WORKER_TAG" "$API_TAG" "$SPA_TAG"; do
    docker push "$tag"
    ok "Pushed $tag"
  done
fi

# ─── DB Migrate ──────────────────────────────────────────────────────────────

if ! $SKIP_MIGRATE; then
  log "Running db-migrate..."
  gcloud run jobs update db-migrate --region="$REGION" --project="$PROJECT" \
    --image="$MCP_TAG" --quiet
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
gcloud run services update prod-mcp --region="$REGION" --project="$PROJECT" \
  --image="$MCP_TAG" \
  --timeout=3600 \
  --no-cpu-throttling \
  --quiet
ok "Deployed prod-mcp (${MCP_VER})"

gcloud run services update prod-ctrl-api --region="$REGION" --project="$PROJECT" \
  --image="$API_TAG" --quiet
ok "Deployed prod-ctrl-api (${API_VER})"

gcloud run services update prod-ctrl --region="$REGION" --project="$PROJECT" \
  --image="$SPA_TAG" --quiet
ok "Deployed prod-ctrl (${SPA_VER})"

gcloud run jobs update prod-ingest-worker --region="$REGION" --project="$PROJECT" \
  --image="$WORKER_TAG" --quiet
ok "Updated prod-ingest-worker (${WORKER_VER})"

# ─── Verify ──────────────────────────────────────────────────────────────────

log ""
log "Verifying deployment..."

PRM=$(curl -s "${DOMAIN}/.well-known/oauth-protected-resource/mcp" 2>/dev/null)
if echo "$PRM" | grep -q "mcp.5pm.ai"; then
  ok "MCP server responding at ${DOMAIN}"
else
  die "MCP server not responding correctly at ${DOMAIN}"
fi

BUNDLE_URL=$(curl -sL "${DOMAIN}/" 2>/dev/null | grep -oE 'src="[^"]*\.js"' | head -1 | sed 's/src="//;s/"//')
if [[ -n "$BUNDLE_URL" ]]; then
  BUNDLE=$(curl -sL "${DOMAIN}${BUNDLE_URL}" 2>/dev/null)

  if echo "$BUNDLE" | grep -q "$PROD_AUTH0_CLIENT_ID"; then
    ok "SPA Auth0 client_id: correct (prod)"
  else
    warn "SPA Auth0 client_id: MISMATCH — may have gamma values baked in!"
  fi

  if echo "$BUNDLE" | grep -q "pk_live_"; then
    ok "SPA Stripe key: live mode"
  else
    warn "SPA Stripe key: NOT live — check VITE_STRIPE_PUBLISHABLE_KEY build arg!"
  fi

  if echo "$BUNDLE" | grep -q "api.mcp.5pm.ai"; then
    ok "SPA Auth0 audience: correct (prod)"
  else
    warn "SPA Auth0 audience: MISMATCH — may have gamma values baked in!"
  fi

  if echo "$BUNDLE" | grep -q "$PROD_GA_MEASUREMENT_ID"; then
    ok "SPA GA measurement ID: baked in (${PROD_GA_MEASUREMENT_ID})"
  else
    warn "SPA GA measurement ID: NOT found in bundle — check VITE_GA_MEASUREMENT_ID build arg!"
  fi
fi

log ""
ok "Production deployment complete!"
log ""
log "  mcp-server   : ${MCP_VER}"
log "  ctrl-api     : ${API_VER}"
log "  ctrl-plane   : ${SPA_VER}"
log "  ingest-worker: ${WORKER_VER}"
log ""
log "Next: run e2e tests (excluding billing/stripe)"
log "  cd $(dirname "$MCP_REPO")/labs-mcp-gamma && BASE_URI=${DOMAIN} npm run test:e2e:live"
log "  cd $(dirname "$MCP_REPO")/labs-saas-ctrl && npm run test:wizard  # (after patching .env for prod)"
