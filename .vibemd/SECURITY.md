# Security

## Authentication Flow

Two-layer OAuth 2.1 architecture:

1. **Layer 1 (MCP Clients -> MCP Server)**: DCR + Authorization Code + PKCE. Clients register via `POST /register`, then complete the OAuth flow. MCP server acts as both Authorization Server and Resource Server.
2. **Layer 2 (MCP Server -> Auth0)**: Standard OIDC redirect. During the authorize step, the user is redirected to Auth0 for login. Auth0 handles actual user authentication (Google or email/password). A single registered Auth0 application avoids client proliferation in the IdP.

## Token Management

- **Access tokens**: Opaque, 24-hour expiry (aligned with Auth0 upstream `token_lifetime`), stored encrypted (AES-256-CBC) in Redis. MCP clients (Cursor, Claude Code) do not currently use the refresh_token grant, so this is the effective session lifetime.
- **Refresh tokens**: Opaque, 30-day expiry, consumed atomically via Redis GETDEL to prevent rotation race conditions. Ready for clients that support the refresh_token grant.
- **Authorization codes**: 10-minute TTL, single-use enforced with optimistic concurrency (SET...GET)
- **Client registrations**: Stored in Postgres, deduplicated by `(client_name, redirect_uris_hash)` unique constraint

## Race Condition Mitigations

- **Refresh token rotation**: `GETDEL` ensures only one concurrent refresh succeeds
- **Authorization code exchange**: `SET ... KEEPTTL GET` detects concurrent use, revokes all tokens per RFC 6749 Section 4.1.2
- **Client registration dedup**: Postgres `UNIQUE` constraint + `ON CONFLICT` returns existing client

## Row-Level Security (RLS)

- All tables have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`
- Four Postgres roles: `mcp_admin` (table owner, bypasses RLS), `mcp_app` (MCP server application, RLS enforced), `ctrl_app` (control-plane API, broader ingest/run management), `ingest_app` (ingest worker, least privilege for pipeline + progress)
- Query wrapper `withUserContext(userId, fn)` sets `SET LOCAL app.user_id` per transaction
- **Current state**: Permissive `allow_all` default policies in `db/init.sql` grant `mcp_app` full access on all tables (`FOR ALL ... USING (true) WITH CHECK (true)`). These act as a structural placeholder until real user-scoped policies are added.
- **Warning**: `FORCE ROW LEVEL SECURITY` with zero policies denies all operations — even to role with table grants. Default permissive policies must exist before any query can succeed. Do not remove them without simultaneously adding replacement policies.

## Scope enforcement (column access)

- **Where it runs**: Scopes are enforced at the **MCP tool layer** (warehouse and sink query handlers in `services/mcp.ts`), not inside Snowflake/BigQuery/ClickHouse as native row/column grants. The warehouse still sees only SQL the MCP server has already validated or issued on behalf of an admin.
- **Data**: Scope definitions and allowlists live in Postgres (`scopes`, `scope_members`, `scope_columns`; see **DATA_MODEL.md**). **`mcp_app`** reads them with the same **`withUserContext`** session as other tenant-aware queries.
- **RLS**: Row-level policies on those tables scope which rows each user can read (e.g. team membership); enforcement of “which columns may appear in queries” is **application logic** (SQL validator + Pinecone metadata filter), not warehouse RLS.
- **Admins**: `org_admin` / `platform_admin` bypass column scope checks. Non-admin org users without a scope assignment get **deny-all** behavior for scoped query paths.

### SQL Validator hardening (2025-04-03 pen test remediation)

The SQL validator (`services/sql-validator.ts`) was hardened against 6 vulnerabilities found during an MCP exfil pen test:

| # | Vulnerability | Severity | Mitigation |
|---|---|---|---|
| 1 | CTE (`WITH`) bypass — CTE definitions not walked | Critical | Recursive AST walker validates all CTE bodies before the outer query |
| 2 | INFORMATION_SCHEMA bypass — unknown tables implicitly allowed | Critical | Deny-by-default: `resolveTableKey() === null` -> deny. System schema deny list (`information_schema`, `pg_catalog`, `account_usage`, etc.) |
| 3 | Subquery-in-WHERE — predicates never walked | High | Recursive walker traverses WHERE, HAVING, ORDER BY, GROUP BY for nested SELECTs |
| 4 | Scalar subquery-in-SELECT — non-`column_ref` expressions unchecked | High | Walker traverses all SELECT column expressions for nested SELECTs |
| 5 | Pinecone sink metadata leakage — `schema`/`table`/`content` unfiltered | Medium | Post-query `sanitizeSinkResults()` drops matches whose `schema.table` is not in the user's scope |
| 6 | Non-SELECT passthrough — validator `continue`d on non-select types | Medium | Non-SELECT statement types are rejected outright |

### Round 2 hardening (2025-04-03)

| # | Vulnerability | Severity | Mitigation |
|---|---|---|---|
| 7 | Column validation bypass — functions/aggregates/CASE/IF/STRUCT/window wrapping column_refs pass unchecked | High | `collectColumnRefs()` recursively extracts ALL `column_ref` nodes from any expression tree (function args, CASE branches, window specs, etc.) and validates each against scope. Applied to SELECT, HAVING, and ORDER BY. |
| 8 | Prompt info leak — `warehouse_guide`, `sink_guide`, `ingest_catalog_guide` use unscoped connector lists | Medium | Prompt handlers now use `getScopedConnectors()` and scope-filtered ingest catalog (same as tools/resources) |
| 9 | Error message oracle — denial errors reveal scope name and allowed table list | Low | Scope name and table list redacted from all error messages |
| 10 | Sink metadata column list — column names visible in metadata for in-scope tables | Low | `sanitizeSinkResults()` now also filters `columns` array in metadata to only scope-allowed columns |

### Round 3 hardening (2025-04-03)

| # | Vulnerability | Severity | Mitigation |
|---|---|---|---|
| 11 | WHERE column refs not validated — boolean oracle via `WHERE denied_col = 'x'`, LIKE, BETWEEN, REGEXP | Medium-High | `collectColumnRefs()` now applied to `s.where` |
| 12 | GROUP BY column refs not validated — cardinality inference of denied column distinct values | Medium-High | `collectColumnRefs()` now applied to `s.groupby` |
| 13 | Sink `content` text field leaks denied column names and types | Low | `content` field stripped from metadata for scoped users |

### Round 4 hardening (2025-04-03)

| # | Vulnerability | Severity | Mitigation |
|---|---|---|---|
| 14 | CTE column aliasing bypass — column validation only at top level, CTEs alias denied cols freely | Critical | Column validation moved into `validateSelectNode` — runs at every recursion depth (CTEs, derived tables, subqueries) |
| 15 | JOIN ON/USING condition bypass — FROM clause not column-validated | Medium-High | `collectColumnRefs` now applied to `fObj.on` and `fObj.using` inside FROM items |

### Round 5 hardening (2025-04-03)

| # | Vulnerability | Severity | Mitigation |
|---|---|---|---|
| 16 | USING clause strings bypass `collectColumnRefs` | Medium-High | `collectUsingColumns()` extracts column names from USING items (handles `{ type: "default", value: "..." }` AST shape) |
| 17 | CTE-qualified columns skip scope when `resolveTableKey` returns null | Medium-High | When table resolves to CTE/derived alias, column name is checked against catalog — if it matches a real column not in scope, denied |

**Design constraints preserved**:
- Admins (`org_admin`, `platform_admin`) still bypass all scope checks
- `SELECT *` rewrite to explicit scope-allowed columns still works at the top level
- CTE aliases and derived-table aliases are tracked and excluded from deny-by-default table checks
- Column validation at the top-level SELECT skips CTE-only FROM clauses (table-level security is enforced recursively inside CTEs)
- Depth limit (32) prevents stack overflow from deeply nested queries
- All dialect-specific AST shapes handled (BigQuery wraps column refs as objects, CTE bodies as `stmt.ast`)
- Functions wrapping only in-scope columns still pass (e.g. `UPPER(allowed_col)`, `MAX(allowed_col)`)

## Canonical User Identity

- Auth0 `sub` claim is mapped to an internal UUID in the `users` table
- All tables reference `users.id`, not the Auth0 sub directly
- Auth0 Account Linking action merges identities with the same verified email
- If the IdP changes, only the `users.auth_provider_id` mapping needs updating

## Cloud Armor (WAF)

GCP Cloud Armor security policy `gamma-waf-policy` (Standard tier) attached to all three LB backend services (`gamma-mcp-backend`, `gamma-ctrl-api-backend`, `gamma-ctrl-backend`).

### Origin Restriction

Only Cloudflare IPv4 ranges and GCP health-check probes (35.191.0.0/16, 130.211.0.0/22) are allowed at the LB. All other source IPs are denied with 403. This prevents direct-to-origin bypass of `34.54.83.204` — traffic must flow through Cloudflare.

### OWASP WAF Rules (Preview Mode)

Six preconfigured ModSecurity CRS rule sets are active in **preview mode** (log-only, no blocking). Monitor Cloud Armor logs for false positives before switching to enforce mode. Particular attention needed on `/mcp` and `/token` endpoints where JSON-RPC and OAuth payloads may trigger SQLi or XSS signatures.

| Priority | Rule Set | Description |
|---|---|---|
| 1000 | xss-v33-stable | Cross-site scripting |
| 1001 | sqli-v33-stable | SQL injection |
| 1002 | lfi-v33-stable | Local file inclusion |
| 1003 | rfi-v33-stable | Remote file inclusion |
| 1004 | protocolattack-v33-stable | Protocol attacks (HTTP request smuggling, response splitting) |
| 1005 | sessionfixation-v33-stable | Session fixation |

### Edge Rate Limiting

Not currently active at the Cloud Armor layer. Application-layer rate limiting via `express-rate-limit` is the primary mechanism (per-endpoint, per-IP). A Cloud Armor edge rate limit rule scoped to Cloudflare IPs can be added later if volumetric abuse is observed before reaching Cloud Run.

### Monitoring

LB logging is enabled at 100% sample rate on all three backend services. Cloud Armor logs are available in Cloud Logging under `resource.type="http_load_balancer"`. Filter by `jsonPayload.enforcedSecurityPolicy.name="gamma-waf-policy"`. Preview-mode WAF matches appear with `previewSecurityPolicy` instead of `enforcedSecurityPolicy`.

### Cloudflare IP Maintenance

The origin restriction allowlist uses a static set of Cloudflare IPv4 ranges. Cloudflare occasionally adds new ranges (published at `https://www.cloudflare.com/ips-v4/` and the API at `https://api.cloudflare.com/client/v4/ips`). If the policy falls behind, legitimate traffic is rejected with 403. Periodically verify the allowlist matches the current published ranges.

### Internal Service-to-Service via LB

The sandbox feature in ctrl-api connects to the MCP server at `MCP_BASE_URL/mcp`. In production this resolves through Cloudflare (`gamma.5pm.ai`), so traffic hairpins: ctrl-api → Cloud NAT → Cloudflare → LB → Cloud Armor → gamma-mcp. This is intentional — it lets the sandbox exercise the full end-to-end path users see. `MCP_BASE_URL` must always use the Cloudflare-proxied hostname, never the direct LB IP (`34.54.83.204`), or Cloud Armor's origin restriction will reject it.

## Firewall Egress Model

All internet egress uses **per-workload service account targeting** (not network tags). Each Cloud Run service/job has its own SA; the `gamma-allow-egress-internet-sn-app` firewall rule explicitly lists the SAs that need internet access (`sa-ingest-worker`, `sa-mcp-server`). To grant a new workload internet egress, add its SA to the rule. Internet egress is restricted to `tcp:443` (HTTPS only).

## Secrets Policy

- Never commit secrets. `.env` is gitignored.
- Auth0 client secret stored only in `.env` and Auth0 dashboard
- Postgres passwords in Docker compose use env var substitution with dev defaults

## Ingest Worker

- **Postgres connection**: The worker uses the dedicated **`ingest_app`** role (not `mcp_app`) via **`INGEST_DATABASE_URL`**. **`INGEST_USER_ID`** is passed from **ctrl-api** so each transaction can set RLS context (same `SET LOCAL app.user_id` pattern as the MCP app).
- **`ingest_app` grants**: Least privilege on ingest tables; **`ingest_app`** has **permissive `SELECT` on `team_members`** so RLS policies can use subqueries that reference membership without failing under `FORCE ROW LEVEL SECURITY`.
- **OpenAI API key**: In **Secret Manager** in production and **`.env`** locally; only **sa-ingest-worker** needs access (e.g. `secretAccessor` on the prod secret). The MCP server service account does not require it for normal operation.
- **Data scope**: The pipeline **never reads actual warehouse row data**—only **metadata** (e.g. **`INFORMATION_SCHEMA`** and connector catalog APIs). Generated documents come from schema and metadata descriptions, not bulk dumps.
- **Network**: Worker runs in the **same VPC** as other private services, with **no public ingress** (e.g. Cloud Run internal / controlled egress to Postgres and providers, consistent with the MCP service model).
