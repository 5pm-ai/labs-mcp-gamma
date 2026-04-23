# Lessons Learned

### [2026-04-23] `db-migrate` extended to apply both repos' `init.sql` (closes 03-31, 04-16, 04-21 gaps)

**Context:** Three prior incidents (`ctrl_teams_update` missing on prod 2026-03-31, hit again 2026-04-16, `warehouse_keypairs` missing on gamma 2026-04-21) all had the same root cause: the `db-migrate` Cloud Run Job ran from the `mcp-server` image, which only baked in `labs-mcp-gamma/db/init.sql`. The `labs-saas-ctrl/db/init.sql` (~43 KB of ctrl schema, most of the shared DB) was never executed by the pipeline. Remediation required IAP-bastion `psql`, which violated the no-workarounds rule.

**Resolution (MVP, least-risk):**
- `db/migrate.cjs` now applies `db/init.sql` first, then `db/ctrl-init.sql` if present (skips gracefully if not).
- `scripts/deploy-{gamma,prod}.sh` stage `../labs-saas-ctrl/db/init.sql` as `db/ctrl-init.sql` in the MCP repo just before `docker buildx build`, and remove it on exit via `trap`. The existing `COPY db/ db/` in the Dockerfile picks it up automatically.
- `db/ctrl-init.sql` is `.gitignore`d so the temp file never lands in git.
- `.dockerignore` already excludes `**/*.test.ts`, so the new `db/migrate.test.ts` is not shipped in the prod image.
- Deploy scripts gained `--only <component>` cherry-pick flag (`mcp|worker|ctrl-api|ctrl|migrate`, repeatable). Default behavior unchanged (all 5).
- Deploy scripts now hard-fail if `../labs-saas-ctrl` is missing when any ctrl/migrate component is selected (previously silent `|| true`).
- `deploy-prod.sh` SPA verifier now uses `LC_ALL=C grep -a` to stop false-negatives on minified JS (Apr-16 lesson closed).

**Safety properties:** Both `init.sql` files are fully idempotent (only `DROP POLICY IF EXISTS`; every `CREATE TABLE/INDEX/UNIQUE` uses `IF NOT EXISTS`; every `ADD COLUMN` uses `IF NOT EXISTS`; role creation is wrapped in `DO $$ IF NOT EXISTS $$`; zero `DROP TABLE`/`TRUNCATE`/`DELETE`/`INSERT` statements). Re-running against a populated DB is a no-op.

**Prevention:** Any future schema change in either repo's `db/init.sql` now automatically lands on gamma/prod via a single `deploy-*.sh` run. Cherry-pick `--only migrate` enables schema-only hotfixes without rebuilding all service images (though the mcp image is still rebuilt to pick up the newly-staged ctrl SQL).

**Verified locally:** `db/migrate.test.ts` spawns `db/migrate.cjs` against the local docker-compose postgres, confirms both schemas land (including `warehouse_keypairs`), and a second run is a no-op. Full `npm test` + saas-ctrl `test:all` green after changes.

**Refs:** `db/migrate.cjs`, `db/migrate.test.ts`, `scripts/deploy-gamma.sh`, `scripts/deploy-prod.sh`, `.gitignore`. Closes 2026-03-31, 2026-04-16, 2026-04-21 lessons.

---

### [2026-03-17] FORCE ROW LEVEL SECURITY with no policies denies everything

**Context:** First live test of MCP server with Cursor and MCP Inspector after implementing Postgres-backed DCR client store.

**Symptoms:** `POST /register` returned `500 Internal Server Error`. No error appeared in server logs — the SDK's error handler swallowed all non-`OAuthError` exceptions as a generic 500. Reproducing with `curl` confirmed the 500 but gave no detail.

**Root Cause:** `db/init.sql` set `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on all tables, but defined zero RLS policies. With `FORCE ROW LEVEL SECURITY`, Postgres denies all operations for the `mcp_app` role when no permissive policy exists — even though `GRANT ... TO mcp_app` had been issued. The Postgres error code was `42501: new row violates row-level security policy`. The SDK never surfaced this to the logs.

**Resolution:** Added `CREATE POLICY allow_all_... FOR ALL TO mcp_app USING (true) WITH CHECK (true)` for each table in `db/init.sql`. These are structural placeholders to be replaced with scoped user/team policies when RLS rules are defined.

**Prevention:**
- Always pair `FORCE ROW LEVEL SECURITY` with at least a permissive default policy for the application role.
- When a `/register` endpoint returns 500 with no server log, test the Postgres query directly as `mcp_app` to surface the real error.
- The SDK's `clientRegistrationHandler` logs nothing on unexpected errors — add probe queries to isolate Postgres vs application errors.

**Refs:** commit `431e988`

---

### [2026-03-17] RFC 9728 Protected Resource Metadata served at wrong path

**Context:** Same first live test — MCP Inspector console showed `GET /.well-known/oauth-protected-resource/mcp 404`.

**Symptoms:** Clients received a 404 probing the path-specific PRM URL. They then fell back to the root PRM URL (`/.well-known/oauth-protected-resource`), which returned a document with `"resource": "http://localhost:3232/"` — the root, not the MCP endpoint. This caused clients to use a mismatched resource URL throughout the OAuth flow.

**Root Cause:** `mcpAuthMetadataRouter` was called with `resourceServerUrl: new URL(config.baseUri)` (pathname `/`). The SDK constructs the PRM well-known path from the resource URL pathname: `/.well-known/oauth-protected-resource${rsPath}`. With path `/`, the path component is omitted, so PRM is only served at the root. MCP clients (per RFC 9728 and the MCP spec) probe the path-specific URL first: `/.well-known/oauth-protected-resource/mcp`.

**Resolution:** Changed `resourceServerUrl` to `new URL('/mcp', config.baseUri)` so PRM is served at `/.well-known/oauth-protected-resource/mcp`, which is what clients probe.

**Prevention:**
- `resourceServerUrl` in `mcpAuthMetadataRouter` must match the MCP transport endpoint path, not just the base URL.
- Verify with `curl /.well-known/oauth-protected-resource/mcp` after any change to the metadata router configuration.

**Refs:** commit `431e988`

---

### [2026-03-17] Docker buildx platform mismatch — Cloud Run rejects arm64 images

**Context:** First attempt to deploy to Cloud Run after building the Docker image locally on Apple Silicon (M-series Mac).

**Symptoms:** `gcloud run jobs create` failed with: `Container manifest type 'application/vnd.oci.image.index.v1+json' must support amd64/linux.`

**Root Cause:** `docker build` on Apple Silicon defaults to `linux/arm64`. Cloud Run only supports `linux/amd64`.

**Resolution:** Use `docker buildx build --platform linux/amd64` for all images destined for Cloud Run (or any GCP serverless).

**Prevention:**
- Always use `--platform linux/amd64` when building images for GCP Cloud Run.
- Consider adding a `Makefile` target or npm script that encodes this.

---

### [2026-03-17] VPC firewall deny-all blocks PSA-peered services (Cloud SQL, Memorystore)

**Context:** Cloud Run Job (db-migrate) attempted to connect to Cloud SQL at `10.20.0.3:5432` via Direct VPC Egress.

**Symptoms:** Connection timed out (`ETIMEDOUT 10.20.0.3:5432`). The Cloud Run Job was on subnet `sn-app` (10.10.0.0/24), Cloud SQL was in the PSA range (10.20.0.0/16).

**Root Cause:** The `gamma-allow-egress-internal` firewall rule only allowed egress to `10.10.0.0/16` (VPC subnets). The PSA range `10.20.0.0/16` is routed via a Google-managed VPC peering, but traffic to it was blocked by the `gamma-deny-all-egress` rule at priority 65534.

**Resolution:** Updated `gamma-allow-egress-internal` and `gamma-allow-internal` firewall rules to include both `10.10.0.0/16` and `10.20.0.0/16`.

**Prevention:**
- When using Private Service Access for Cloud SQL or Memorystore, always include the allocated PSA CIDR range in internal allow rules.
- The PSA range is a separate peered network — it is NOT automatically covered by VPC subnet-scoped firewall rules.

---

### [2026-03-17] pg driver sslmode=require now means verify-full — breaks Cloud SQL private IP

**Context:** Cloud Run Job connecting to Cloud SQL via private IP with `?sslmode=require` in the connection string.

**Symptoms:** `Migration failed: unable to verify the first certificate`. The pg driver warned: `SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.`

**Root Cause:** `pg` (node-postgres) v8.x changed behavior: `sslmode=require` now enforces full certificate verification (matching `verify-full`). Cloud SQL's server certificate is signed by a Google-internal CA, not a publicly trusted one, so verification fails unless the CA cert is provided.

**Resolution:** Changed connection string to `?sslmode=no-verify`. This encrypts the connection but skips certificate validation. Acceptable because traffic is already within the VPC (private IP, no public route).

**Prevention:**
- For Cloud SQL private IP connections in VPC, use `sslmode=no-verify` unless you also supply the Cloud SQL server CA cert.
- Watch for pg driver major version upgrades that change SSL semantics.

---

### [2026-03-17] Shell variables lost between gcloud commands — secrets stored with empty passwords

**Context:** Generated a password with `POSTGRES_ADMIN_PASSWORD=$(openssl rand ...)` then used it in a subsequent `gcloud secrets versions add` command.

**Symptoms:** `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string` when the Cloud Run Job tried to connect to Postgres. The connection string in the secret had an empty password field: `postgresql://postgres:@10.20.0.3...`.

**Root Cause:** The shell variable `$POSTGRES_ADMIN_PASSWORD` was set in one shell invocation but was not available in a later invocation. Each `gcloud` command may run in a separate shell context depending on the tooling.

**Resolution:** Regenerated passwords and updated both Cloud SQL users and Secret Manager secrets in a single chained command (`&&`).

**Prevention:**
- Always chain password generation, user creation, and secret storage in a single shell command using `&&`.
- Verify secrets after creation: `gcloud secrets versions access latest --secret=<name> | head -c 30` to confirm the value is not empty.

---

### [2026-03-17] Inline Node.js in Cloud Run Job --args has shell quoting issues

**Context:** Tried to pass an inline Node.js script as `--args` to a Cloud Run Job for running database migrations.

**Symptoms:** `Syntax error: Unterminated quoted string`. The shell mangled the nested quotes in the inline Node.js code.

**Root Cause:** Cloud Run Job `--args` passes through multiple shell interpretation layers (gcloud CLI → API → container entrypoint). Nested quotes, semicolons, and special characters get corrupted.

**Resolution:** Created a proper `db/migrate.cjs` script file, included it in the Docker image via `COPY db/ db/`, and set `--command="node" --args="db/migrate.cjs"`.

**Prevention:**
- Never inline non-trivial code in Cloud Run Job `--args`. Always use a script file.
- Use CommonJS (`.cjs`) for scripts that need `require()` in an ESM project.

---

### [2026-03-24] FORCE ROW LEVEL SECURITY blocks new roles without explicit policies

**Context:** Building the ingest worker which connects to the shared Postgres as a new `ingest_app` role. Existing tables (`team_members`, `warehouse_connectors`, `sink_connectors`) have `FORCE ROW LEVEL SECURITY` enabled.

**Symptoms:** All SELECT queries from `ingest_app` returned zero rows, even with correct `SET LOCAL app.user_id` and `GRANT SELECT` in place. Worker reported "Ingest run not found" because it couldn't see any rows.

**Root Cause:** `FORCE ROW LEVEL SECURITY` means even roles with table grants get zero rows if no RLS policy exists for that role. The existing policies were only defined for `mcp_app` and `ctrl_app`. Adding `GRANT SELECT ON team_members TO ingest_app` is necessary but insufficient — an RLS policy for `ingest_app` on `team_members` is also required (permissive SELECT, since `team_members` is used in RLS subqueries for all other tables).

**Resolution:** Added `CREATE POLICY ingest_app_team_members_read ON team_members FOR SELECT TO ingest_app USING (true)` and corresponding policies on all ingest tables.

**Prevention:**
- When introducing a new Postgres role, audit every table it needs to read and ensure an RLS policy exists for that role — grants alone are not enough under `FORCE ROW LEVEL SECURITY`.
- Tables used in RLS subqueries (like `team_members`) need permissive policies for every role that accesses RLS-protected tables.

---

### [2026-03-24] Worker must use its own DB role and DATABASE_URL — no role sharing

**Context:** Initial ingest worker implementation used the MCP server's `DATABASE_URL` (connecting as `mcp_app`). This worked temporarily after granting `mcp_app` write access on ingest tables.

**Symptoms:** Defense-in-depth violation — `mcp_app` had write access to tables it should only read, and the worker shared the MCP server's blast radius.

**Root Cause:** Shortcut taken to avoid creating a separate connection string for the worker. Led to role permission sprawl and violated the principle that each service should have the minimum necessary privileges.

**Resolution:** Worker uses `INGEST_DATABASE_URL` (connecting as `ingest_app`) with its own scoped grants. `mcp_app` reverted to SELECT-only on ingest tables.

**Prevention:**
- Every distinct workload (MCP server, ctrl-api, ingest worker) must have its own Postgres role with minimum necessary grants.
- Never expand an existing role's permissions as a shortcut — create the correct role from the start.
- Local dev `.env` must mirror the production role separation.

---

### [2026-03-24] EventSource API cannot set Authorization headers — SSE with JWTs leaks tokens in URLs

**Context:** Implemented SSE endpoint for real-time ingest progress. Browser `EventSource` API doesn't support custom headers, so the JWT was passed as a `?token=` query parameter.

**Symptoms:** JWT visible in proxy logs, browser history, and Vite dev server output. Violated defense-in-depth.

**Root Cause:** The `EventSource` browser API is inherently incompatible with `Authorization: Bearer` header auth. Any workaround (query param, cookie) either leaks the token or introduces session management complexity.

**Resolution:** Removed SSE entirely. Replaced with client-side polling of existing REST endpoints (`GET /api/ingests/runs/:runId` + `GET /api/ingests/runs/:runId/logs`) using standard `fetch` with `Authorization` header. Server-side SSE endpoint deleted.

**Prevention:**
- Do not use `EventSource` for authenticated endpoints that require Bearer tokens.
- When a browser API limitation forces credentials into URLs, the correct answer is to choose a different transport — not to work around it.
- Polling authenticated REST endpoints is simpler, secure by default, and sufficient for use cases where 2-second latency is acceptable.

---

### [2026-03-25] Cloud Run Jobs with all-traffic VPC egress can't reach Google APIs without Cloud DNS

**Context:** Ingest worker Cloud Run Job configured with `all-traffic` Direct VPC Egress on `sn-app`. KMS decrypt call timed out with `DEADLINE_EXCEEDED`.

**Symptoms:** `Total timeout of API google.cloud.kms.v1.KeyManagementService exceeded 60000 milliseconds`. The MCP server (Cloud Run Service) on the same subnet calls KMS without issues.

**Root Cause:** Cloud Run Services have built-in DNS resolution for Google APIs that routes through PGA automatically. Cloud Run Jobs with `all-traffic` VPC egress use the VPC's DNS resolution. Without a Cloud DNS private zone, `cloudkms.googleapis.com` resolved to public IPs. The deny-all-egress firewall blocked those, and the `gamma-allow-egress-google-apis` rule only allowed the PGA VIP range — which the public DNS didn't point to.

**Resolution:**
1. Created Cloud DNS private zone `googleapis-internal` on `gamma-vpc` mapping `*.googleapis.com` CNAME to `restricted.googleapis.com` and A records to `199.36.153.4/30` (restricted VIPs).
2. Added `199.36.153.4/30` to the `gamma-allow-egress-google-apis` firewall rule (was only `199.36.153.8/30`).
3. Kept `all-traffic` VPC egress so internet traffic routes through Cloud NAT with the static IP.

**Prevention:**
- When using `all-traffic` VPC egress with deny-all firewall, always create a Cloud DNS private zone for `googleapis.com` pointing to restricted or private VIPs.
- Cloud Run Services and Cloud Run Jobs have different DNS behavior under VPC egress — don't assume Services' behavior transfers to Jobs.
- Test Google API connectivity (KMS, Secret Manager) from a Job explicitly before deploying.

---

### [2026-03-27] OAuth callback 302 to custom URI scheme blocked by browsers
**Context:** MCP OAuth flow ends with a 302 redirect to `cursor://anysphere.cursor-mcp/oauth/callback?code=...` to pass the authorization code back to Cursor.
**Symptoms:** Users clicking "Connect" in Cursor saw a grey/blank page in the system browser. The MCP server-side flow completed correctly (code was generated), but Cursor never received the callback. Worked locally because Auth0 showed a consent dialog (user gesture); failed in production because Auth0 skipped consent (existing session) creating a fully automatic 302 chain.
**Root Cause:** Browsers silently block navigation to custom URI schemes (`cursor://`, `vscode://`, etc.) when the entire redirect chain completes without user interaction. A chain of automatic 302s (authorize → Auth0 → callback → cursor://) has no user gesture, so the final custom-scheme hop is blocked.
**Resolution:** Replaced bare 302 redirects with HTML interstitial pages (`renderRedirectPage`) at both the authorize→Auth0 step and the callback→cursor:// step. The page auto-redirects via JS and provides a clickable "Continue" button as fallback, giving the browser the user gesture it needs.
**Prevention:** Never use a bare 302 to redirect to a custom URI scheme. Always serve an HTML page with a visible link/button. This applies to any OAuth flow where the final redirect targets a non-HTTP scheme (Cursor, VS Code, Electron apps, etc.).
**Refs:** `src/modules/auth/auth/provider.ts`, `src/modules/auth/handlers/auth0-callback.ts`, `src/modules/auth/helpers/redirect-page.ts`

---

### [2026-04-06] Missing `DELETE` on `users` for `ctrl_app` blocked placeholder cleanup

**Context:** Control plane auth deletes pending-invite placeholder `users` rows when cleaning up state. Postgres grants for `ctrl_app` originally omitted **`DELETE` on `users`**.

**Symptoms:** Deletes failed at the database layer; affected users could get stuck with inconsistent invite state. In the worst case, auth repeatedly failed (**401** on `/api/*`) when the app could not remove a placeholder user tied to a pending invite flow.

**Root Cause:** `GRANT` list for `ctrl_app` included `SELECT`/`INSERT`/`UPDATE` on `users` but not `DELETE`. Any code path that must remove a user row (including placeholder users created before full signup) requires that privilege.

**Resolution:** Added `GRANT DELETE ON users TO ctrl_app` in **`labs-saas-ctrl/db/init.sql`**.

**Prevention:**
- When a role performs lifecycle cleanup on a table, verify **all** required DML grants (`DELETE` included), not only the happy-path `INSERT`/`UPDATE`.
- If auth or onboarding creates ephemeral rows in shared identity tables, treat **`DELETE`** as a first-class requirement for the application role.

**Refs:** `labs-saas-ctrl/db/init.sql` (grants for `ctrl_app`)

---

### [2026-04-13] Prod SPA deployed with gamma Auth0 client_id — Dockerfile default not overridden

**Context:** Deploying `ctrl-plane:v14` to the `prod-ctrl` Cloud Run service in `ai-5pm-mcp`. The Dockerfile has gamma-environment defaults for all `VITE_*` build args.

**Symptoms:** Users visiting `mcp.5pm.ai` and clicking login got "redirect_uri is not allowed" from Auth0. The SPA was redirecting to Auth0 with the gamma SPA client_id (`nEejna8VWdHg3GR56DK9pbG6lj828yYg`), whose allowed callbacks did not include `mcp.5pm.ai`.

**Root Cause:** The `docker buildx build` command for the prod SPA correctly overrode `VITE_AUTH0_AUDIENCE` and `VITE_APP_ORIGIN`, but **did not override `VITE_AUTH0_CLIENT_ID`**. The Dockerfile default (`nEejna8VWdHg3GR56DK9pbG6lj828yYg`) is the gamma SPA Auth0 app. The prod SPA Auth0 app (`nsflJdrV8RsRoc6qarMWjl934jZkZkt0`) was never referenced.

**Resolution:** Rebuilt `ctrl-plane:v15` with `--build-arg VITE_AUTH0_CLIENT_ID=nsflJdrV8RsRoc6qarMWjl934jZkZkt0` and all other prod build args. Deployed to `prod-ctrl`. Verified the live JS bundle contains the correct client_id.

**Prevention:**
- Updated `rotate-secrets.sh` with `--target prod` support and `--check-build-args` flag that curls the live SPA and verifies baked-in Auth0 client_id and audience match expected values per target.
- Prod builds must explicitly set **all** `VITE_*` build args — the Dockerfile defaults are gamma values. Documented the exact prod build command in `ROTATE_SECRETS.md`.
- Run `./scripts/rotate-secrets.sh --target all --check-build-args --validate` after any SPA deployment.

**Refs:** `scripts/rotate-secrets.sh`, `scripts/ROTATE_SECRETS.md`

---

### [2026-04-13] Multi-database namespace collision in persist_catalog
**Context:** Running production ingest on a Snowflake connector whose role had access to multiple databases.
**Symptoms:** `persist_catalog` stage threw `duplicate key value violates unique constraint "connector_columns_connector_id_schema_name_table_name_colum_key"`. Schemas like ANALYTICS, PUBLIC, MARKETING existed across multiple databases, producing identical (connector_id, schema_name, table_name, column_name) tuples.
**Root Cause:** The entire data pipeline — `SchemaInfo`/`ColumnInfo` types, `connector_columns` table, `scope_columns` table, SQL validator catalog keys, scope resolution, and sink vector metadata — used a 2-level namespace (schema.table) while Snowflake has a 3-level namespace (database.schema.table). When `discoverDatabases()` returned multiple databases, the flat schema list produced collisions.
**Resolution:** Added `database_name TEXT NOT NULL DEFAULT ''` to both `connector_columns` and `scope_columns` tables. Updated unique constraints to include `database_name`. Propagated `database` field through all warehouse types (`SchemaInfo`, `TableInfo`, `ColumnInfo`, `RelationshipInfo`), Snowflake connector methods, ingest pipeline (crawl, persist_catalog, documents, chunk, upsert), SQL validator (catalog keys, `extractTableRefs`, `resolveTableKey`, `buildScopeTableMap`), scope service (`UserScope`, `sanitizeSinkResults`), and saas-ctrl scope API/Zod schemas. BigQuery and ClickHouse connectors unaffected (single-database, empty `database_name`).
**Prevention:** Any future warehouse connector type that supports multi-database must propagate the `database` field. The `extractTableRefs` function handles both 2-part and 3-part SQL references via parser AST field detection (db vs schema).
**Refs:** persist_catalog fix, sql-validator update, saas-ctrl DDL migration

---

### [2026-04-14] saas-ctrl: databaseName missing from scope frontend + payload too large
**Context:** Follow-on from the multi-DB namespace fix above. The `database_name` column was added to backend tables and API Zod schemas, but the saas-ctrl SPA (`DashboardScopes.tsx`) was never updated.
**Symptoms:** Saving a user permission scope with many columns (10K+) returned 413 Payload Too Large. Multi-DB scopes silently lost `databaseName` (defaulted to `""` server-side). Row-by-row INSERT caused slow scope saves.
**Root Cause:** Three issues in saas-ctrl: (1) Express body limit 1MB too low. (2) Frontend types/keys/tree omitted `databaseName`. (3) `scope_columns` INSERT was row-by-row.
**Resolution:** (1) Body limit → 10MB. (2) `databaseName` added to `ApiScopeColumn`, `CatalogColumn`, `colKey` (5-segment), `parseColKey`, `catalogToTree`, ColumnTree UI. (3) Batch INSERT of 500 rows. E2E test with 10K columns.
**Prevention:** When propagating a new field through the backend, always audit the full frontend round-trip: types, key serialization, tree grouping, display, and test coverage.
**Refs:** saas-ctrl `server/src/routes/scopes.ts`, `src/pages/DashboardScopes.tsx`

---

### [2026-04-20] prod-mcp red dot from Cloud Run config drift vs gamma — 300s LB cut + throttled Redis sub

**Context:** Cursor users on `mcp.5pm.ai` reported the MCP toggle staying green but the status dot flipping red, with client logs showing `Streamable HTTP error: Failed to open SSE stream: <none>` and, later, recovered sessions 404-ing on subsequent requests. Previously fixed on gamma weeks ago; prod had the same symptoms because the gamma fix was never propagated.

**Symptoms:**
- Client: `Failed to open SSE stream: <none>` ~5 min after CreateClient success.
- Server access logs on `prod-mcp`: `GET /mcp` requests completing with status 200 and latency **exactly 301.000s** (three examples in one hour across Cursor + Claude clients), each paired with a Cloud Run `WARNING Truncated response body`.
- Separately: after the 5-min cut was fixed, some sessions still 404-ed on idle (`shttp.ts` path: `Session not live, returning 404 so client can re-initialize`) — `PUBSUB NUMSUB` on the session's channel had fallen to 0 despite `minScale=2`.

**Root Cause:** Two independent Cloud Run service-level config drifts between gamma and prod:

1. `timeoutSeconds=300` on `prod-mcp` (default) vs `3600` on `gamma-mcp`. The MCP Streamable HTTP transport opens a long-lived `GET /mcp` as the server→client SSE notification stream. Cloud Run's LB severs any request at `timeoutSeconds`, producing an incomplete SSE frame that the client logs as `<none>` status. Gamma had `3600` since at least March 27; prod stood up April 7 and inherited the 300s default.
2. `cpu-throttling=true` (default) on `prod-mcp`. `ServerRedisTransport` keeps a long-lived Redis pub/sub subscription per session (`mcp:shttp:toserver:{sessionId}`). Between requests, default Cloud Run throttles CPU on min instances to near-zero — the Node event loop can't service keepalives, Memorystore reaps the connection, the subscription disappears, and `isLive(sessionId)` returns false on the next request → 404.

**Resolution:** Two service-level flags on `prod-mcp`:
- `gcloud run services update prod-mcp --timeout=3600` (revision 00011)
- `gcloud run services update prod-mcp --no-cpu-throttling` (revision 00012)

Then **pinned both in `scripts/deploy-prod.sh`** on the `prod-mcp` update line so future image deploys re-assert them and can't silently drift back to defaults.

**Prevention:**
- Any Cloud Run service hosting a long-lived streaming endpoint (SSE, WebSocket-over-HTTP, MCP Streamable HTTP) must set `timeoutSeconds` above the intended stream lifetime — the default 300s is not survivable for notification channels.
- Any Cloud Run service holding persistent outbound connections (Redis pub/sub, long-poll subscriptions, background timers) between requests must set `--no-cpu-throttling`. Default CPU throttling will silently break these without error logs.
- All prod Cloud Run service config that diverges from defaults must be pinned in the deploy script, not just "set once in the cloud." Same principle as the Apr 13 Auth0 `VITE_*` build-arg lesson: prod state must be explicit and self-healing on every deploy.
- When a feature is added/fixed on gamma, audit the matching prod service config before closing the ticket. Revision-history parity check is cheap: `gcloud run revisions list --service=<svc> --format='table(..., spec.timeoutSeconds)'` across both projects.

**Refs:** `scripts/deploy-prod.sh` (prod-mcp pin block), `.vibemd/INFRASTRUCTURE.md` (prod-mcp row), `src/modules/mcp/handlers/shttp.ts` (isLive 404 path), `src/modules/mcp/services/redisTransport.ts` (ServerRedisTransport)
