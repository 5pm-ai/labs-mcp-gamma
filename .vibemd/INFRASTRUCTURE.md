# Infrastructure & Assets Register

## GCP Project: `ai-5pm-labs`

| Name/ID | Type | Purpose | Location/Path | Lifecycle | Owner | Date | Notes |
|---|---|---|---|---|---|---|---|
| gamma-vpc | VPC | Isolated custom-mode VPC | us-east4, GCP | persistent | braun | 2026-03-17 | Custom subnet mode, no default routes except PGA |
| sn-app | Subnet | Cloud Run Direct VPC Egress | us-east4, 10.10.0.0/24 | persistent | braun | 2026-03-17 | PGA enabled |
| sn-data | Subnet | Data tier (reserved) | us-east4, 10.10.1.0/24 | persistent | braun | 2026-03-17 | PGA enabled |
| sn-mgmt | Subnet | Bastion / management | us-east4, 10.10.2.0/28 | persistent | braun | 2026-03-17 | PGA enabled |
| google-managed-services | PSA range | Cloud SQL / Redis private peering | 10.20.0.0/16, GCP | persistent | braun | 2026-03-17 | Managed by Google, do not overlap with VPC peering targets |
| gamma-router | Cloud Router | BGP control plane for NAT | us-east4 | persistent | braun | 2026-03-17 | |
| gamma-nat | Cloud NAT | Outbound internet for private resources | us-east4 | persistent | braun | 2026-03-17 | Covers sn-app, sn-mgmt |
| gamma-nat-ip-1 | Static IP | NAT egress IP for upstream whitelisting | 34.150.236.79, us-east4 | persistent | braun | 2026-03-17 | Use for upstream IP allowlisting |
| gamma-lb-ip | Static IP | External LB frontend | 34.54.83.204, global | persistent | braun | 2026-03-17 | Cloudflare A record target |
| gamma-pg | Cloud SQL | PostgreSQL 16 (Enterprise, db-f1-micro) | us-east4, private IP 10.20.0.3 | persistent | braun | 2026-03-17 | No public IP. DB: mcp. Users: postgres, mcp_app, ingest_app |
| gamma-redis | Memorystore | Redis 7.2 (Basic, 1GB) | us-east4, private IP 10.20.1.3:6378 | persistent | braun | 2026-03-17 | TLS in-transit encryption enabled. No public IP. |
| gamma-bastion | Compute Engine | Bastion host (e2-micro, Debian 12) | us-east4-a, 10.10.2.2 | persistent | braun | 2026-03-17 | No public IP. IAP SSH only. SA: sa-bastion |
| gamma-docker | Artifact Registry | Docker image repository | us-east4 | persistent | braun | 2026-03-17 | IAM-gated, no public access |
| gamma-mcp | Cloud Run Service | MCP server (production) | us-east4 | persistent | braun | 2026-04-14 | Ingress: internal-and-cloud-load-balancing. SA: sa-mcp-server. Image: mcp-server:v18. max-instances: 3. Pool.max: 3. |
| db-migrate | Cloud Run Job | Database schema init / migrations (mcp + ctrl) | us-east4 | persistent | braun | 2026-04-23 | On-demand: `gcloud run jobs execute db-migrate`. Runs `db/migrate.cjs` which applies `db/init.sql` (mcp) then `db/ctrl-init.sql` (ctrl, staged by deploy script from `labs-saas-ctrl/db/init.sql`). SA: sa-db-admin. |
| gamma-ingest-worker | Cloud Run Job | Metadata ingest pipeline (preflight → upsert) | us-east4 | persistent | braun | 2026-03-24 | No public ingress. SA: sa-ingest-worker. Dispatched by ctrl-api |
| sa-ingest-worker | IAM Service Account | Runtime identity for ingest job | ai-5pm-labs.iam.gserviceaccount.com | persistent | braun | 2026-03-24 | See Service Accounts table for IAM bindings |
| ingest_app | Postgres role | RLS-scoped DB role for ingest worker | gamma-pg / mcp | persistent | braun | 2026-03-24 | No credential write access; see db migrations |
| ingest-worker:v7 | Container image | Ingest job Docker image | Artifact Registry (gamma-docker) | persistent | braun | 2026-04-14 | Built from `Dockerfile.worker`. Pool.max: 2. |
| googleapis-internal | Cloud DNS Zone | Private zone mapping *.googleapis.com to restricted VIPs (199.36.153.4/30) | gamma-vpc | persistent | braun | 2026-03-25 | Required for Cloud Run Jobs with all-traffic VPC egress to reach KMS/Secret Manager via PGA |
| gamma-5pm-ai-origin | SSL Certificate | Cloudflare Origin CA (self-managed) | global, GCP | persistent | braun | 2026-03-17 | Wildcard *.5pm.ai, expires 2040-06-06 |
| gamma-mcp-neg | Serverless NEG | Cloud Run -> LB bridge | us-east4 | persistent | braun | 2026-03-17 | Points to gamma-mcp Cloud Run service |
| gamma-mcp-backend | Backend Service | LB backend | global | persistent | braun | 2026-03-17 | EXTERNAL_MANAGED scheme. Cloud Armor: gamma-waf-policy |
| gamma-mcp-urlmap | URL Map | HTTPS routing | global | persistent | braun | 2026-03-17 | Default route to gamma-mcp-backend |
| gamma-mcp-http-redirect | URL Map | HTTP->HTTPS redirect | global | persistent | braun | 2026-03-17 | 301 redirect |
| gamma-waf-policy | Cloud Armor Security Policy | WAF + origin restriction | global | persistent | braun | 2026-04-01 | Standard tier. OWASP rules in preview mode. Cloudflare IP restriction enforced. Attached to all 3 backend services. LB logging enabled at 100% sample rate. |

## Service Accounts

| SA | Purpose | Key Roles |
|---|---|---|
| sa-mcp-server@ai-5pm-labs.iam.gserviceaccount.com | Cloud Run MCP server + ctrl-api | cloudsql.client, secretmanager.secretAccessor, redis.editor, artifactregistry.reader, run.invoker, run.developer |
| sa-db-admin@ai-5pm-labs.iam.gserviceaccount.com | Cloud Run Job (migrations) | cloudsql.client, secretmanager.secretAccessor, artifactregistry.reader |
| sa-ingest-worker@ai-5pm-labs.iam.gserviceaccount.com | Cloud Run Job (gamma-ingest-worker) | cloudsql.client, secretmanager.secretAccessor (openai-api-key), cloudkms.cryptoKeyDecrypter, artifactregistry.reader |
| sa-bastion@ai-5pm-labs.iam.gserviceaccount.com | Bastion VM | compute.osLogin, artifactregistry.reader |

## Firewall Rules

| Rule | Direction | Priority | Allow/Deny | Source/Dest | Target |
|---|---|---|---|---|---|
| gamma-deny-all-ingress | INGRESS | 65534 | DENY all | 0.0.0.0/0 | all |
| gamma-deny-all-egress | EGRESS | 65534 | DENY all | 0.0.0.0/0 | all |
| gamma-allow-iap-ssh | INGRESS | 1000 | ALLOW tcp:22 | 35.235.240.0/20 | tag: allow-iap |
| gamma-allow-internal | INGRESS | 1000 | ALLOW all | 10.10.0.0/16, 10.20.0.0/16 | all |
| gamma-allow-egress-internal | EGRESS | 1000 | ALLOW all | 10.10.0.0/16, 10.20.0.0/16 | all |
| gamma-allow-health-checks | INGRESS | 1000 | ALLOW tcp | 35.191.0.0/16, 130.211.0.0/22 | tag: allow-hc |
| gamma-allow-egress-internet-sn-app | EGRESS | 1000 | ALLOW tcp:443 | 0.0.0.0/0 | SA: sa-ingest-worker, sa-mcp-server |
| gamma-allow-egress-google-apis | EGRESS | 900 | ALLOW tcp:443 | 199.36.153.4/30, 199.36.153.8/30 | all |

## Secrets (Secret Manager)

| Secret | Purpose | Notes |
|---|---|---|
| auth0-client-secret | Auth0 OIDC client secret | Rotate via Auth0 dashboard + update secret version |
| database-url | Postgres connection string (mcp_app) | sslmode=no-verify, private IP |
| database-admin-url | Postgres connection string (postgres) | Used by db-migrate job only |
| redis-tls-ca | Memorystore Redis server CA cert | Required for TLS connections |
| openai-api-key | OpenAI API key for embeddings | Accessor: sa-ingest-worker, sa-mcp-server |
| ingest-database-url | Postgres connection string (ingest_app) | sslmode=no-verify, private IP. Accessor: sa-ingest-worker |

## Environment Variables (Cloud Run: gamma-mcp)

| Var | Source | Purpose |
|---|---|---|
| KMS_KEY_NAME | Plain env var | GCP KMS key resource name for warehouse credential decryption |

## Operations Scripts

| Name/ID | Type | Purpose | Location/Path | Lifecycle | Owner | Date | Notes |
|---|---|---|---|---|---|---|---|
| rotate-secrets.sh | script | Idempotent secret rotation across MCP + ctrl repos | scripts/rotate-secrets.sh | persistent | braun | 2026-04-03 | Reads .env, pushes to Secret Manager, redeploys Cloud Run. See scripts/ROTATE_SECRETS.md |
| deploy-gamma.sh | script | Deploy pipeline to gamma.5pm.ai | scripts/deploy-gamma.sh | persistent | braun | 2026-04-23 | Builds, pushes, migrates, deploys. Auto-increments versions. `--only <mcp\|worker\|ctrl-api\|ctrl\|migrate>` cherry-pick flag (repeatable; default = all). Stages `labs-saas-ctrl/db/init.sql` into `db/ctrl-init.sql` at build time for db-migrate. |
| deploy-prod.sh | script | Deploy pipeline to mcp.5pm.ai | scripts/deploy-prod.sh | persistent | braun | 2026-04-23 | Same as gamma but with explicit prod VITE_* build args + `--no-cpu-throttling` / `--timeout=3600` pins on prod-mcp. SPA verifier uses `LC_ALL=C grep -a`. Same `--only` cherry-pick flag. |
| with-cloud.sh | script | IAP tunnel + env-injected subprocess for testing against gamma/prod | scripts/with-cloud.sh | persistent | braun | 2026-04-23 | `./scripts/with-cloud.sh <gamma\|prod> [--port N] [--dry-run] -- <cmd...>` opens `gcloud ssh -L 5434\|5435:10.20.0.3:5432` in the background, fetches DB URL secrets, exec's `<cmd>` with `DATABASE_*` / `TEST_API_BASE_URL` / `TEST_MCP_BASE_URL` / `TEST_SPA_BASE_URL` / `AUTH0_AUDIENCE` injected **into the subprocess only**. `TEST_SPA_BASE_URL` pins Playwright `baseURL` to the deployed SPA in the same env the DB/API point at, so `test:browser` is aligned (prevents UI-local / DB-cloud split). Never touches `.env`. Tunnel dies on EXIT/INT/TERM. |

## Local Dev Infrastructure

| Name/ID | Type | Purpose | Location/Path | Lifecycle | Owner | Date | Notes |
|---|---|---|---|---|---|---|---|
| redis (docker) | container | Session cache, pub/sub, ephemeral auth data | localhost:6379 | temp | dev | 2026-03-17 | `docker compose up -d` |
| postgres (docker) | container | Durable client registration, user identity | localhost:5433 | persistent | dev | 2026-03-17 | Volume: postgres-data |
| db/init.sql | schema | Postgres schema init (roles, tables, RLS) | db/init.sql | persistent | dev | 2026-03-17 | Auto-applied on first container start |

## GCP Project: `ai-5pm-mcp` (Production)

| Name/ID | Type | Purpose | Location/Path | Lifecycle | Owner | Date | Notes |
|---|---|---|---|---|---|---|---|
| prod-vpc | VPC | Isolated custom-mode VPC | us-east4, GCP | persistent | braun | 2026-04-07 | Custom subnet mode, mirrors gamma-vpc topology |
| sn-app | Subnet | Cloud Run Direct VPC Egress | us-east4, 10.10.0.0/24 | persistent | braun | 2026-04-07 | PGA enabled |
| sn-data | Subnet | Data tier (reserved) | us-east4, 10.10.1.0/24 | persistent | braun | 2026-04-07 | PGA enabled |
| sn-mgmt | Subnet | Bastion / management | us-east4, 10.10.2.0/28 | persistent | braun | 2026-04-07 | PGA enabled |
| google-managed-services | PSA range | Cloud SQL / Redis private peering | 10.20.0.0/16, GCP | persistent | braun | 2026-04-07 | |
| prod-router | Cloud Router | BGP control plane for NAT | us-east4 | persistent | braun | 2026-04-07 | |
| prod-nat | Cloud NAT | Outbound internet for private resources | us-east4 | persistent | braun | 2026-04-07 | Covers sn-app, sn-mgmt |
| prod-nat-ip-1 | Static IP | NAT egress IP | 34.11.9.234, us-east4 | persistent | braun | 2026-04-07 | |
| prod-lb-ip | Static IP | External LB frontend | 34.8.216.219, global | persistent | braun | 2026-04-07 | Cloudflare A record target |
| prod-pg | Cloud SQL | PostgreSQL 16 (Enterprise, db-custom-2-7680) | us-east4, private IP 10.20.0.3 | persistent | braun | 2026-04-07 | Tier 2: 2 vCPU, 7.5GB RAM, ~200 max conn. No public IP. |
| prod-redis | Memorystore | Redis 7.2 (Standard HA, 1GB) | us-east4, private IP 10.20.1.4:6378 | persistent | braun | 2026-04-07 | TLS, PSA connect mode, HA failover replica |
| prod-bastion | Compute Engine | Bastion host (e2-micro, Debian 12) | us-east4-a, 10.10.2.2 | persistent | braun | 2026-04-07 | No public IP. IAP SSH only. SA: sa-bastion |
| prod-docker | Artifact Registry | Docker image repository | us-east4 | persistent | braun | 2026-04-07 | IAM-gated |
| prod-mcp | Cloud Run Service | MCP server (production) | us-east4 | persistent | braun | 2026-04-20 | Min 2 / Max 10 instances, 1GiB, 1 vCPU. SA: sa-mcp-server. **Pinned in deploy-prod.sh**: `--timeout=3600` (SSE GET must outlive default 300s LB cut) and `--no-cpu-throttling` (CPU always-allocated so session Redis pub/sub subscriptions survive idle). See LESSONS_LEARNED.md 2026-04-20 entry. |
| prod-ctrl-api | Cloud Run Service | Control plane API | us-east4 | persistent | braun | 2026-04-07 | Min 2 instances, 512MiB. SA: sa-mcp-server |
| prod-ctrl | Cloud Run Service | Control plane SPA | us-east4 | persistent | braun | 2026-04-13 | Min 1 instance, 256MiB. nginx static. Image: ctrl-plane:v15 |
| prod-ctrl-api | Cloud Run Service | Control plane API | us-east4 | persistent | braun | 2026-04-10 | Min 2 instances, 512MiB. Image: ctrl-api:v4. SF write probe: 2-category (permanent vs temporary). |
| db-migrate | Cloud Run Job | Database schema init (mcp + ctrl) | us-east4 | persistent | braun | 2026-04-23 | Runs `db/migrate.cjs` which applies both mcp and ctrl `init.sql`. Image: mcp-server (rebuilt each deploy so ctrl SQL is current). SA: sa-db-admin. |
| prod-ingest-worker | Cloud Run Job | Ingest pipeline worker | us-east4 | persistent | braun | 2026-04-07 | SA: sa-ingest-worker |
| prod-keys | KMS keyring | Credential encryption keys | us-east4 | persistent | braun | 2026-04-07 | |
| prod-credentials-key | KMS key | Envelope encrypt warehouse/sink creds | us-east4 | persistent | braun | 2026-04-07 | |
| prod-waf-policy | Cloud Armor | WAF + origin restriction | global | persistent | braun | 2026-04-07 | Cloudflare IP restriction enforced |
| prod-5pm-ai-origin | SSL Certificate | Cloudflare Origin CA (self-managed) | global | persistent | braun | 2026-04-07 | Wildcard *.5pm.ai, same cert as gamma |
| googleapis-internal | Cloud DNS Zone | Private zone for googleapis restricted VIPs | prod-vpc | persistent | braun | 2026-04-07 | Required for Cloud Run Jobs VPC egress |

## External Services

| Name/ID | Type | Purpose | Location | Lifecycle | Owner | Date | Notes |
|---|---|---|---|---|---|---|---|
| Auth0 App (MCP Server) | application | Regular Web App for OIDC upstream (gamma) | ai-5pm-labs.us.auth0.com | persistent | braun | 2026-03-17 | client_id: CDMzP2gS1aCz84Fy4GiAF22SB4WQmp3I |
| Auth0 App (MCP Server prod) | application | Regular Web App for OIDC upstream (prod) | ai-5pm-labs.us.auth0.com | persistent | braun | 2026-04-07 | client_id: ImD6wLg8n3BNlZ9thpkmlx2dg67TlSFV |
| Auth0 App (M2M) | application | M2M for Account Linking Action | ai-5pm-labs.us.auth0.com | persistent | braun | 2026-03-17 | client_id: uviokzty2SoteJN7mW5OTiZ4vcsRWQ5l |
| Auth0 Action | action | Account Linking by Email | ai-5pm-labs.us.auth0.com | persistent | braun | 2026-03-17 | ID: 0bdb3e24-9c4a-4224-9414-bb000598fff2 |
| Auth0 API (gamma) | resource server | JWT audience for gamma | ai-5pm-labs.us.auth0.com | persistent | braun | 2026-03-23 | identifier: https://api.gamma.5pm.ai |
| Auth0 API (prod) | resource server | JWT audience for prod | ai-5pm-labs.us.auth0.com | persistent | braun | 2026-04-07 | identifier: https://api.mcp.5pm.ai |
| Cloudflare DNS (gamma) | DNS | gamma.5pm.ai A record (proxied) | Cloudflare 5pm.ai zone | persistent | braun | 2026-03-17 | A record -> 34.54.83.204, SSL/TLS: Full |
| Cloudflare DNS (prod) | DNS | mcp.5pm.ai A record (proxied) | Cloudflare 5pm.ai zone | persistent | braun | 2026-04-07 | A record -> 34.8.216.219, SSL/TLS: Full |
| Cloudflare DNS (apex) | DNS | 5pm.ai AAAA (blackhole, proxied) | Cloudflare 5pm.ai zone | persistent | braun | 2026-04-17 | AAAA -> 100:: . Holds hostname at edge for redirect rule; replaced prior GitHub Pages A records |
| Cloudflare DNS (www) | DNS | www.5pm.ai CNAME (proxied) | Cloudflare 5pm.ai zone | persistent | braun | 2026-04-17 | CNAME -> 5pm.ai . Replaced prior GitHub Pages CNAME |
| Cloudflare Page Rule (apex→mcp) | Page Rule | 5pm.ai/* → https://mcp.5pm.ai/$1 | Cloudflare 5pm.ai zone | persistent | braun | 2026-04-17 | Forwarding URL, 302 initially (flip to 301 after validation). Edge-only, never touches origin |
| Cloudflare Page Rule (www→mcp) | Page Rule | www.5pm.ai/* → https://mcp.5pm.ai/$1 | Cloudflare 5pm.ai zone | persistent | braun | 2026-04-17 | Forwarding URL, 302 initially (flip to 301 after validation) |
| Cloudflare Origin CA | certificate | TLS between Cloudflare and GCP LB | .cloudflare/ (gitignored) | persistent | braun | 2026-03-17 | Wildcard *.5pm.ai, expires 2040-06-06 |
