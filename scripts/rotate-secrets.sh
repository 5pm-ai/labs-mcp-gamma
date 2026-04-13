#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rotate-secrets.sh — Idempotent secret rotation for labs-mcp-gamma + labs-saas-ctrl
#
# Reads .env files, compares with GCP Secret Manager, pushes changed secrets,
# and redeploys affected Cloud Run services/jobs.
#
# Usage:
#   ./scripts/rotate-secrets.sh [--target gamma|prod|all] [--dry-run] [--validate]
#                               [--skip-deploy] [--check-build-args]
#
# Prerequisites:
#   1. gcloud authenticated (roles/owner on target project)
#   2. Upstream rotation done (Auth0/Stripe/Postmark/OpenAI dashboards)
#   3. For DB passwords: ALTER ROLE via bastion BEFORE running this
#   4. .env files updated with new PRODUCTION values for the target
#
# See scripts/ROTATE_SECRETS.md for the full runbook.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ─── Constants ────────────────────────────────────────────────────────────────

REGION="us-east4"

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

# ─── Target Configurations ────────────────────────────────────────────────────

gamma_project()  { echo "ai-5pm-labs"; }
gamma_registry() { echo "us-east4-docker.pkg.dev/ai-5pm-labs/gamma-docker"; }
gamma_url()      { echo "https://gamma.5pm.ai"; }

gamma_secrets() {
  cat <<'GAMMA_EOF'
auth0-client-secret|mcp|AUTH0_CLIENT_SECRET|gamma-mcp
database-url|mcp|DATABASE_URL|gamma-mcp
openai-api-key|mcp|OPENAI_API_KEY|gamma-mcp,gamma-ctrl-api,gamma-ingest-worker:job
ingest-database-url|mcp|INGEST_DATABASE_URL|gamma-ingest-worker:job
ctrl-database-url|ctrl|DATABASE_URL|gamma-ctrl-api
database-admin-url|ctrl|DATABASE_ADMIN_URL|db-migrate:job
stripe-secret-key|ctrl|STRIPE_SECRET_KEY|gamma-ctrl-api
stripe-webhook-secret|ctrl|STRIPE_WEBHOOK_SECRET|gamma-ctrl-api
postmark-server-token|ctrl|POSTMARK_SERVER_TOKEN|gamma-ctrl-api
GAMMA_EOF
}

gamma_build_args() {
  cat <<'GAMMA_BA_EOF'
VITE_AUTH0_CLIENT_ID|nEejna8VWdHg3GR56DK9pbG6lj828yYg
VITE_AUTH0_AUDIENCE|api.gamma.5pm.ai
GAMMA_BA_EOF
}

prod_project()  { echo "ai-5pm-mcp"; }
prod_registry() { echo "us-east4-docker.pkg.dev/ai-5pm-mcp/prod-docker"; }
prod_url()      { echo "https://mcp.5pm.ai"; }

prod_secrets() {
  cat <<'PROD_EOF'
auth0-client-secret|mcp|AUTH0_CLIENT_SECRET|prod-mcp
database-url|mcp|DATABASE_URL|prod-mcp
openai-api-key|mcp|OPENAI_API_KEY|prod-mcp,prod-ctrl-api,prod-ingest-worker:job
ingest-database-url|mcp|INGEST_DATABASE_URL|prod-ingest-worker:job
ctrl-database-url|ctrl|DATABASE_URL|prod-ctrl-api
database-admin-url|ctrl|DATABASE_ADMIN_URL|db-migrate:job
stripe-secret-key|ctrl|STRIPE_SECRET_KEY|prod-ctrl-api
stripe-webhook-secret|ctrl|STRIPE_WEBHOOK_SECRET|prod-ctrl-api
postmark-server-token|ctrl|POSTMARK_SERVER_TOKEN|prod-ctrl-api
PROD_EOF
}

prod_build_args() {
  cat <<'PROD_BA_EOF'
VITE_AUTH0_CLIENT_ID|nsflJdrV8RsRoc6qarMWjl934jZkZkt0
VITE_AUTH0_AUDIENCE|api.mcp.5pm.ai
PROD_BA_EOF
}

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
    --secret="$1" --project="$CUR_PROJECT" 2>/dev/null || return 1
}

secret_exists() {
  gcloud secrets describe "$1" --project="$CUR_PROJECT" &>/dev/null
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

CROSS_VALIDATE_VARS=("OPENAI_API_KEY" "INGEST_DATABASE_URL")

# ─── Flags ────────────────────────────────────────────────────────────────────

DRY_RUN=false
VALIDATE_ONLY=false
SKIP_DEPLOY=false
CHECK_BUILD_ARGS=false
TARGET="gamma"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ -n "${2:-}" ]] || die "--target requires gamma|prod|all"
      TARGET="$2"; shift 2 ;;
    --dry-run)           DRY_RUN=true; shift ;;
    --validate)          VALIDATE_ONLY=true; shift ;;
    --skip-deploy)       SKIP_DEPLOY=true; shift ;;
    --check-build-args)  CHECK_BUILD_ARGS=true; shift ;;
    -h|--help)
      awk '/^# ─────/{if(n++)exit}n{sub(/^# ?/,"");print}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) die "Unknown flag: $1" ;;
  esac
done

case "$TARGET" in
  gamma|prod|all) ;;
  *) die "Invalid target: $TARGET (must be gamma|prod|all)" ;;
esac

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

  gcloud auth print-access-token --project="$CUR_PROJECT" &>/dev/null \
    || { warn "gcloud not authenticated for project $CUR_PROJECT"; ((errors++)); }

  for entry in "${CUR_SECRETS[@]}"; do
    IFS='|' read -r secret_name repo env_var _svc <<< "$entry"
    [[ "$repo" == "ctrl" && -z "${CTRL_ENV:-}" ]] && continue
    secret_exists "$secret_name" \
      || { warn "Secret not in Secret Manager ($CUR_PROJECT): $secret_name"; ((errors++)); }
    local file
    file=$(env_file_for "$repo")
    grep -qE "^${env_var}=" "$file" 2>/dev/null \
      || { warn "$env_var not found in $file"; ((errors++)); }
  done

  (( errors == 0 )) || die "Validation failed with ${errors} error(s)."
  ok "Configuration valid ($CUR_TARGET)"
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

# ─── Build-time arg validation ────────────────────────────────────────────────

check_build_args() {
  log "Checking build-time args for $CUR_TARGET ($CUR_URL)..."
  local errors=0

  local index_js
  index_js=$(curl -sL "$CUR_URL/" 2>/dev/null \
    | grep -oE 'src="[^"]*\.js"' | head -1 | sed 's/src="//;s/"//') || true

  if [[ -z "$index_js" ]]; then
    warn "Could not fetch SPA index from $CUR_URL — skipping build-arg check."
    return 0
  fi

  local bundle_url="${CUR_URL}${index_js}"

  while IFS='|' read -r arg_name expected_val; do
    [[ -z "$arg_name" ]] && continue
    if [[ $(curl -sL "$bundle_url" 2>/dev/null | grep -coF "$expected_val") -gt 0 ]]; then
      ok "  $arg_name: $expected_val (found)"
    else
      warn "  $arg_name: expected '$expected_val' — NOT FOUND in SPA bundle!"
      warn "  The SPA image may need rebuilding with --build-arg $arg_name"
      ((errors++))
    fi
  done < <("${CUR_TARGET}_build_args")

  if (( errors > 0 )); then
    warn "$errors build-time arg mismatch(es) detected for $CUR_TARGET."
    warn "Rebuild the ctrl-plane image with correct --build-arg values."
  else
    ok "All build-time args correct ($CUR_TARGET)"
  fi
  return $errors
}

# ─── Run rotation for a single target ─────────────────────────────────────────

run_target() {
  CUR_TARGET="$1"
  CUR_PROJECT=$("${CUR_TARGET}_project")
  CUR_REGISTRY=$("${CUR_TARGET}_registry")
  CUR_URL=$("${CUR_TARGET}_url")

  CUR_SECRETS=()
  while IFS= read -r _line; do
    [[ -n "$_line" ]] && CUR_SECRETS+=("$_line")
  done < <("${CUR_TARGET}_secrets")

  log "═══ Target: $CUR_TARGET (project: $CUR_PROJECT) ═══"
  log ""

  if $CHECK_BUILD_ARGS; then
    check_build_args || true
    log ""
  fi

  validate
  if $VALIDATE_ONLY; then return 0; fi

  cross_validate

  # ── Phase 1: Compare ────────────────────────────────────────────────────

  log ""
  log "Comparing .env values with Secret Manager ($CUR_PROJECT)..."

  changed=()
  affected_svcs=()
  db_changed=()
  refused=()

  for entry in "${CUR_SECRETS[@]}"; do
    IFS='|' read -r secret_name repo env_var services <<< "$entry"
    [[ "$repo" == "ctrl" && -z "${CTRL_ENV:-}" ]] && continue

    local file new_val current_val
    file=$(env_file_for "$repo")
    new_val=$(get_env_value "$file" "$env_var") \
      || die "Cannot read $env_var from $file"
    current_val=$(get_secret_latest "$secret_name") \
      || die "Cannot read secret: $secret_name ($CUR_PROJECT)"

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
    ok "No changes to push ($CUR_TARGET). All secrets match."
    return 0
  fi

  log "Summary: ${#changed[@]} secret(s) to push ($CUR_TARGET)"
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
    log "[DRY-RUN] No changes made ($CUR_TARGET)."
    return 0
  fi

  log ""
  read -r -p "[rotate] Proceed with $CUR_TARGET? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || die "Aborted."

  # ── Phase 2: Push secrets ───────────────────────────────────────────────

  log ""
  log "Pushing ${#changed[@]} secret(s) to Secret Manager ($CUR_PROJECT)..."

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
      --project="$CUR_PROJECT" --data-file=- --quiet >/dev/null
    ok "Pushed: $secret_name"
    pushed+=("$secret_name")
  done

  # ── Phase 3: Redeploy ──────────────────────────────────────────────────

  if $SKIP_DEPLOY; then
    log ""
    warn "--skip-deploy set. Remember to deploy $CUR_TARGET manually."
  elif (( ${#unique_svcs[@]} > 0 )); then
    log ""
    log "Redeploying ${#unique_svcs[@]} service(s)/job(s) ($CUR_TARGET)..."

    local ts
    ts=$(date +%s)

    for svc in "${unique_svcs[@]}"; do
      local svc_name="${svc%%:*}"
      local svc_type="${svc##*:}"
      [[ "$svc_type" == "$svc_name" ]] && svc_type="svc"

      if [[ "$svc_type" == "job" ]]; then
        gcloud run jobs update "$svc_name" \
          --region="$REGION" --project="$CUR_PROJECT" \
          --update-env-vars="_ROTATE_TS=$ts" --quiet >/dev/null
      else
        gcloud run services update "$svc_name" \
          --region="$REGION" --project="$CUR_PROJECT" \
          --update-env-vars="_ROTATE_TS=$ts" --quiet >/dev/null
      fi
      ok "Redeployed: $svc_name ($svc_type)"
    done
  fi

  # ── Done ────────────────────────────────────────────────────────────────

  log ""
  ok "Rotation complete ($CUR_TARGET). ${#pushed[@]} secret(s) pushed, ${#unique_svcs[@]} target(s) redeployed."
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  log "rotate-secrets — idempotent secret rotation"
  log ""

  local targets=()
  if [[ "$TARGET" == "all" ]]; then
    targets=(gamma prod)
  else
    targets=("$TARGET")
  fi

  for t in "${targets[@]}"; do
    run_target "$t"
    log ""
  done

  log "Post-rotation checklist:"
  for t in "${targets[@]}"; do
    local url
    url=$("${t}_url")
    log "  • Verify health: curl -sI ${url}/health"
  done
  log "  • Restore local dev values in .env if you changed DB URLs"
  log "  • Test an MCP connection (Cursor / Inspector)"
}

main
