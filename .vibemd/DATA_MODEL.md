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
