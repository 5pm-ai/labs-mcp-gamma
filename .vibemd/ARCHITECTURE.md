# Architecture

## System Overview

```
MCP Clients (Cursor, Claude Code, Codex)
    |
    |  DCR + OAuth 2.1 (PKCE)
    |  Streamable HTTP (Bearer token)
    v
+----------------------------------------------+
|  MCP Server (Express)                        |
|                                              |
|  +-----------+   +----------+   +----------+ |
|  | Auth      |   | MCP      |   | Metadata | |
|  | Module    |   | Module   |   | (RFC     | |
|  | /register |   | /mcp     |   |  9728 +  | |
|  | /authorize|   | /sse     |   |  8414)   | |
|  | /token    |   |          |   |          | |
|  | /introspect   |          |   |          | |
|  | /revoke   |   |          |   |          | |
|  | /auth0/cb |   |          |   |          | |
|  +-----------+   +----------+   +----------+ |
|       |               |                      |
+-------|---------------|----------------------+
        |               |
   +----+----+     +----+----+
   |         |     |         |
   v         v     v         |
+------+  +------+ +------+  |
|Postgr|  |Redis | |Redis |  |
|es    |  |(auth)|  |(pub/ |  |
|(client|  |      | | sub) |  |
| reg) |  |      | |      |  |
+------+  +------+ +------+  |
                              |
             Auth0            |
         (OIDC login) <------+
         ai-5pm-labs.us.auth0.com
```

## Auth Modes

| Mode | Auth Endpoints | MCP Endpoints | Token Validation |
|---|---|---|---|
| `internal` | In-process | In-process | Direct method call |
| `external` | Separate server | In-process | HTTP introspection |
| `auth_server` | In-process | None | N/A |

## Data Flow: Authentication

1. MCP client calls `POST /mcp` without token
2. Server returns `401` with `WWW-Authenticate` pointing to `/.well-known/oauth-protected-resource`
3. Client discovers auth server via Protected Resource Metadata (RFC 9728)
4. Client registers via `POST /register` (DCR) — deduplicated in Postgres
5. Client redirects user to `GET /authorize`
6. Server redirects user to Auth0 (`https://ai-5pm-labs.us.auth0.com/authorize`)
7. User authenticates (Google or email/password)
8. Auth0 Account Linking action merges identities
9. Auth0 redirects to `/auth0/callback` with authorization code
10. Server exchanges Auth0 code for tokens, upserts user in Postgres
11. Server generates MCP tokens, stores in Redis, redirects to MCP client
12. MCP client exchanges MCP authorization code for access token
13. MCP client calls `POST /mcp` with `Authorization: Bearer <token>`

## Storage Split

- **Postgres**: Client registrations, user identity, teams (durable, queryable, RLS-ready)
- **Redis**: Auth flow state, tokens, sessions, pub/sub (ephemeral, fast, TTL-based)
