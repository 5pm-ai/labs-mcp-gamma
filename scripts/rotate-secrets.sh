#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rotate-secrets.sh — Idempotent secret rotation for labs-mcp-gamma + labs-saas-ctrl
#
# Reads .env files, compares with GCP Secret Manager, pushes changed secrets,
# and redeploys affected Cloud Run services/jobs.
#
# Usage:
#   ./scripts/rotate-secrets.sh [--dry-run] [--validate] [--skip-deploy]
#
# Prerequisites:
#   1. gcloud authenticated (roles/owner on ai-5pm-labs)
#   2. Upstream rotation done (Auth0/Stripe/Postmark/OpenAI dashboards)
#   3. For DB passwords: ALTER ROLE via bastion BEFORE running this
#   4. .env files updated with new PRODUCTION values
#
# See scripts/ROTATE_SECRETS.md for the full runbook.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ─── Constants ────────────────────────────────────────────────────────────────

REGION="us-east4"
PROJECT="ai-5pm-labs"
REGISTRY="us-east4-docker.pkg.dev/${PROJECT}/gamma-docker"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_REPO="${MCP_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"

if [[ -z "${CTRL_REPO:-}" ]]; then
  _candidate="$SCRIPT_DIR/../../labs-saas-ctrl"
  if [[ -d "$_candidate" ]]; then
    CTRL_REPO="$(cd "$_candidate" && pwd)"
  else
    CTRL_REPO=""
  fi
fi

MCP_ENV="${MCP_REPO}/.env"
CTRL_ENV="${CTRL_REPO:+${CTRL_REPO}/.env}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log()  { printf '[rotate] %s\n' "$*"; }
warn() { printf '[rotate] ⚠  %s\n' "$*" >&2; }
die()  { printf '[rotate] ✗  %s\n' "$*" >&2; exit 1; }
ok()   { printf '[rotate] ✓  %s\n' "$*"; }

env_file_for() {
  if [[ "$1" == "mcp" ]]; then
    echo "$MCP_ENV"
  elif [[ "$1" == "ctrl" ]]; then
    [[ -n "${CTRL_ENV:-}" ]] || die "ctrl repo not found. Set CTRL_REPO env var."
    echo "$CTRL_ENV"
  else
    die "Unknown repo: $1"
  fi
}

get_env_value() {
  local file="$1" key="$2"
  local line value
  line=$(grep -E "^${key}=" "$file" 2>/dev/null | head -1) || return 1
  value="${line#"${key}="}"
  if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

get_secret_latest() {
  gcloud secrets versions access latest \
    --secret="$1" --project="$PROJECT" 2>/dev/null || return 1
}

secret_exists() {
  gcloud secrets describe "$1" --project="$PROJECT" &>/dev/null
}

looks_local() {
  local v="$1"
  [[ "$v" == *localhost* || "$v" == *127.0.0.1* || \
     "$v" == *mcp_dev_password* || "$v" == *ctrl_dev_password* || \
     "$v" == *ingest_dev_password* ]]
}

is_db_secret() {
  case "$1" in
    database-url|ctrl-database-url|ingest-database-url|database-admin-url) return 0 ;;
    *) return 1 ;;
  esac
}

# ─── Secret Mapping (verified against live Cloud Run service configs) ─────────
# Format: SECRET_NAME|SOURCE_REPO|ENV_VAR|AFFECTED_SERVICES
#   SOURCE_REPO: mcp or ctrl (which .env is the canonical source)
#   AFFECTED_SERVICES: comma-separated; :job suffix for Cloud Run Jobs
#
# Excluded: redis-tls-ca (Memorystore-managed cert, not sourced from .env)

SECRETS=(
  "auth0-client-secret|mcp|AUTH0_CLIENT_SECRET|gamma-mcp"
  "database-url|mcp|DATABASE_URL|gamma-mcp"
  "openai-api-key|mcp|OPENAI_API_KEY|gamma-mcp,gamma-ctrl-api,gamma-ingest-worker:job"
  "ingest-database-url|mcp|INGEST_DATABASE_URL|gamma-ingest-worker:job"
  "ctrl-database-url|ctrl|DATABASE_URL|gamma-ctrl-api"
  "database-admin-url|ctrl|DATABASE_ADMIN_URL|db-migrate:job"
  "stripe-secret-key|ctrl|STRIPE_SECRET_KEY|gamma-ctrl-api"
  "stripe-webhook-secret|ctrl|STRIPE_WEBHOOK_SECRET|gamma-ctrl-api"
  "postmark-server-token|ctrl|POSTMARK_SERVER_TOKEN|gamma-ctrl-api"
)

CROSS_VALIDATE_VARS=("OPENAI_API_KEY" "INGEST_DATABASE_URL")

# ─── Flags ────────────────────────────────────────────────────────────────────

DRY_RUN=false
VALIDATE_ONLY=false
SKIP_DEPLOY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      DRY_RUN=true; shift ;;
    --validate)     VALIDATE_ONLY=true; shift ;;
    --skip-deploy)  SKIP_DEPLOY=true; shift ;;
    -h|--help)
      awk '/^# ─────/{if(n++)exit}n{sub(/^# ?/,"");print}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) die "Unknown flag: $1" ;;
  esac
done

# ─── Validate ─────────────────────────────────────────────────────────────────

validate() {
  log "Validating configuration..."
  local errors=0

  [[ -f "$MCP_ENV" ]] || { warn "MCP .env not found: $MCP_ENV"; ((errors++)); }

  if [[ -n "${CTRL_ENV:-}" ]]; then
    [[ -f "$CTRL_ENV" ]] || { warn "Ctrl .env not found: $CTRL_ENV"; ((errors++)); }
  else
    warn "labs-saas-ctrl not found. Ctrl secrets will be skipped."
    warn "Set CTRL_REPO to include them."
  fi

  gcloud auth print-access-token --project="$PROJECT" &>/dev/null \
    || { warn "gcloud not authenticated for project $PROJECT"; ((errors++)); }

  for entry in "${SECRETS[@]}"; do
    IFS='|' read -r secret_name repo env_var _svc <<< "$entry"
    [[ "$repo" == "ctrl" && -z "${CTRL_ENV:-}" ]] && continue
    secret_exists "$secret_name" \
      || { warn "Secret not in Secret Manager: $secret_name"; ((errors++)); }
    local file
    file=$(env_file_for "$repo")
    grep -qE "^${env_var}=" "$file" 2>/dev/null \
      || { warn "$env_var not found in $file"; ((errors++)); }
  done

  (( errors == 0 )) || die "Validation failed with ${errors} error(s)."
  ok "Configuration valid"
}

# ─── Cross-repo consistency check ────────────────────────────────────────────

cross_validate() {
  [[ -n "${CTRL_ENV:-}" && -f "${CTRL_ENV:-/dev/null}" ]] || return 0
  local var mcp_val ctrl_val
  for var in "${CROSS_VALIDATE_VARS[@]}"; do
    mcp_val=$(get_env_value "$MCP_ENV" "$var" 2>/dev/null)  || continue
    ctrl_val=$(get_env_value "$CTRL_ENV" "$var" 2>/dev/null) || continue
    if [[ "$mcp_val" != "$ctrl_val" ]]; then
      warn "$var differs between repos — ensure both .env files have the same value."
    fi
  done
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  log "rotate-secrets — idempotent secret rotation"
  log ""

  validate
  if $VALIDATE_ONLY; then exit 0; fi

  cross_validate

  # ── Phase 1: Compare ────────────────────────────────────────────────────

  log ""
  log "Comparing .env values with Secret Manager..."

  changed=()
  affected_svcs=()
  db_changed=()
  refused=()

  for entry in "${SECRETS[@]}"; do
    IFS='|' read -r secret_name repo env_var services <<< "$entry"
    [[ "$repo" == "ctrl" && -z "${CTRL_ENV:-}" ]] && continue

    local file new_val current_val
    file=$(env_file_for "$repo")
    new_val=$(get_env_value "$file" "$env_var") \
      || die "Cannot read $env_var from $file"
    current_val=$(get_secret_latest "$secret_name") \
      || die "Cannot read secret: $secret_name"

    if [[ "$new_val" == "$current_val" ]]; then
      log "  ─ $secret_name (unchanged)"
      continue
    fi

    if is_db_secret "$secret_name" && looks_local "$new_val"; then
      warn "  ✗ $secret_name — looks like a local dev URL, refusing to push."
      warn "    Put the PRODUCTION connection string in $file and re-run."
      refused+=("$secret_name")
      continue
    fi

    log "  △ $secret_name (CHANGED, source: ${repo}/${env_var})"
    changed+=("$entry")

    IFS=',' read -ra svc_list <<< "$services"
    affected_svcs+=("${svc_list[@]}")

    is_db_secret "$secret_name" && db_changed+=("$secret_name")
  done

  # ── Summary ─────────────────────────────────────────────────────────────

  log ""

  if (( ${#refused[@]} > 0 )); then
    warn "${#refused[@]} secret(s) refused (local dev values). See warnings above."
  fi

  if (( ${#changed[@]} == 0 )); then
    ok "No changes to push. All production secrets match."
    exit 0
  fi

  log "Summary: ${#changed[@]} secret(s) to push"
  for entry in "${changed[@]}"; do
    IFS='|' read -r sn _ _ _ <<< "$entry"
    log "  • $sn"
  done

  unique_svcs_str=$(printf '%s\n' "${affected_svcs[@]}" | sort -u)
  unique_svcs=()
  while IFS= read -r svc; do
    [[ -n "$svc" ]] && unique_svcs+=("$svc")
  done <<< "$unique_svcs_str"

  if ! $SKIP_DEPLOY && (( ${#unique_svcs[@]} > 0 )); then
    log ""
    log "Services to redeploy:"
    for svc in "${unique_svcs[@]}"; do log "  • $svc"; done
  fi

  if (( ${#db_changed[@]} > 0 )); then
    log ""
    warn "DB connection strings changed: ${db_changed[*]}"
    warn "Ensure ALTER ROLE was run on Cloud SQL via bastion BEFORE proceeding."
  fi

  if $DRY_RUN; then
    log ""
    log "[DRY-RUN] No changes made."
    exit 0
  fi

  log ""
  read -r -p "[rotate] Proceed? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || die "Aborted."

  # ── Phase 2: Push secrets ───────────────────────────────────────────────

  log ""
  log "Pushing ${#changed[@]} secret(s) to Secret Manager..."

  pushed=()
  for entry in "${changed[@]}"; do
    IFS='|' read -r secret_name repo env_var _svc <<< "$entry"

    local skip=false
    for p in "${pushed[@]+"${pushed[@]}"}"; do
      [[ "$p" == "$secret_name" ]] && { skip=true; break; }
    done
    $skip && { log "  ─ $secret_name (already pushed)"; continue; }

    local file new_val
    file=$(env_file_for "$repo")
    new_val=$(get_env_value "$file" "$env_var")

    printf '%s' "$new_val" | gcloud secrets versions add "$secret_name" \
      --project="$PROJECT" --data-file=- --quiet >/dev/null
    ok "Pushed: $secret_name"
    pushed+=("$secret_name")
  done

  # ── Phase 3: Redeploy ──────────────────────────────────────────────────

  if $SKIP_DEPLOY; then
    log ""
    warn "--skip-deploy set. Remember to deploy manually."
  elif (( ${#unique_svcs[@]} > 0 )); then
    log ""
    log "Redeploying ${#unique_svcs[@]} service(s)/job(s)..."

    local ts
    ts=$(date +%s)

    for svc in "${unique_svcs[@]}"; do
      local svc_name="${svc%%:*}"
      local svc_type="${svc##*:}"
      [[ "$svc_type" == "$svc_name" ]] && svc_type="svc"

      if [[ "$svc_type" == "job" ]]; then
        gcloud run jobs update "$svc_name" \
          --region="$REGION" --project="$PROJECT" \
          --update-env-vars="_ROTATE_TS=$ts" --quiet >/dev/null
      else
        gcloud run services update "$svc_name" \
          --region="$REGION" --project="$PROJECT" \
          --update-env-vars="_ROTATE_TS=$ts" --quiet >/dev/null
      fi
      ok "Redeployed: $svc_name ($svc_type)"
    done
  fi

  # ── Done ────────────────────────────────────────────────────────────────

  log ""
  ok "Rotation complete. ${#pushed[@]} secret(s) pushed, ${#unique_svcs[@]} target(s) redeployed."
  log ""
  log "Post-rotation checklist:"
  log "  1. Verify health: curl -sI https://gamma.5pm.ai/health"
  log "  2. Restore local dev values in .env if you changed DB URLs"
  log "  3. Test an MCP connection (Cursor / Inspector)"
}

main
