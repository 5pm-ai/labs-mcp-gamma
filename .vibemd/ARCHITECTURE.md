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

## Production Deployment (GCP us-east4)

```
MCP Clients (Cursor, Claude Code, Codex)
    |
    |  HTTPS (Cloudflare edge cert)
    v
Cloudflare CDN/Proxy  (gamma.5pm.ai)
    |
    |  HTTPS (Origin CA cert, Full SSL)
    v
GCP Global External Application LB  (34.54.83.204)
    |  HTTP :80 -> 301 HTTPS redirect
    |  HTTPS :443 -> serverless NEG
    v
Cloud Run (gamma-mcp)
    |  ingress: internal-and-cloud-load-balancing
    |  Direct VPC Egress (sn-app, 10.10.0.0/24)
    |
    +---> Memorystore Redis (10.20.1.3:6378, TLS)
    +---> Cloud SQL Postgres (10.20.0.3:5432, SSL)
    +---> Auth0 (via Cloud NAT, static IP 34.150.236.79)

Cloud Run Job (db-migrate)
    |  Direct VPC Egress (sn-app)
    +---> Cloud SQL Postgres (admin connection)

Bastion (10.10.2.2, sn-mgmt)
    |  IAP TCP tunnel only, no public IP
    +---> SSH via gcloud compute ssh --tunnel-through-iap
```

### Key Design Decisions

- **No public IPs** on any workload, database, or cache instance
- **Deny-all-by-default** firewall with explicit allow rules per purpose
- **Cloudflare Origin CA** avoids Google-managed cert provisioning issues with CF proxy
- **Direct VPC Egress** over VPC Connectors — lower latency, lower cost, GA since 2024
- **Cloud NAT with static IP** enables upstream IP whitelisting
- **VPC peering-ready** — custom-mode VPC with non-overlapping CIDRs (10.10.x.x for subnets, 10.20.x.x for PSA)
