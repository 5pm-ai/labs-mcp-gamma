# Tech Stack

| Technology | Version | Purpose |
|---|---|---|
| Node.js | >= 22.x | Runtime |
| TypeScript | ^5.7 | Language |
| Express | ^4.21 | HTTP server |
| @modelcontextprotocol/sdk | 1.24.2 | MCP protocol, OAuth router, Streamable HTTP |
| Redis | 7.2 (Docker) | Session pub/sub, ephemeral auth flow data, token cache |
| Postgres | 16 (Docker) | Durable client registrations, user identity, RLS-ready |
| pg (node-postgres) | latest | Postgres client |
| Auth0 | SaaS (ai-5pm-labs.us.auth0.com) | Upstream identity provider (OIDC) |
| Zod | ^3.25 | Runtime validation |
| Docker Compose | v2 | Local infrastructure (Redis + Postgres) |
| GCP Cloud Run | managed | Production compute (MCP server + migration jobs) |
| GCP Cloud SQL | PostgreSQL 16 | Production database (private IP, VPC-only) |
| GCP Memorystore | Redis 7.2 | Production cache/pub-sub (private IP, TLS) |
| GCP External LB | EXTERNAL_MANAGED | Production ingress (HTTPS, serverless NEG) |
| GCP Cloud NAT | managed | Outbound internet for private resources |
| GCP Artifact Registry | Docker | Container image storage |
| GCP Secret Manager | managed | Production secrets (DB URLs, Auth0, Redis CA) |
| Cloudflare | CDN/DNS/Proxy | DNS, TLS termination (Full SSL, Origin CA) |
