# Testing

## Unit Tests

```bash
npm test
```

- Runner: Jest (ESM mode via `ts-jest`)
- Environment: Node
- Scope: `src/**/*.test.ts` (excludes `dist/`, `scratch/`)
- 6 suites, ~79 tests covering auth provider, auth service, Redis transport, SHTTP handler

No external services required — tests use mocks.

## E2E Tests

### Live Mode (recommended for local development)

Tests against the already-running local stack. Does not build, start, or kill anything.

```bash
npm run test:e2e:live           # all modes
npm run test:e2e:internal -- --live  # internal only
npm run test:e2e:external -- --live  # external only
```

**Prerequisites:**
- MCP server running: `npm run dev` (port 3232)
- Docker running: `docker compose up -d` (Postgres 5433, Redis 6379)

Live mode tests:
- OAuth metadata (RFC 8414) validity
- Protected Resource Metadata (RFC 9728) validity
- Dynamic Client Registration (DCR)
- PKCE challenge generation
- 401 rejection on unauthenticated `/mcp` requests
- WWW-Authenticate header correctness

Live mode does **not** test the authenticated MCP protocol flow because the running server uses real Auth0 (no mock IdP). Full authenticated testing — including OAuth flow, MCP tools, resources, and prompts — is covered by `labs-saas-ctrl`'s wizard e2e suite (see below).

### Standalone Mode (isolated, uses mock IdP from SDK scaffold)

```bash
npm run test:e2e           # all (internal + external auth modes)
npm run test:e2e:internal  # internal auth mode only
npm run test:e2e:external  # external auth mode only
```

Standalone mode builds the project, starts fresh server instances on port 8090 (not 3232), runs Playwright-based flows using the SDK's mock upstream IdP, and shuts down. **This mode is not compatible with the running local stack** — it manages its own server lifecycle.

### Full Integration Testing (via labs-saas-ctrl)

The canonical end-to-end integration test for the MCP server is the wizard e2e suite in `labs-saas-ctrl`. It exercises the full OAuth 2.1 flow with real Auth0, Playwright-driven browser login, and authenticated MCP protocol calls.

```bash
cd ../labs-saas-ctrl && npm run test:int:wizard
```

This covers:
- Real Auth0 OAuth flow (DCR + PKCE + Playwright headless browser login)
- MCP token exchange
- Authenticated tool/resource/prompt calls via the sandbox
- End-to-end integration with ctrl-api and the MCP server

See `labs-saas-ctrl/.vibemd/TESTING.md` for full prerequisites.

## Build Verification

```bash
npm run build   # tsc + copy-static + vite build (MCP app HTML)
npm run lint    # eslint
```

## Database Roles

| Role | Purpose | RLS |
|---|---|---|
| `mcp_admin` | Table owner, test cleanup, admin assertions | BYPASSRLS (local Docker) |
| `mcp_app` | MCP server application queries | Enforced |
| `ctrl_app` | Control plane API queries | Enforced |
| `ingest_app` | Ingest worker (least privilege) | Enforced |

Local `.env` uses `mcp_admin` for `DATABASE_ADMIN_URL`.

## Local Stack Prerequisites

All E2E testing (both repos) requires the shared local infrastructure:

```bash
# 1. Start Docker containers (from this repo — mounts both DB schemas)
docker compose up -d

# 2. Start MCP server
npm run dev                      # port 3232

# 3. Start ctrl-api (in labs-saas-ctrl)
cd ../labs-saas-ctrl/server && npm run dev   # port 8081

# 4. Stripe CLI (for billing tests in labs-saas-ctrl)
stripe listen --forward-to localhost:8081/api/webhooks/stripe
```

The `docker-compose.yml` in this repo mounts both `db/init.sql` (MCP schema) and `../labs-saas-ctrl/db/init.sql` (ctrl schema) into the Postgres container, so both schemas are initialized on first start.

## Testing Against gamma.5pm.ai (Cloud Dev)

See `labs-saas-ctrl/.vibemd/TESTING.md` § "Testing Against gamma.5pm.ai" for IAP tunnel setup and env patching instructions. The MCP e2e live mode can also test against gamma:

```bash
BASE_URI=https://gamma.5pm.ai npm run test:e2e:live
```

This verifies OAuth metadata, DCR, and 401 enforcement on the gamma MCP server. Full authenticated testing against gamma uses the saas-ctrl wizard e2e with patched `.env`.

## Testing Against mcp.5pm.ai (Production)

Same pattern as gamma but targeting the production project (`ai-5pm-mcp`).

### MCP protocol tests

```bash
BASE_URI=https://mcp.5pm.ai npm run test:e2e:live
```

### Full integration tests (via labs-saas-ctrl)

See `labs-saas-ctrl/.vibemd/TESTING.md` § "Testing Against mcp.5pm.ai" for IAP tunnel setup and env patching.

## Environment Reference

| Environment | Domain | GCP Project | DB Tunnel Port | Purpose |
|---|---|---|---|---|
| Local | `localhost:3232` / `localhost:8080` | N/A (Docker) | 5433 | Development |
| Gamma Cloud | `gamma.5pm.ai` | `ai-5pm-labs` | 5434 (IAP) | Cloud dev / staging |
| Production | `mcp.5pm.ai` | `ai-5pm-mcp` | 5435 (IAP) | Production |
