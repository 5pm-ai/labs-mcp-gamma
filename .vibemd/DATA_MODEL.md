# Data Model

## Postgres Tables

### users
Canonical user identity, decoupled from external IdP identifiers.

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PK, DEFAULT gen_random_uuid() | Internal canonical identifier |
| auth_provider_id | TEXT | UNIQUE NOT NULL | Auth0 `sub` (e.g., `auth0\|abc123`) |
| email | TEXT | | User email from IdP |
| name | TEXT | | Display name from IdP |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

### teams
Future multi-tenant support (schema only, no CRUD).

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PK | Team identifier |
| name | TEXT | NOT NULL | Team name |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

### team_members
Many-to-many users-teams. Control plane **soft-deletes** memberships (`deleted_at`) instead of hard-deleting rows; **partial unique index** `idx_team_members_user_active` on `(user_id) WHERE deleted_at IS NULL` enforces **one active team per user**.

| Column | Type | Constraints | Description |
|---|---|---|---|
| team_id | UUID | FK teams(id) CASCADE | |
| user_id | UUID | FK users(id) CASCADE | |
| role | TEXT | NOT NULL DEFAULT 'member' | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| deleted_at | TIMESTAMPTZ | | Soft-remove; non-NULL = no longer an active member |

PK: `(team_id, user_id)`

### oauth_clients
DCR client registrations (migrated from Redis).

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PK | Internal row ID |
| client_id | TEXT | UNIQUE NOT NULL | OAuth client_id |
| client_name | TEXT | | From DCR request |
| redirect_uris | JSONB | NOT NULL | Array of redirect URIs |
| redirect_uris_hash | TEXT | NOT NULL | SHA256 of sorted redirect_uris |
| client_secret | TEXT | | Confidential client secret |
| client_secret_expires_at | BIGINT | | Unix timestamp |
| token_endpoint_auth_method | TEXT | | |
| registration_blob | JSONB | NOT NULL | Full OAuthClientInformationFull |
| user_id | UUID | FK users(id), NULLABLE | For future RLS scoping |
| tenant_id | UUID | FK teams(id), NULLABLE | For future team-scoped RLS |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| last_used_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

UNIQUE: `(client_name, redirect_uris_hash)` — deduplication constraint

## Redis Keys (Ephemeral)

| Prefix | Purpose | TTL |
|---|---|---|
| `auth:pending:` | Pending authorization (PKCE flow) | 10 min |
| `auth:exch:` | Authorization code -> access token | 10 min |
| `auth:installation:` | Access token -> McpInstallation | 30 days |
| `auth:refresh:` | Refresh token -> access token | 30 days |
| `session:{id}:owner` | Session ownership | 1 hour (TTL, refreshed on activity) |
| `mcp:shttp:*` | Streamable HTTP pub/sub | Session lifetime |

## Ingest Tables (defined in labs-saas-ctrl/db/init.sql, shared Postgres)

### ingests
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| team_id | UUID FK teams | ON DELETE CASCADE |
| warehouse_connector_id | UUID FK warehouse_connectors | ON DELETE RESTRICT |
| sink_connector_id | UUID FK sink_connectors | ON DELETE RESTRICT |
| name | TEXT NOT NULL | Pipeline display name |
| embedding_model | TEXT NOT NULL | Default 'text-embedding-3-small' |
| embedding_dimensions | INTEGER NOT NULL | Default 1536 |
| status | TEXT NOT NULL | 'idle', 'running', 'error' |
| last_run_id | UUID | Nullable, last completed/failed run |
| deleted_at | TIMESTAMPTZ | Nullable. Non-NULL = archived (soft-delete, irreversible) |
| archived_warehouse_name | TEXT | Snapshot of connector name at archive time |
| archived_sink_name | TEXT | Snapshot of connector name at archive time |
| created_at, updated_at | TIMESTAMPTZ | |

Note: `warehouse_connector_id` and `sink_connector_id` are nullable — NULLed on archive so connector RESTRICT FKs don't block deletion. MCP ingest catalog query uses JOIN (not LEFT JOIN), so archived pipelines are naturally excluded from MCP resources.

### ingest_runs
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| ingest_id | UUID FK ingests | ON DELETE CASCADE |
| trigger | TEXT NOT NULL | 'manual', 'scheduled' |
| status | TEXT NOT NULL | 'queued', 'running', 'completed', 'failed', 'cancelled' |
| started_at, completed_at | TIMESTAMPTZ | Nullable |
| error_message | TEXT | Nullable |
| schemas_discovered | INTEGER | Default 0 |
| tables_discovered | INTEGER | Default 0 |
| columns_discovered | INTEGER | Default 0 |
| relationships_discovered | INTEGER | Default 0 |
| documents_generated | INTEGER | Default 0 |
| chunks_created | INTEGER | Default 0 |
| vectors_embedded | INTEGER | Default 0 |
| vectors_upserted | INTEGER | Default 0 |
| total_tokens_used | INTEGER | Default 0 |
| created_at | TIMESTAMPTZ | |

### ingest_run_stages
| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| run_id | UUID FK ingest_runs | ON DELETE CASCADE |
| stage_key | TEXT NOT NULL | Machine key, e.g. 'crawl_schemas' |
| stage_label | TEXT NOT NULL | Human label, e.g. 'Crawl Schemas' |
| stage_order | INTEGER NOT NULL | Display ordering |
| status | TEXT NOT NULL | 'pending', 'running', 'done', 'failed', 'skipped' |
| started_at, completed_at | TIMESTAMPTZ | Nullable |
| items_processed | INTEGER | Default 0 |
| items_total | INTEGER | Nullable |
| error_message | TEXT | Nullable |
| metadata | JSONB | Default '{}' |
| UNIQUE | (run_id, stage_key) | |

### ingest_run_logs
| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL PK | |
| run_id | UUID FK ingest_runs | ON DELETE CASCADE |
| stage_key | TEXT | Nullable |
| level | TEXT NOT NULL | 'debug', 'info', 'warn', 'error' |
| message | TEXT NOT NULL | |
| metadata | JSONB | Default '{}' |
| created_at | TIMESTAMPTZ | |

### sink_connectors extensions
| Column | Type | Notes |
|--------|------|-------|
| embedding_model | TEXT | Nullable, added via ALTER |
| embedding_dimensions | INTEGER | Nullable, added via ALTER |

### connector_columns
Catalog of columns discovered per warehouse connector during ingest crawl. Populated by the ingest worker after the **crawl** stage (replace-all per `connector_id`). Used by MCP scope enforcement for SQL validation (allowed column sets per table) and to align with `connector_columns` grants in the control plane.

| Column | Type | Notes |
|--------|------|-------|
| connector_id | UUID | FK `warehouse_connectors` |
| database_name | TEXT | NOT NULL DEFAULT '', Snowflake database name (empty for single-DB connectors) |
| schema_name | TEXT | |
| table_name | TEXT | |
| column_name | TEXT | |
| data_type | TEXT | |
| is_primary_key | BOOLEAN | |
| is_nullable | BOOLEAN | |
| comment | TEXT | Nullable |

### scopes
Scope definitions (tenant-scoped permission bundles). Full DDL lives in **labs-saas-ctrl** `db/init.sql`; this MCP server reads rows via **`mcp_app`** (see [Postgres Roles for Ingest](#postgres-roles-for-ingest)).

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| name | TEXT | Display name (read by MCP for tooling) |

Additional columns (e.g. team ownership) are defined in saas-ctrl; MCP only selects `id` and `name` today.

### scope_members
Maps users to a single scope membership (enforced by unique index on `user_id`). A scope may have zero members (pre-configured but not yet assigned); unscoped org users retain normal unrestricted team access.

| Column | Type | Notes |
|--------|------|-------|
| user_id | UUID | FK `users` |
| scope_id | UUID | FK `scopes` |

### scope_columns
Column-level allowlist rows for a scope (warehouse connector + schema + table + column).

| Column | Type | Notes |
|--------|------|-------|
| scope_id | UUID | FK `scopes` |
| connector_id | UUID | FK `warehouse_connectors` |
| database_name | TEXT | NOT NULL DEFAULT '', matches connector_columns dimension |
| schema_name | TEXT | |
| table_name | TEXT | |
| column_name | TEXT | |

### Sink vector metadata (Pinecone)

Vectors upserted during ingest carry metadata used for retrieval and scope filtering. **`columns`** and **`relationships`** are stored as **native JSON arrays** in vector metadata (e.g. string array for column names; relationship strings like `schema.table.col->…`). They are **not** `JSON.stringify` single strings—older ingest runs may have used stringified JSON; new upserts use arrays.

### Postgres Roles for Ingest

| Role | Access |
|------|--------|
| ingest_app | SELECT on warehouse_connectors, sink_connectors, team_members (permissive); SELECT+UPDATE on ingests; SELECT+INSERT+UPDATE on ingest_runs, ingest_run_stages; SELECT+INSERT on ingest_run_logs. Application and MCP scope logic treat only **`team_members` rows with `deleted_at IS NULL`** as active memberships. |
| ctrl_app | Full CRUD on ingests, SELECT+INSERT+UPDATE on ingest_runs, SELECT on stages/logs, **SELECT on `oauth_clients_stats` view** (platform admin analytics — view exposes only `id`, `created_at`, `last_used_at`) |
| mcp_app | SELECT on ingests, ingest_runs (read-only for tool awareness); **SELECT on `connector_columns`, `scopes`, `scope_members`, `scope_columns`** (scope resolution and SQL validation). `warehouse_connectors` SELECT includes `has_write_access` and `write_access_acknowledged` columns. Write-capable credentials are now hard-denied at connector creation (HTTP 403); `write_access_acknowledged` is deprecated (always `false`). |
