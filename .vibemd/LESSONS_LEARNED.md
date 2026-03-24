# Lessons Learned

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
