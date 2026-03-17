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
