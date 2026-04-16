# File Structure

## Root

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Local dev infrastructure (Redis + Postgres) |
| `Dockerfile.worker` | Container image for **gamma-ingest-worker** (Cloud Run Job) |
| `db/init.sql` | Postgres schema init — roles, tables, RLS setup |
| `package.json` | Node.js dependencies and scripts |
| `tsconfig.json` | TypeScript compiler config |
| `jest.config.js` | Jest test runner config (ESM mode) |
| `vite.config.ts` | Vite bundler config for MCP app HTML assets |
| `eslint.config.mjs` | ESLint config |
| `.env.example` | Example environment variables (no secrets) |
| `CLAUDE.md` | Workspace rules for AI agents |

## `.vibemd/`

Living documentation maintained alongside code.

| File | Purpose |
|---|---|
| `RULES.md` | Commit discipline, file structure rules, execution discipline |
| `ARCHITECTURE.md` | System-level blueprint and component topology |
| `DATA_MODEL.md` | Postgres schema, Redis key structure |
| `FILE_STRUCTURE.md` | This file |
| `INFRASTRUCTURE.md` | Assets register (containers, Auth0 resources) |
| `INTEGRATIONS.md` | External system setup and auth config |
| `LESSONS_LEARNED.md` | Multi-session debugging log |
| `NETWORK.md` | Endpoints, ports, external service URLs |
| `PRD.md` | Product requirements |
| `PROMPTS.md` | Reusable prompt templates |
| `SECURITY.md` | Auth strategy, RLS, token management, race conditions |
| `TECH_STACK.md` | Approved technologies and versions |
| `TESTING.md` | Test suites, local and gamma e2e setup, DB roles |

## `src/`

### Entry Point

| File | Purpose |
|---|---|
| `src/index.ts` | Server startup — connects Redis/Postgres, mounts all modules |
| `src/config.ts` | Config singleton loaded from env vars (auth, auth0, redis, database) |

### `src/interfaces/`

| File | Purpose |
|---|---|
| `auth-validator.ts` | `ITokenValidator` interface + `InternalTokenValidator` + `ExternalTokenValidator` |

### `src/modules/auth/`

OAuth 2.1 authorization server module. Runs in-process (internal) or standalone (auth_server). Architecturally separate from MCP.

| File | Purpose |
|---|---|
| `index.ts` | `AuthModule` — Express router with all OAuth endpoints, introspection |
| `types.ts` | `McpInstallation`, `Auth0Installation`, `PendingAuthorization`, `TokenExchange` |
| `auth/auth-core.ts` | PKCE, token generation, AES-256-CBC encryption |
| `auth/provider.ts` | `FeatureReferenceAuthProvider` (OAuthServerProvider impl), `FeatureReferenceOAuthClientsStore` |
| `auth/provider.test.ts` | Unit tests for provider |
| `handlers/auth0-callback.ts` | Auth0 OIDC callback — exchanges code, upserts user in Postgres, issues MCP tokens |
| `services/auth.ts` | Unified service facade — routes client reg to Postgres (if ready), ephemeral data to Redis |
| `services/auth.test.ts` | Unit tests for auth service |
| `services/redis-auth.ts` | Redis-backed auth storage (pending auth, token exchange, installations, refresh tokens) |
| `services/pg-auth.ts` | Postgres-backed client registration with dedup via `(client_name, redirect_uris_hash)` |
| `static/mcp.png` | MCP logo served on auth pages |

### `src/modules/mcp/`

MCP protocol module. Transport-agnostic, depends only on `ITokenValidator`.

| File | Purpose |
|---|---|
| `index.ts` | `MCPModule` — Express router for `/mcp`, `/sse`, `/message` |
| `types.ts` | Shared MCP types |
| `handlers/shttp.ts` | Streamable HTTP transport handler |
| `handlers/shttp.test.ts` | Unit tests for SHTTP handler |
| `handlers/shttp.integration.test.ts` | Integration tests for SHTTP |
| `handlers/sse.ts` | Legacy SSE transport handler |
| `services/mcp.ts` | MCP server instance (tools, resources, prompts); warehouse/sink tool handlers enforce scopes (`resolveUserScope`, SQL validation, Pinecone metadata filters). Includes `list_connectors` tool for caching-client compatibility. |
| `services/mcp.test.ts` | Unit tests for MCP server — list_connectors tool, explore tool registration, stale-connector error handling |
| `services/scope.ts` | Scope resolution for MCP tools — `resolveUserScope`, `buildSinkFilter`, `getAllowedColumnsForConnector`, `getConnectorColumnsLookup` |
| `services/sql-validator.ts` | SQL parsing (`node-sql-parser`), `SELECT *` rewrite, column allowlisting against `connector_columns` |
| `services/redisTransport.ts` | `ServerRedisTransport` — pub/sub relay for SHTTP sessions |
| `services/redisTransport.test.ts` | Unit tests |
| `services/redisTransport.integration.test.ts` | Integration tests |

### `src/modules/shared/`

| File | Purpose |
|---|---|
| `redis.ts` | `RedisClientImpl`, `MockRedisClient`, `RedisClient` interface |
| `postgres.ts` | `pg` Pool, `initPostgres()`, `withUserContext()` RLS wrapper, `isPostgresReady()` |
| `logger.ts` | Structured JSON logger with Express middleware |

### `src/modules/example-apps/`

| File | Purpose |
|---|---|
| `index.ts` | `ExampleAppsModule` — mounts example MCP app servers at `/:slug/mcp` |

### `src/modules/warehouse/`

Multi-tenant warehouse query module. Strategy + registry pattern for connector extensibility.

| File | Purpose |
|---|---|
| `types.ts` | `WarehouseConnector` interface, `WarehouseResult`, type enums, `ConnectorFactory` |
| `registry.ts` | Map-based connector registry (no if/switch) |
| `crypto.ts` | `envelopeDecrypt` — GCP KMS envelope decryption for warehouse credentials |
| `service.ts` | `listWarehouses()`, `executeWarehouseQuery()` — orchestrator with RLS via `withUserContext` |
| `connectors/bigquery.ts` | BigQuery connector (self-registers) |
| `connectors/snowflake.ts` | Snowflake connector (self-registers) |
| `connectors/clickhouse.ts` | ClickHouse connector (self-registers) |

### `src/modules/sink/`

Multi-tenant vector store query module. Same strategy + registry pattern as warehouse.

| File | Purpose |
|---|---|
| `types.ts` | `SinkConnector` interface, `SinkResult`, `SinkMatch`, optional `filter` on `query` for metadata filtering, type enums, `SinkConnectorFactory` |
| `registry.ts` | Map-based sink connector registry |
| `service.ts` | `listSinks()`, `executeSinkQuery()`, `executeSinkTextQuery()` — orchestrator with RLS via `withUserContext`; threads optional scope `filter` to connectors |
| `connectors/pinecone.ts` | Pinecone connector (self-registers); passes metadata `filter` to query API |

### `src/modules/ingest/`

Ingest pipeline module: Cloud Run Job entry uses `src/ingest-worker.ts`; stage implementations live under `stages/`.

| File | Purpose |
|---|---|
| `types.ts` | Shared ingest types (runs, stages, pipeline context) |
| `pipeline.ts` | Orchestrates preflight → upsert; after crawl, persists discovered columns to `connector_columns` |
| `reporter.ts` | Writes `ingest_run_stages` / `ingest_run_logs` to Postgres |
| `embedder.ts` | Embedding HTTP client (direct `fetch`, no OpenAI SDK) |
| `stages/preflight.ts` | Preflight stage |
| `stages/crawl.ts` | Warehouse metadata crawl |
| `stages/relationships.ts` | Relationship discovery |
| `stages/documents.ts` | Document assembly |
| `stages/chunk.ts` | Chunking for embeddings |
| `stages/embed.ts` | Batch / call embedding API |
| `stages/upsert.ts` | Vector upsert via sink connector; vector metadata uses native arrays for `columns` / `relationships` (not `JSON.stringify`) |

### Ingest worker entrypoint

| File | Purpose |
|---|---|
| `src/ingest-worker.ts` | Cloud Run Job entrypoint — loads config, runs pipeline |

The **ingest-worker** container image is built from **`Dockerfile.worker`** (see [Root](#root), e.g. tag `ingest-worker:v1`).

### `src/apps/`

| File | Purpose |
|---|---|
| `warehouse/App.tsx` | React component for 5pm warehouse MCP app |
| `warehouse/mcp-app.html` | Bundled single-file MCP app HTML |

### `src/static/`

| File | Purpose |
|---|---|
| `index.html` | Server splash page |
| `styles.css` | Splash page styles |
| `5pm-logo-white.svg` | SVG brand logo (white fill, inverted via CSS for light theme) |
| `mcp.png` | MCP logo |
| `favicon-local.ico` | Favicon served in development (`NODE_ENV != production`) |
| `favicon-local.png` | Local favicon (PNG variant) |
| `favicon-prod.ico` | Favicon served in production (`NODE_ENV=production`) |
| `favicon-prod.png` | Production favicon (PNG variant) |
| `favicon-dev.png` | Dev favicon asset |

## `scripts/`

| File | Purpose |
|---|---|
| `rotate-secrets.sh` | Idempotent secret rotation — reads .env, pushes to Secret Manager, redeploys Cloud Run |
| `ROTATE_SECRETS.md` | Runbook: per-provider rotation procedures, mapping reference, safety guards |
| `test-e2e-all.sh` | Run all e2e test suites |
| `test-e2e-internal.sh` | e2e tests for internal auth mode |
| `test-e2e-external.sh` | e2e tests for external auth mode |

## `docs/`

| File | Purpose |
|---|---|
| `oauth-implementation.md` | OAuth implementation notes |
| `session-ownership.md` | Session ownership design notes |
