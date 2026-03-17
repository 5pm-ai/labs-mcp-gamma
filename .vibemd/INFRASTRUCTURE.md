# Infrastructure & Assets Register

| Name/ID | Type | Purpose | Location/Path | Lifecycle | Owner | Date | Notes |
|---|---|---|---|---|---|---|---|
| redis (docker) | container | Session cache, pub/sub, ephemeral auth data | localhost:6379 | temp | dev | 2026-03-17 | `docker compose up -d` |
| postgres (docker) | container | Durable client registration, user identity | localhost:5433 | persistent | dev | 2026-03-17 | Volume: postgres-data |
| db/init.sql | schema | Postgres schema init (roles, tables, RLS) | db/init.sql | persistent | dev | 2026-03-17 | Auto-applied on first container start |
| Auth0 Action | action | Account Linking by Email | ai-5pm-labs.us.auth0.com | persistent | dev | 2026-03-17 | ID: 0bdb3e24-9c4a-4224-9414-bb000598fff2. Needs deployment. |
| Auth0 App (MCP Server) | application | Regular Web App for OIDC upstream | ai-5pm-labs.us.auth0.com | persistent | dev | 2026-03-17 | client_id: CDMzP2gS1aCz84Fy4GiAF22SB4WQmp3I |
| Auth0 App (M2M) | application | M2M for Account Linking Action | ai-5pm-labs.us.auth0.com | persistent | dev | 2026-03-17 | client_id: uviokzty2SoteJN7mW5OTiZ4vcsRWQ5l. Needs client grant. |
