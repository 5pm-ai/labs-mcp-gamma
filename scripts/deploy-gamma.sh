#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-gamma.sh — Deploy labs-mcp-gamma + labs-saas-ctrl to gamma.5pm.ai
#
# Builds Docker images (linux/amd64), pushes to Artifact Registry,
# runs db-migrate, and updates all Cloud Run services/jobs.
#
# Usage:
#   ./scripts/deploy-gamma.sh [--skip-build] [--skip-migrate] [--dry-run]
#
# Prerequisites:
#   1. gcloud authenticated (roles/owner on ai-5pm-labs)
#   2. Docker running with buildx support
#   3. Artifact Registry auth: gcloud auth configure-docker us-east4-docker.pkg.dev
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGION="us-east4"
PROJECT="ai-5pm-labs"
REGISTRY="us-east4-docker.pkg.dev/${PROJECT}/gamma-docker"
DOMAIN="https://gamma.5pm.ai"

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
    -h|--help)      head -15 "${BASH_SOURCE[0]}" | tail -10; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m[deploy-gamma]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy-gamma] ✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy-gamma] ✗\033[0m %s\n' "$*" >&2; exit 1; }

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

MCP_IMG=$(current_image service gamma-mcp)
API_IMG=$(current_image service gamma-ctrl-api)
SPA_IMG=$(current_image service gamma-ctrl)
WORKER_IMG=$(current_image job gamma-ingest-worker)

MCP_VER=$(next_version "$MCP_IMG")
API_VER=$(next_version "$API_IMG")
SPA_VER=$(next_version "$SPA_IMG")
WORKER_VER=$(next_version "$WORKER_IMG")

MCP_TAG="${REGISTRY}/mcp-server:${MCP_VER}"
API_TAG="${REGISTRY}/ctrl-api:${API_VER}"
SPA_TAG="${REGISTRY}/ctrl-plane:${SPA_VER}"
WORKER_TAG="${REGISTRY}/ingest-worker:${WORKER_VER}"

log "Deploy plan:"
log "  mcp-server   : ${MCP_VER} → gamma-mcp"
log "  ctrl-api     : ${API_VER} → gamma-ctrl-api"
log "  ctrl-plane   : ${SPA_VER} → gamma-ctrl"
log "  ingest-worker: ${WORKER_VER} → gamma-ingest-worker"
log ""

if $DRY_RUN; then
  log "[DRY-RUN] Would build, push, migrate, and deploy the above."
  exit 0
fi

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

  # Gamma SPA: Dockerfile defaults are gamma values, only need Stripe PK + env flag
  GAMMA_STRIPE_PK="pk_test_51T7k3DA7sFBrGISJ0eUSS2XYnlg8LhLV71cVqVOfCh6qXaAi2NFOYwxEUKnYXhMFl2MW5E1oOxGTvYcKk2jMwnoW00CiXoXjto"
  docker buildx build --platform linux/amd64 \
    --build-arg VITE_STRIPE_PUBLISHABLE_KEY="$GAMMA_STRIPE_PK" \
    --build-arg VITE_DEPLOYMENT_ENV=gamma \
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

gcloud run services update gamma-mcp --region="$REGION" --project="$PROJECT" \
  --image="$MCP_TAG" --quiet
ok "Deployed gamma-mcp (${MCP_VER})"

gcloud run services update gamma-ctrl-api --region="$REGION" --project="$PROJECT" \
  --image="$API_TAG" --quiet
ok "Deployed gamma-ctrl-api (${API_VER})"

gcloud run services update gamma-ctrl --region="$REGION" --project="$PROJECT" \
  --image="$SPA_TAG" --quiet
ok "Deployed gamma-ctrl (${SPA_VER})"

gcloud run jobs update gamma-ingest-worker --region="$REGION" --project="$PROJECT" \
  --image="$WORKER_TAG" --quiet
ok "Updated gamma-ingest-worker (${WORKER_VER})"

# ─── Verify ──────────────────────────────────────────────────────────────────

log ""
log "Verifying deployment..."

PRM=$(curl -s "${DOMAIN}/.well-known/oauth-protected-resource/mcp" 2>/dev/null)
if echo "$PRM" | grep -q "gamma.5pm.ai"; then
  ok "MCP server responding at ${DOMAIN}"
else
  die "MCP server not responding correctly at ${DOMAIN}"
fi

log ""
ok "Gamma deployment complete!"
log ""
log "  mcp-server   : ${MCP_VER}"
log "  ctrl-api     : ${API_VER}"
log "  ctrl-plane   : ${SPA_VER}"
log "  ingest-worker: ${WORKER_VER}"
log ""
log "Next: run e2e tests"
log "  cd $(dirname "$MCP_REPO")/labs-mcp-gamma && BASE_URI=${DOMAIN} npm run test:e2e:live"
log "  cd $(dirname "$MCP_REPO")/labs-saas-ctrl && npm run test:all  # (after patching .env for gamma)"
