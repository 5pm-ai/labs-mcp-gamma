# Integrations

## Auth0

- **Tenant**: `ai-5pm-labs.us.auth0.com`
- **CLI**: `auth0` CLI authenticated and active on this tenant (`auth0 tenants list` to verify)
- **Connections**: `google-oauth2` (Google social login), `Username-Password-Authentication` (email/password)
- **Application**: "MCP Server (labs-mcp-gamma)" — Regular Web App, client_id in `.env`
- **Callbacks**: `http://localhost:3232/auth0/callback` (dev), `https://gamma.5pm.ai/auth0/callback` (prod)
- **Account Linking Action**: "Account Linking by Email" — post-login action that merges accounts with the same verified email. Requires M2M app "Account Linking Action (M2M)" with `read:users` + `update:users` grants on the Management API. Action secrets: `DOMAIN`, `CLIENT_ID`, `CLIENT_SECRET`.
- **Setup**: To complete action deployment, re-authenticate auth0 CLI with `create:client_grants` scope, then deploy and bind the action to the login trigger.

## GCP (Project: `ai-5pm-labs`)

- **CLI**: `gcloud` authenticated as `braun@brand.co` with `roles/owner`
- **Config**: `gcloud config get-value project` → `ai-5pm-labs`
- **Region**: `us-east4` (Ashburn, VA — closest to Boston)
- **VPC**: `gamma-vpc` (custom mode, no default VPC)
- **APIs enabled**: compute, run, sqladmin, redis, artifactregistry, iap, secretmanager, servicenetworking, vpcaccess, cloudbuild, cloudresourcemanager
- **Artifact Registry**: `us-east4-docker.pkg.dev/ai-5pm-labs/gamma-docker` — Docker auth via `gcloud auth configure-docker us-east4-docker.pkg.dev`
- **IAP SSH to bastion**: `gcloud compute ssh gamma-bastion --tunnel-through-iap --zone=us-east4-a`
- **DB migrations**: `gcloud run jobs execute db-migrate --region=us-east4`

## Cloudflare

- **Domain**: `5pm.ai` (managed via Cloudflare dashboard)
- **DNS**: `gamma.5pm.ai` A record → `34.54.83.204` (proxied, orange cloud)
- **SSL/TLS**: Full mode (encrypts Cloudflare-to-origin, does not validate origin cert)
- **Origin CA cert**: Wildcard `*.5pm.ai`, PEM format, expires 2040-06-06. Stored locally in `.cloudflare/` (gitignored). Uploaded to GCP as `gamma-5pm-ai-origin` self-managed SSL certificate.

## Redis

### Local Dev
- Docker container via `docker compose up -d`
- Port: 6379
- No auth in dev (password optional via `REDIS_PASSWORD` env var)

### Production
- Memorystore Redis 7.2 (Basic tier, 1GB)
- Private IP: `10.20.1.3:6378`
- TLS in-transit encryption: `SERVER_AUTHENTICATION`
- Server CA cert stored in Secret Manager (`redis-tls-ca`), mounted as `REDIS_TLS_CA` env var
- No public IP, VPC-only access via PSA peering

## Postgres

### Local Dev
- Docker container via `docker compose up -d`
- Host port: 5433 (mapped from container 5432)
- Superuser: `mcp_admin` / `mcp_dev_password`
- App user: `mcp_app` / `mcp_dev_password` (RLS enforced)
- Database: `mcp`
- Schema initialized by `db/init.sql` on first container start

### Production
- Cloud SQL PostgreSQL 16 (Enterprise, db-f1-micro)
- Private IP: `10.20.0.3:5432`
- Admin user: `postgres` (password in Secret Manager `database-admin-url`)
- App user: `mcp_app` (password in Secret Manager `database-url`)
- Database: `mcp`
- Schema initialized via Cloud Run Job: `gcloud run jobs execute db-migrate --region=us-east4`
- No public IP, VPC-only access via PSA peering
