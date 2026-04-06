-- MCP Server Database Schema
-- RLS-ready: tables have RLS enabled, policies added later.
-- Two roles: mcp_admin (table owner), mcp_app (application, RLS enforced).

-- Application role (RLS will be enforced for this role)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mcp_app') THEN
    CREATE ROLE mcp_app WITH LOGIN PASSWORD 'mcp_dev_password';
  END IF;
END
$$;

-- Allow mcp_app to connect
GRANT CONNECT ON DATABASE mcp TO mcp_app;

-- All tables live in public schema
GRANT USAGE ON SCHEMA public TO mcp_app;

-- =============================================================================
-- users: canonical identity, decoupled from external IdP identifiers
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_provider_id TEXT UNIQUE NOT NULL,
    email TEXT,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_auth_provider_id ON users (auth_provider_id);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- teams: future multi-tenant support (schema only, no CRUD yet)
-- =============================================================================
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- team_members: many-to-many users <-> teams
-- =============================================================================
CREATE TABLE IF NOT EXISTS team_members (
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members (user_id);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- oauth_clients: DCR client registrations (migrated from Redis)
-- =============================================================================
CREATE TABLE IF NOT EXISTS oauth_clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id TEXT UNIQUE NOT NULL,
    client_name TEXT,
    redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
    redirect_uris_hash TEXT NOT NULL,
    client_secret TEXT,
    client_secret_expires_at BIGINT,
    token_endpoint_auth_method TEXT,
    registration_blob JSONB NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    tenant_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_dedup
    ON oauth_clients (client_name, redirect_uris_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_user_id ON oauth_clients (user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_tenant_id ON oauth_clients (tenant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_last_used ON oauth_clients (last_used_at);

ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- Grants for mcp_app role
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO mcp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON teams TO mcp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_members TO mcp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_clients TO mcp_app;

-- =============================================================================
-- Default RLS policies (permissive)
-- Allows mcp_app full access. Replace with scoped policies when RLS
-- rules are defined (e.g., WHERE user_id = current_setting('app.user_id')).
-- =============================================================================
DROP POLICY IF EXISTS allow_all_users ON users;
CREATE POLICY allow_all_users ON users FOR ALL TO mcp_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS allow_all_teams ON teams;
CREATE POLICY allow_all_teams ON teams FOR ALL TO mcp_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS allow_all_team_members ON team_members;
CREATE POLICY allow_all_team_members ON team_members FOR ALL TO mcp_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS allow_all_oauth_clients ON oauth_clients;
CREATE POLICY allow_all_oauth_clients ON oauth_clients FOR ALL TO mcp_app USING (true) WITH CHECK (true);

-- =============================================================================
-- oauth_clients_stats: non-sensitive view for cross-service analytics
-- Exposes only timestamps needed for MCP client activity metrics.
-- Owned by mcp_admin so ctrl_app never sees client_secret or registration_blob.
-- =============================================================================
CREATE OR REPLACE VIEW oauth_clients_stats AS
    SELECT id, created_at, last_used_at
    FROM oauth_clients;
