# Secret Rotation Runbook

Idempotent script for rotating leaked or expired credentials across `labs-mcp-gamma` (MCP server) and `labs-saas-ctrl` (control plane). Supports both gamma (`ai-5pm-labs`) and prod (`ai-5pm-mcp`) GCP projects.

## Quick Start

```bash
# 1. Rotate the key upstream (Auth0, Stripe, etc.)
# 2. Put the new value in the appropriate .env file
# 3. Run:
./scripts/rotate-secrets.sh --dry-run                    # preview gamma changes (default)
./scripts/rotate-secrets.sh --target prod --dry-run      # preview prod changes
./scripts/rotate-secrets.sh --target all --dry-run       # preview both
./scripts/rotate-secrets.sh --target prod                # push + redeploy prod
./scripts/rotate-secrets.sh --check-build-args --validate  # verify SPA build-time args
```

## Flags

| Flag | Effect |
|---|---|
| `--target gamma\|prod\|all` | GCP project to target (default: `gamma`) |
| `--dry-run` | Compare and show what would change; no push, no deploy |
| `--validate` | Check config only (files exist, gcloud auth, secrets exist) |
| `--skip-deploy` | Push secrets to Secret Manager but don't redeploy services |
| `--check-build-args` | Verify SPA build-time args match expected values in the live bundle |
| `-h, --help` | Print usage header |

## Env Overrides

| Var | Default | Purpose |
|---|---|---|
| `MCP_REPO` | `../` (relative to script) | Path to `labs-mcp-gamma` |
| `CTRL_REPO` | `../../labs-saas-ctrl` | Path to `labs-saas-ctrl` |

## Target Mapping

| Target | GCP Project | Registry | SPA URL |
|---|---|---|---|
| `gamma` | `ai-5pm-labs` | `us-east4-docker.pkg.dev/ai-5pm-labs/gamma-docker` | `https://gamma.5pm.ai` |
| `prod` | `ai-5pm-mcp` | `us-east4-docker.pkg.dev/ai-5pm-mcp/prod-docker` | `https://mcp.5pm.ai` |

## Secret Mapping

Verified against live Cloud Run service configurations. Both targets use the same secret names in their respective GCP projects.

### Runtime secrets (Secret Manager → Cloud Run)

| Secret Manager Name | Source | `.env` Var | Gamma Target(s) | Prod Target(s) |
|---|---|---|---|---|
| `auth0-client-secret` | mcp | `AUTH0_CLIENT_SECRET` | gamma-mcp | prod-mcp |
| `database-url` | mcp | `DATABASE_URL` | gamma-mcp | prod-mcp |
| `openai-api-key` | mcp | `OPENAI_API_KEY` | gamma-mcp, gamma-ctrl-api, gamma-ingest-worker | prod-mcp, prod-ctrl-api, prod-ingest-worker |
| `ingest-database-url` | mcp | `INGEST_DATABASE_URL` | gamma-ingest-worker | prod-ingest-worker |
| `ctrl-database-url` | ctrl | `DATABASE_URL` | gamma-ctrl-api | prod-ctrl-api |
| `database-admin-url` | ctrl | `DATABASE_ADMIN_URL` | db-migrate | db-migrate |
| `stripe-secret-key` | ctrl | `STRIPE_SECRET_KEY` | gamma-ctrl-api | prod-ctrl-api |
| `stripe-webhook-secret` | ctrl | `STRIPE_WEBHOOK_SECRET` | gamma-ctrl-api | prod-ctrl-api |
| `postmark-server-token` | ctrl | `POSTMARK_SERVER_TOKEN` | gamma-ctrl-api | prod-ctrl-api |

### Excluded from rotation

| Secret | Reason |
|---|---|
| `redis-tls-ca` | Memorystore-managed CA cert, not sourced from `.env` |

### Build-time args (require Docker rebuild, not Secret Manager)

These are baked into the SPA Docker image at build time. Use `--check-build-args` to verify they match in the live deployment.

| Var | Gamma Value | Prod Value | When to rebuild |
|---|---|---|---|
| `VITE_AUTH0_CLIENT_ID` | `nEejna8VWdHg3GR56DK9pbG6lj828yYg` | `nsflJdrV8RsRoc6qarMWjl934jZkZkt0` | Auth0 app change, new environment |
| `VITE_AUTH0_AUDIENCE` | `https://api.gamma.5pm.ai` | `https://api.mcp.5pm.ai` | Auth0 API change |
| `VITE_APP_ORIGIN` | `https://gamma.5pm.ai` | `https://mcp.5pm.ai` | Domain change |
| `VITE_STRIPE_PUBLISHABLE_KEY` | (test key) | (prod key) | Stripe account switch |
| `VITE_DEPLOYMENT_ENV` | `gamma` | `production` | — |

**Gamma rebuild:**
```bash
cd ~/ai.5pm.labs/labs-saas-ctrl
docker buildx build --platform linux/amd64 \
  --build-arg VITE_DEPLOYMENT_ENV=gamma \
  -t us-east4-docker.pkg.dev/ai-5pm-labs/gamma-docker/ctrl-plane:vNEW \
  -f Dockerfile .
docker push us-east4-docker.pkg.dev/ai-5pm-labs/gamma-docker/ctrl-plane:vNEW
gcloud run services update gamma-ctrl --region=us-east4 --project=ai-5pm-labs \
  --image=us-east4-docker.pkg.dev/ai-5pm-labs/gamma-docker/ctrl-plane:vNEW
```

**Prod rebuild** (all build args must be explicit — Dockerfile defaults are gamma):
```bash
cd ~/ai.5pm.labs/labs-saas-ctrl
docker buildx build --platform linux/amd64 \
  --build-arg VITE_AUTH0_CLIENT_ID=nsflJdrV8RsRoc6qarMWjl934jZkZkt0 \
  --build-arg VITE_AUTH0_AUDIENCE=https://api.mcp.5pm.ai \
  --build-arg VITE_APP_ORIGIN=https://mcp.5pm.ai \
  --build-arg VITE_STRIPE_PUBLISHABLE_KEY=<PROD_STRIPE_PK> \
  --build-arg VITE_DEPLOYMENT_ENV=production \
  -t us-east4-docker.pkg.dev/ai-5pm-mcp/prod-docker/ctrl-plane:vNEW \
  -f Dockerfile .
docker push us-east4-docker.pkg.dev/ai-5pm-mcp/prod-docker/ctrl-plane:vNEW
gcloud run services update prod-ctrl --region=us-east4 --project=ai-5pm-mcp \
  --image=us-east4-docker.pkg.dev/ai-5pm-mcp/prod-docker/ctrl-plane:vNEW
```

## Per-Provider Rotation Procedures

### Auth0 Client Secret

**Gamma:**
1. Auth0 Dashboard → Applications → "MCP Server (labs-mcp-gamma)" → Settings → Rotate Secret
2. Copy new secret into `labs-mcp-gamma/.env` as `AUTH0_CLIENT_SECRET`
3. Run `./scripts/rotate-secrets.sh`

**Prod:**
1. Auth0 Dashboard → Applications → "MCP Server (prod)" → Settings → Rotate Secret
2. Copy new secret into `labs-mcp-gamma/.env` as `AUTH0_CLIENT_SECRET`
3. Run `./scripts/rotate-secrets.sh --target prod`
4. Restore the gamma secret in `.env`

### OpenAI API Key

1. OpenAI Dashboard → API Keys → Revoke old key → Create new key
2. Update `OPENAI_API_KEY` in **both** `labs-mcp-gamma/.env` and `labs-saas-ctrl/.env`
3. Run `./scripts/rotate-secrets.sh --target all`

Affects 3 services per target (mcp, ctrl-api, ingest-worker).

### Stripe Secret Key

1. Stripe Dashboard → Developers → API Keys → Roll key
2. Update `STRIPE_SECRET_KEY` in `labs-saas-ctrl/.env`
3. Run `./scripts/rotate-secrets.sh --target <gamma|prod>`

If switching Stripe accounts entirely, also update:
- `STRIPE_WEBHOOK_SECRET` (roll endpoint signing secret)
- `STRIPE_PRICE_*` env vars (create new products/prices on new account)
- Clear `stripe_customer_id` and `stripe_subscription_id` in Postgres
- Rebuild SPA with new `VITE_STRIPE_PUBLISHABLE_KEY`

### Stripe Webhook Secret

1. Stripe Dashboard → Developers → Webhooks → Roll signing secret
2. Update `STRIPE_WEBHOOK_SECRET` in `labs-saas-ctrl/.env`
3. Run `./scripts/rotate-secrets.sh --target <gamma|prod>`

### Postmark Server Token

1. Postmark Dashboard → Server → API Tokens → Regenerate
2. Update `POSTMARK_SERVER_TOKEN` in `labs-saas-ctrl/.env`
3. Run `./scripts/rotate-secrets.sh --target <gamma|prod>`

### Database Passwords

DB password rotation is a multi-step process because the password must be changed in Cloud SQL **before** the connection string is updated in Secret Manager.

1. **ALTER ROLE via bastion:**
   ```bash
   # Gamma:
   gcloud compute ssh gamma-bastion --tunnel-through-iap --zone=us-east4-a --project=ai-5pm-labs
   # Prod:
   gcloud compute ssh prod-bastion --tunnel-through-iap --zone=us-east4-a --project=ai-5pm-mcp

   # From bastion, connect to Cloud SQL:
   psql "postgresql://postgres:ADMIN_PASS@10.20.0.3:5432/mcp?sslmode=no-verify"

   -- Rotate the role password:
   ALTER ROLE mcp_app WITH PASSWORD 'NEW_PASSWORD';
   -- or: ALTER ROLE ctrl_app WITH PASSWORD 'NEW_PASSWORD';
   -- or: ALTER ROLE ingest_app WITH PASSWORD 'NEW_PASSWORD';
   ```

2. **Update .env with the production connection string:**
   ```
   DATABASE_URL=postgresql://mcp_app:NEW_PASSWORD@10.20.0.3:5432/mcp?sslmode=no-verify
   ```

3. **Run the script:**
   ```bash
   ./scripts/rotate-secrets.sh --target <gamma|prod>
   ```

4. **Restore local dev values in .env after the script completes.**

The script refuses to push connection strings containing `localhost` or dev passwords as a safety guard.

### Test Credentials (local-only)

These credentials exist only in `labs-saas-ctrl/.env` and have no production footprint:

- `TEST_AUTH0_ROPG_CLIENT_SECRET` / `TEST_AUTH0_M2M_CLIENT_SECRET`
- `TEST_SNOWFLAKE_PRIVATE_KEY_PEM`
- `TEST_PINECONE_API_KEY`
- `TEST_BIGQUERY_SERVICE_ACCOUNT_JSON`

Rotate them in their respective dashboards and update the `.env` file directly. No script action needed.

## How Redeployment Works

All Cloud Run secrets use the `:latest` version reference. Creating a new Secret Manager version makes it available, but Cloud Run only reads secrets at revision startup. The script forces a new revision by setting a `_ROTATE_TS` env var with the current timestamp:

```
gcloud run services update gamma-mcp --update-env-vars=_ROTATE_TS=1712345678
```

This is idempotent — each run produces a unique timestamp, but re-running after no Secret Manager changes results in no-op (the script exits early when all values match).

## Safety Guards

| Guard | Behavior |
|---|---|
| Target isolation | Gamma and prod are separate GCP projects with distinct secret stores |
| Local dev URL detection | Refuses to push DB URLs containing `localhost`, `127.0.0.1`, or known dev passwords |
| Build-time arg check | `--check-build-args` verifies SPA bundles contain correct Auth0/audience values |
| Cross-repo consistency | Warns if `OPENAI_API_KEY` or `INGEST_DATABASE_URL` differ between repos |
| Confirmation prompt | Shows summary and asks `[y/N]` before pushing (skipped in `--dry-run`) |
| No secret logging | Values are piped via `--data-file=-`, never appear in `ps` or shell history |
| Idempotent | Re-running with unchanged values is a no-op |
