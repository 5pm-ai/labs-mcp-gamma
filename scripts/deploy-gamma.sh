#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-gamma.sh — Deploy labs-mcp-gamma + labs-saas-ctrl to gamma.5pm.ai
#
# Builds Docker images (linux/amd64), pushes to Artifact Registry,
# runs db-migrate, and updates all Cloud Run services/jobs.
#
# Usage:
#   ./scripts/deploy-gamma.sh [--skip-build] [--skip-migrate] [--dry-run]
#                             [--only <component>]...
#
# Components (repeatable via --only; default = all five):
#   mcp       : gamma-mcp Cloud Run Service (mcp-server image)
#   worker    : gamma-ingest-worker Cloud Run Job
#   ctrl-api  : gamma-ctrl-api Cloud Run Service
#   ctrl      : gamma-ctrl Cloud Run Service (SPA)
#   migrate   : db-migrate Cloud Run Job (applies both MCP + ctrl init.sql)
#
# Prerequisites:
#   1. gcloud authenticated (roles/owner on ai-5pm-labs)
#   2. Docker running with buildx support
#   3. Artifact Registry auth: gcloud auth configure-docker us-east4-docker.pkg.dev
#   4. `../labs-saas-ctrl` checked out alongside this repo (required for migrate
#      and ctrl-api / ctrl builds).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGION="us-east4"
PROJECT="ai-5pm-labs"
REGISTRY="us-east4-docker.pkg.dev/${PROJECT}/gamma-docker"
DOMAIN="https://gamma.5pm.ai"

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
    -h|--help)      head -20 "${BASH_SOURCE[0]}" | tail -18; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m[deploy-gamma]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy-gamma] ✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy-gamma] ✗\033[0m %s\n' "$*" >&2; exit 1; }

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

# Validate --only values
for c in ${ONLY_COMPONENTS[@]+"${ONLY_COMPONENTS[@]}"}; do
  valid=false
  for v in "${ALL_COMPONENTS[@]}"; do
    [[ "$c" == "$v" ]] && valid=true && break
  done
  $valid || die "--only $c is not a valid component (one of: ${ALL_COMPONENTS[*]})"
done

# ctrl repo is required whenever we build/deploy a ctrl component or run migrate
# (migrate needs ctrl's init.sql baked into the mcp image).
need_ctrl_repo=false
for t in ctrl-api ctrl migrate; do
  want "$t" && need_ctrl_repo=true
done
if $need_ctrl_repo && [[ -z "$CTRL_REPO" ]]; then
  die "labs-saas-ctrl not found at ../labs-saas-ctrl. Required for ctrl-api/ctrl/migrate."
fi

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

# Only fetch current versions for components we plan to touch, so a cherry-pick
# deploy doesn't error on unrelated service describes.
MCP_TAG=""; API_TAG=""; SPA_TAG=""; WORKER_TAG=""
MCP_VER=""; API_VER=""; SPA_VER=""; WORKER_VER=""

if want mcp || want migrate; then
  MCP_IMG=$(current_image service gamma-mcp)
  MCP_VER=$(next_version "$MCP_IMG")
  MCP_TAG="${REGISTRY}/mcp-server:${MCP_VER}"
fi
if want ctrl-api; then
  API_IMG=$(current_image service gamma-ctrl-api)
  API_VER=$(next_version "$API_IMG")
  API_TAG="${REGISTRY}/ctrl-api:${API_VER}"
fi
if want ctrl; then
  SPA_IMG=$(current_image service gamma-ctrl)
  SPA_VER=$(next_version "$SPA_IMG")
  SPA_TAG="${REGISTRY}/ctrl-plane:${SPA_VER}"
fi
if want worker; then
  WORKER_IMG=$(current_image job gamma-ingest-worker)
  WORKER_VER=$(next_version "$WORKER_IMG")
  WORKER_TAG="${REGISTRY}/ingest-worker:${WORKER_VER}"
fi

log "Deploy plan:"
if [[ ${#ONLY_COMPONENTS[@]} -gt 0 ]]; then
  log "  --only: ${ONLY_COMPONENTS[*]}"
fi
want mcp       && log "  mcp-server   : ${MCP_VER} → gamma-mcp"
want ctrl-api  && log "  ctrl-api     : ${API_VER} → gamma-ctrl-api"
want ctrl      && log "  ctrl-plane   : ${SPA_VER} → gamma-ctrl"
want worker    && log "  ingest-worker: ${WORKER_VER} → gamma-ingest-worker"
want migrate   && log "  db-migrate   : ${MCP_VER} image (applies mcp+ctrl init.sql)"
log ""

if $DRY_RUN; then
  log "[DRY-RUN] Would build, push, migrate, and deploy the above."
  exit 0
fi

# ─── Stage ctrl init.sql for inclusion in mcp-server image ───────────────────
# db-migrate runs from the mcp-server image. It applies db/init.sql (MCP schema)
# and db/ctrl-init.sql (ctrl schema) if present. We copy the ctrl repo's
# init.sql here just before build and remove it after. Kept out of git via
# .gitignore. See LESSONS_LEARNED 2026-04-21 for why this exists.
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

  # Stage ctrl SQL before any build that will be used as the db-migrate image.
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
    # Gamma SPA: Dockerfile defaults are gamma values, only need Stripe PK + env flag
    GAMMA_STRIPE_PK="pk_test_51T7k3DA7sFBrGISJ0eUSS2XYnlg8LhLV71cVqVOfCh6qXaAi2NFOYwxEUKnYXhMFl2MW5E1oOxGTvYcKk2jMwnoW00CiXoXjto"
    docker buildx build --platform linux/amd64 \
      --build-arg VITE_STRIPE_PUBLISHABLE_KEY="$GAMMA_STRIPE_PK" \
      --build-arg VITE_DEPLOYMENT_ENV=gamma \
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
  # Use the just-built mcp image if we have one; otherwise re-run the job at
  # its current image (operator explicitly passed --skip-build).
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

if want mcp; then
  gcloud run services update gamma-mcp --region="$REGION" --project="$PROJECT" \
    --image="$MCP_TAG" --quiet
  ok "Deployed gamma-mcp (${MCP_VER})"
fi

if want ctrl-api; then
  gcloud run services update gamma-ctrl-api --region="$REGION" --project="$PROJECT" \
    --image="$API_TAG" --quiet
  ok "Deployed gamma-ctrl-api (${API_VER})"
fi

if want ctrl; then
  gcloud run services update gamma-ctrl --region="$REGION" --project="$PROJECT" \
    --image="$SPA_TAG" --quiet
  ok "Deployed gamma-ctrl (${SPA_VER})"
fi

if want worker; then
  gcloud run jobs update gamma-ingest-worker --region="$REGION" --project="$PROJECT" \
    --image="$WORKER_TAG" --quiet
  ok "Updated gamma-ingest-worker (${WORKER_VER})"
fi

# ─── Verify ──────────────────────────────────────────────────────────────────

log ""
log "Verifying deployment..."

if want mcp; then
  PRM=$(curl -s "${DOMAIN}/.well-known/oauth-protected-resource/mcp" 2>/dev/null)
  if echo "$PRM" | grep -q "gamma.5pm.ai"; then
    ok "MCP server responding at ${DOMAIN}"
  else
    die "MCP server not responding correctly at ${DOMAIN}"
  fi
fi

log ""
ok "Gamma deployment complete!"
log ""
want mcp      && log "  mcp-server   : ${MCP_VER}"
want ctrl-api && log "  ctrl-api     : ${API_VER}"
want ctrl     && log "  ctrl-plane   : ${SPA_VER}"
want worker   && log "  ingest-worker: ${WORKER_VER}"
log ""
log "Next: run e2e tests"
log "  cd $(dirname "$MCP_REPO")/labs-mcp-gamma && BASE_URI=${DOMAIN} npm run test:int:live"
log "  cd $(dirname "$MCP_REPO")/labs-saas-ctrl && npm run test:all  # unit + int + e2e (or cherry-pick: test:int, test:e2e, test:int:wizard, ...)"
