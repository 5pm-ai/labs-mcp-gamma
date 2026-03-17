# Network

## Endpoints

### MCP Server (default port 3232)

| Method | Path | Purpose |
|---|---|---|
| POST | `/register` | OAuth DCR — client registration |
| GET/POST | `/authorize` | OAuth authorization (redirects to Auth0) |
| POST | `/token` | OAuth token exchange |
| POST | `/introspect` | Token introspection (RFC 7662) |
| POST | `/revoke` | Token revocation |
| GET | `/auth0/callback` | Auth0 OIDC callback |
| GET/POST/DELETE | `/mcp` | Streamable HTTP MCP transport |
| GET | `/sse` | Legacy SSE transport |
| POST | `/message` | Legacy SSE message endpoint |
| GET | `/.well-known/oauth-protected-resource` | Protected Resource Metadata (RFC 9728) |
| GET | `/.well-known/oauth-authorization-server` | Authorization Server Metadata (RFC 8414) |
| GET | `/{slug}/mcp` | Example MCP App servers |

### External Services

| Service | URL | Purpose |
|---|---|---|
| Auth0 | `https://ai-5pm-labs.us.auth0.com/authorize` | User login redirect |
| Auth0 | `https://ai-5pm-labs.us.auth0.com/oauth/token` | Token exchange (server-side) |
| Auth0 | `https://ai-5pm-labs.us.auth0.com/.well-known/openid-configuration` | OIDC discovery |

### Infrastructure (Docker)

| Service | Container Port | Host Port | Purpose |
|---|---|---|---|
| Redis | 6379 | 6379 | Session/token cache, pub/sub |
| Postgres | 5432 | 5433 | Durable storage (client reg, users, teams) |
