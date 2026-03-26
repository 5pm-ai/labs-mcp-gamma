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
Many-to-many users-teams.

| Column | Type | Constraints | Description |
|---|---|---|---|
| team_id | UUID | FK teams(id) CASCADE | |
| user_id | UUID | FK users(id) CASCADE | |
| role | TEXT | NOT NULL DEFAULT 'member' | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

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
| `auth:installation:` | Access token -> McpInstallation | 7 days |
| `auth:refresh:` | Refresh token -> access token | 7 days |
| `session:{id}:owner` | Session ownership | Session lifetime |
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

### Postgres Roles for Ingest

| Role | Access |
|------|--------|
| ingest_app | SELECT on warehouse_connectors, sink_connectors, team_members (permissive); SELECT+UPDATE on ingests; SELECT+INSERT+UPDATE on ingest_runs, ingest_run_stages; SELECT+INSERT on ingest_run_logs |
| ctrl_app | Full CRUD on ingests, SELECT+INSERT+UPDATE on ingest_runs, SELECT on stages/logs |
| mcp_app | SELECT on ingests, ingest_runs (read-only for tool awareness) |
