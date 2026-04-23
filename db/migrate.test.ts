import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Integration test for db/migrate.cjs. Runs against the local docker-compose
// Postgres (postgres://mcp_admin:mcp_dev_password@localhost:5433/mcp).
//
// Skipped if the database is unreachable, so this file is safe to include in
// `npm test` without breaking CI or environments where the local stack isn't
// running.
//
// Covers:
//   1. DATABASE_ADMIN_URL is required.
//   2. Without ctrl-init.sql: only mcp init.sql is applied.
//   3. With ctrl-init.sql: both are applied in order and the combined schema
//      is present on the database.
//   4. Second run is a no-op (idempotent).

const MIGRATE_SCRIPT = join(__dirname, "migrate.cjs");
const MCP_DB_DIR = __dirname;
const CTRL_INIT_PATH = join(MCP_DB_DIR, "ctrl-init.sql");
const CTRL_INIT_SRC = join(
  __dirname,
  "..",
  "..",
  "labs-saas-ctrl",
  "db",
  "init.sql"
);

const DB_URL =
  process.env.MIGRATE_TEST_DATABASE_URL ||
  "postgresql://mcp_admin:mcp_dev_password@localhost:5433/mcp";

async function dbReachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

async function tableExists(name: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [name]
    );
    return (res.rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}

function runMigrate(env: Record<string, string | undefined>) {
  return spawnSync("node", [MIGRATE_SCRIPT], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("db/migrate.cjs", () => {
  let reachable = false;
  let ctrlExistedBefore = false;

  beforeAll(async () => {
    reachable = await dbReachable();
  });

  beforeEach(() => {
    ctrlExistedBefore = existsSync(CTRL_INIT_PATH);
  });

  afterEach(() => {
    if (!ctrlExistedBefore && existsSync(CTRL_INIT_PATH)) {
      unlinkSync(CTRL_INIT_PATH);
    }
  });

  test("fails fast when DATABASE_ADMIN_URL is not set", () => {
    const res = runMigrate({ DATABASE_ADMIN_URL: "" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/DATABASE_ADMIN_URL is not set/);
  });

  test("applies only init.sql when ctrl-init.sql is absent", async () => {
    if (!reachable) {
      console.warn(`Skipping: ${DB_URL} unreachable`);
      return;
    }
    if (ctrlExistedBefore) unlinkSync(CTRL_INIT_PATH);

    const res = runMigrate({ DATABASE_ADMIN_URL: DB_URL });
    expect(res.stdout + res.stderr).toContain("Applying init.sql");
    expect(res.stdout).toContain("Skipping ctrl-init.sql");
    expect(res.stdout).toContain("1 file(s) applied");
    expect(res.status).toBe(0);

    // MCP schema must be present.
    expect(await tableExists("oauth_clients")).toBe(true);
    expect(await tableExists("users")).toBe(true);
  });

  test("applies mcp then ctrl init.sql when both present, and is idempotent", async () => {
    if (!reachable) {
      console.warn(`Skipping: ${DB_URL} unreachable`);
      return;
    }
    // Stage the real ctrl init.sql the same way the deploy script does.
    expect(existsSync(CTRL_INIT_SRC)).toBe(true);
    writeFileSync(CTRL_INIT_PATH, readFileSync(CTRL_INIT_SRC));

    const first = runMigrate({ DATABASE_ADMIN_URL: DB_URL });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("2 file(s) applied");

    // Order check: "Applying init.sql" must appear before "Applying ctrl-init.sql".
    const mcpIdx = first.stdout.indexOf("Applying init.sql");
    const ctrlIdx = first.stdout.indexOf("Applying ctrl-init.sql");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(ctrlIdx).toBeGreaterThan(mcpIdx);

    // Both schemas should be present.
    expect(await tableExists("oauth_clients")).toBe(true); // mcp
    expect(await tableExists("warehouse_connectors")).toBe(true); // ctrl
    expect(await tableExists("warehouse_keypairs")).toBe(true); // ctrl (the Apr-21 gap)
    expect(await tableExists("scopes")).toBe(true); // ctrl

    // Second run must also succeed — the whole point is idempotency.
    const second = runMigrate({ DATABASE_ADMIN_URL: DB_URL });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("2 file(s) applied");
  });
});
