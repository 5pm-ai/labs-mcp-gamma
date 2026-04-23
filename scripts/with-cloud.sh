#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# with-cloud.sh — Run a command against gamma or prod with cloud DB creds
# injected into the subprocess environment. Opens an IAP tunnel, executes the
# command, tears the tunnel down on exit. Never touches .env.
#
# Usage:
#   ./scripts/with-cloud.sh <gamma|prod> [--port N] [--dry-run] -- <command...>
#
# Examples:
#   cd ../labs-saas-ctrl
#   ../labs-mcp-gamma/scripts/with-cloud.sh gamma -- npm run test:e2e
#   ../labs-mcp-gamma/scripts/with-cloud.sh prod  -- npm run test:int:wizard
#   ../labs-mcp-gamma/scripts/with-cloud.sh gamma --port 5444 -- npm test
#   ../labs-mcp-gamma/scripts/with-cloud.sh gamma --dry-run -- npm run test:e2e
#
# The `--` separator is optional but recommended when the command has flags.
#
# Env vars injected into the child process (only):
#   DATABASE_ADMIN_URL   postgres/superuser, via tunnel
#   DATABASE_CTRL_URL    ctrl_app, via tunnel
#   DATABASE_URL         ctrl_app (same as DATABASE_CTRL_URL)
#   INGEST_DATABASE_URL  ingest_app, via tunnel
#   TEST_API_BASE_URL    https://gamma.5pm.ai | https://mcp.5pm.ai
#   TEST_MCP_BASE_URL    same as TEST_API_BASE_URL
#   TEST_SPA_BASE_URL    same as TEST_API_BASE_URL (Playwright baseURL so
#                        browser tests hit the deployed SPA in the same env
#                        the DB / API point at — avoids UI-vs-DB split)
#   AUTH0_AUDIENCE       api.gamma.5pm.ai | api.mcp.5pm.ai
#
# Prerequisites:
#   - gcloud authenticated (roles/owner or equivalent on the target project).
#   - Secret Manager accessor for database-admin-url, ctrl-database-url,
#     ingest-database-url in the target project.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1;36m[with-cloud]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m[with-cloud] ✓\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[with-cloud] ⚠\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[with-cloud] ✗\033[0m %s\n' "$*" >&2; exit 1; }

# ─── Parse args ──────────────────────────────────────────────────────────────

TARGET="${1:-}"; shift || true
case "$TARGET" in
  gamma|prod) ;;
  ""|-h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  *) die "unknown target '$TARGET' (expected: gamma|prod)" ;;
esac

PORT=""
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --) shift; break ;;
    -*) die "unknown flag: $1" ;;
    *) break ;;
  esac
done

# Remaining args form the command.
if ! $DRY_RUN; then
  [[ $# -gt 0 ]] || die "no command specified. usage: with-cloud.sh <gamma|prod> [--port N] -- <command...>"
fi

# ─── Target config ───────────────────────────────────────────────────────────

case "$TARGET" in
  gamma)
    PROJECT="ai-5pm-labs"
    BASTION="gamma-bastion"
    ZONE="us-east4-a"
    DEFAULT_PORT=5434
    BASE_URL="https://gamma.5pm.ai"
    AUDIENCE="https://api.gamma.5pm.ai"
    ;;
  prod)
    PROJECT="ai-5pm-mcp"
    BASTION="prod-bastion"
    ZONE="us-east4-a"
    DEFAULT_PORT=5435
    BASE_URL="https://mcp.5pm.ai"
    AUDIENCE="https://api.mcp.5pm.ai"
    ;;
esac

PORT="${PORT:-$DEFAULT_PORT}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number, got '$PORT'"
(( PORT > 0 && PORT < 65536 )) || die "--port out of range: $PORT"

# ─── Helpers ─────────────────────────────────────────────────────────────────

port_listening() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN -P -n >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- && exec 3>&-
  fi
}

wait_for_port() {
  local port="$1" deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    port_listening "$port" && return 0
    sleep 0.5
  done
  return 1
}

# Rewrite a cloud Postgres URL to point at the local tunnel port.
# - Swap @HOST:PORT → @127.0.0.1:<local_port>
# - Drop sslmode=... (tunnel is plaintext localhost; pg v8+ treats
#   require/verify-ca as verify-full and bails without a CA)
rewrite_url_for_tunnel() {
  local url="$1" local_port="$2"
  printf '%s' "$url" | sed -E \
    -e "s#@[^/@]+:[0-9]+/#@127.0.0.1:${local_port}/#" \
    -e 's#([?&])sslmode=[^&]*(&|$)#\1\2#' \
    -e 's#[?&]$##' \
    -e 's#\?&#?#'
}

fetch_secret() {
  local name="$1"
  gcloud secrets versions access latest --secret="$name" --project="$PROJECT" 2>/dev/null \
    || die "failed to read secret '$name' from project '$PROJECT' (gcloud auth? IAM?)"
}

# ─── Plan ────────────────────────────────────────────────────────────────────

log "target  : $TARGET ($PROJECT, bastion=$BASTION)"
log "tunnel  : localhost:$PORT → 10.20.0.3:5432"
log "API base: $BASE_URL"
if $DRY_RUN; then
  log "[DRY-RUN] would fetch 3 DB secrets, open IAP tunnel, exec: $*"
  exit 0
fi

# ─── Preflight ───────────────────────────────────────────────────────────────

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI not found"

if port_listening "$PORT"; then
  die "port $PORT is already in use. Use --port <N> for a different one, or close the existing process."
fi

# ─── Fetch secrets (in memory only) ──────────────────────────────────────────

log "fetching DB URL secrets from Secret Manager..."
ADMIN_URL="$(fetch_secret database-admin-url)"
CTRL_URL="$(fetch_secret ctrl-database-url)"
INGEST_URL="$(fetch_secret ingest-database-url)"
ok "fetched 3 DB secrets (values redacted)"

ADMIN_LOCAL="$(rewrite_url_for_tunnel "$ADMIN_URL" "$PORT")"
CTRL_LOCAL="$(rewrite_url_for_tunnel "$CTRL_URL" "$PORT")"
INGEST_LOCAL="$(rewrite_url_for_tunnel "$INGEST_URL" "$PORT")"

for u in "$ADMIN_LOCAL" "$CTRL_LOCAL" "$INGEST_LOCAL"; do
  [[ "$u" == *"@127.0.0.1:$PORT/"* ]] || die "URL rewrite sanity check failed"
done

# Clear source URLs from environment early; we only need the rewritten locals.
unset ADMIN_URL CTRL_URL INGEST_URL

# ─── Open IAP tunnel ─────────────────────────────────────────────────────────

TUNNEL_LOG="$SCRIPT_DIR/.tunnel-$TARGET.log"
: > "$TUNNEL_LOG"

cleanup() {
  local code=$?
  if [[ -n "${TUNNEL_PID:-}" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    # Give ssh a moment to exit cleanly, then force.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$TUNNEL_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

log "opening IAP tunnel via $BASTION..."
gcloud compute ssh "$BASTION" \
  --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap \
  -- -N -L "${PORT}:10.20.0.3:5432" \
  -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

if ! wait_for_port "$PORT"; then
  warn "tunnel did not start listening on port $PORT within 30s"
  warn "tail of $TUNNEL_LOG:"
  tail -20 "$TUNNEL_LOG" >&2 || true
  exit 1
fi
ok "tunnel up (pid=$TUNNEL_PID, port=$PORT)"

# ─── Run the command with env injected ───────────────────────────────────────

log "running: $*"
echo "" >&2

set +e
env \
  DATABASE_ADMIN_URL="$ADMIN_LOCAL" \
  DATABASE_CTRL_URL="$CTRL_LOCAL" \
  DATABASE_URL="$CTRL_LOCAL" \
  INGEST_DATABASE_URL="$INGEST_LOCAL" \
  TEST_API_BASE_URL="$BASE_URL" \
  TEST_MCP_BASE_URL="$BASE_URL" \
  TEST_SPA_BASE_URL="$BASE_URL" \
  AUTH0_AUDIENCE="$AUDIENCE" \
  "$@"
CMD_EXIT=$?
set -e

echo "" >&2
if (( CMD_EXIT == 0 )); then
  ok "command exited 0"
else
  warn "command exited $CMD_EXIT"
fi

exit "$CMD_EXIT"
