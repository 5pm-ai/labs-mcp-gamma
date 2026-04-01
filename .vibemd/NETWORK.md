# Network

## Production Traffic Flow

```
MCP Client (Cursor / Claude Code / Codex)
  │  HTTPS (Cloudflare edge cert)
  ▼
Cloudflare CDN/Proxy  (gamma.5pm.ai, A -> 34.54.83.204)
  │  HTTPS (Cloudflare Origin CA cert, Full SSL mode)
  ▼
GCP Global External Application Load Balancer
  │  Cloud Armor: gamma-waf-policy
  │    ├── Cloudflare IP restriction (non-CF sources → 403)
  │    └── OWASP WAF rules (preview mode — log only)
  │  Forwarding rule :443 -> HTTPS proxy -> URL map
  │  (HTTP :80 -> 301 redirect to HTTPS)
  ▼
Serverless NEG (gamma-mcp-neg, us-east4)
  │  Google internal ALTS encryption
  ▼
Cloud Run (gamma-mcp, ingress: internal-and-cloud-load-balancing)
  │  Direct VPC Egress (sn-app, 10.10.0.0/24)
  ├──→ Redis (10.20.1.3:6378, TLS)
  ├──→ Postgres (10.20.0.3:5432, SSL)
  └──→ Auth0 (via Cloud NAT, static IP 34.150.236.79)
```

## Endpoints

### MCP Server (production: https://gamma.5pm.ai)

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
| GET | `/favicon.ico` | Environment-aware favicon (local vs production) |
| GET | `/{slug}/mcp` | Example MCP App servers |

### External Services

| Service | URL | Purpose |
|---|---|---|
| Auth0 | `https://ai-5pm-labs.us.auth0.com/authorize` | User login redirect |
| Auth0 | `https://ai-5pm-labs.us.auth0.com/oauth/token` | Token exchange (server-side) |
| Auth0 | `https://ai-5pm-labs.us.auth0.com/.well-known/openid-configuration` | OIDC discovery |

### Infrastructure (Local Dev - Docker)

| Service | Container Port | Host Port | Purpose |
|---|---|---|---|
| Redis | 6379 | 6379 | Session/token cache, pub/sub |
| Postgres | 5432 | 5433 | Durable storage (client reg, users, teams) |

### Infrastructure (Production - GCP us-east4)

| Service | Private IP | Port | Purpose |
|---|---|---|---|
| Cloud SQL (gamma-pg) | 10.20.0.3 | 5432 | Durable storage (client reg, users, teams) |
| Memorystore (gamma-redis) | 10.20.1.3 | 6378 | Session/token cache, pub/sub, TLS enabled |
| Bastion (gamma-bastion) | 10.10.2.2 | 22 | SSH via IAP tunnel only |

### IP Addresses

| Name | IP | Purpose |
|---|---|---|
| gamma-lb-ip | 34.54.83.204 (global) | External LB frontend, Cloudflare A record target |
| gamma-nat-ip-1 | 34.150.236.79 (us-east4) | Cloud NAT egress, use for upstream IP whitelisting |

### VPC CIDR Plan

| Range | Purpose | Notes |
|---|---|---|
| 10.10.0.0/24 | sn-app (Cloud Run) | Direct VPC Egress |
| 10.10.1.0/24 | sn-data (reserved) | Future data tier workloads |
| 10.10.2.0/28 | sn-mgmt (bastion) | 16 IPs, management only |
| 10.20.0.0/16 | Private Service Access | Google-managed peering for Cloud SQL + Memorystore |

Non-overlapping ranges chosen to support future VPC peering with other projects.

## Ingest Worker Egress

| Path | Route | Notes |
|---|---|---|
| Worker → Postgres | Private IP, same VPC / PSA as **gamma-mcp** | Cloud SQL on `10.20.0.3:5432` (SSL). No public DB endpoint. |
| Worker → OpenAI API | Internet via **Cloud NAT** | Same static egress pattern as Auth0 (`gamma-nat-ip-1`); suitable for allowlisting. |
| Worker → Sink (Pinecone API) | Internet via **Cloud NAT** | HTTPS to Pinecone; not routed through the MCP load balancer. |

The ingest Cloud Run Job uses **Direct VPC Egress** on **sn-app** like **gamma-mcp**, so database traffic stays on private paths while provider APIs use controlled NAT egress.
