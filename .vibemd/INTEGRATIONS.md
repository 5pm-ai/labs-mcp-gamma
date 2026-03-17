# Integrations

## Auth0

- **Tenant**: `ai-5pm-labs.us.auth0.com`
- **CLI**: `auth0` CLI authenticated and active on this tenant (`auth0 tenants list` to verify)
- **Connections**: `google-oauth2` (Google social login), `Username-Password-Authentication` (email/password)
- **Application**: "MCP Server (labs-mcp-gamma)" — Regular Web App, client_id in `.env`
- **Account Linking Action**: "Account Linking by Email" — post-login action that merges accounts with the same verified email. Requires M2M app "Account Linking Action (M2M)" with `read:users` + `update:users` grants on the Management API. Action secrets: `DOMAIN`, `CLIENT_ID`, `CLIENT_SECRET`.
- **Setup**: To complete action deployment, re-authenticate auth0 CLI with `create:client_grants` scope, then deploy and bind the action to the login trigger.

## Redis

- Local Docker container via `docker compose up -d`
- Port: 6379
- No auth in dev (password optional via `REDIS_PASSWORD` env var)

## Postgres

- Local Docker container via `docker compose up -d`
- Host port: 5433 (mapped from container 5432 to avoid conflicts with local Postgres installs)
- Superuser: `mcp_admin` / `mcp_dev_password`
- App user: `mcp_app` / `mcp_dev_password` (RLS enforced)
- Database: `mcp`
- Schema initialized by `db/init.sql` on first container start
