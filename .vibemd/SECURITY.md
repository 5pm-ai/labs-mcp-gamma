# Security

## Authentication Flow

Two-layer OAuth 2.1 architecture:

1. **Layer 1 (MCP Clients -> MCP Server)**: DCR + Authorization Code + PKCE. Clients register via `POST /register`, then complete the OAuth flow. MCP server acts as both Authorization Server and Resource Server.
2. **Layer 2 (MCP Server -> Auth0)**: Standard OIDC redirect. During the authorize step, the user is redirected to Auth0 for login. Auth0 handles actual user authentication (Google or email/password). A single registered Auth0 application avoids client proliferation in the IdP.

## Token Management

- **Access tokens**: Opaque, 1-hour expiry, stored encrypted (AES-256-CBC) in Redis
- **Refresh tokens**: Opaque, 7-day expiry, consumed atomically via Redis GETDEL to prevent rotation race conditions
- **Authorization codes**: 10-minute TTL, single-use enforced with optimistic concurrency (SET...GET)
- **Client registrations**: Stored in Postgres, deduplicated by `(client_name, redirect_uris_hash)` unique constraint

## Race Condition Mitigations

- **Refresh token rotation**: `GETDEL` ensures only one concurrent refresh succeeds
- **Authorization code exchange**: `SET ... KEEPTTL GET` detects concurrent use, revokes all tokens per RFC 6749 Section 4.1.2
- **Client registration dedup**: Postgres `UNIQUE` constraint + `ON CONFLICT` returns existing client

## Row-Level Security (RLS)

- All tables have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`
- Two Postgres roles: `mcp_admin` (table owner, bypasses RLS), `mcp_app` (application, RLS enforced)
- Query wrapper `withUserContext(userId, fn)` sets `SET LOCAL app.user_id` per transaction
- **Current state**: Permissive `allow_all` default policies in `db/init.sql` grant `mcp_app` full access on all tables (`FOR ALL ... USING (true) WITH CHECK (true)`). These act as a structural placeholder until real user-scoped policies are added.
- **Warning**: `FORCE ROW LEVEL SECURITY` with zero policies denies all operations — even to role with table grants. Default permissive policies must exist before any query can succeed. Do not remove them without simultaneously adding replacement policies.

## Canonical User Identity

- Auth0 `sub` claim is mapped to an internal UUID in the `users` table
- All tables reference `users.id`, not the Auth0 sub directly
- Auth0 Account Linking action merges identities with the same verified email
- If the IdP changes, only the `users.auth_provider_id` mapping needs updating

## Secrets Policy

- Never commit secrets. `.env` is gitignored.
- Auth0 client secret stored only in `.env` and Auth0 dashboard
- Postgres passwords in Docker compose use env var substitution with dev defaults
