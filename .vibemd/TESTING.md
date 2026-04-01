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

```bash
npm run test:e2e           # all (internal + external auth modes)
npm run test:e2e:internal  # internal auth mode only
npm run test:e2e:external  # external auth mode only
```

Scripts in `scripts/`. These start the MCP server, run Playwright-based flows, and shut down.

### Prerequisites

- Docker running (Postgres on 5433, Redis on 6379 via `docker compose up -d`)
- `.env` populated (Auth0 credentials, database URLs)

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
