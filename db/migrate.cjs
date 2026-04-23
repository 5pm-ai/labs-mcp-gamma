const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

// Apply SQL files in order. Each file is idempotent.
// - init.sql       : MCP schema (always present in this repo)
// - ctrl-init.sql  : labs-saas-ctrl/db/init.sql, copied into db/ at deploy
//                    time by scripts/deploy-{gamma,prod}.sh so a single
//                    db-migrate Cloud Run Job covers both schemas.
//                    Optional locally (docker-compose bootstraps both files
//                    via its own init mechanism).
const FILES_IN_ORDER = ["init.sql", "ctrl-init.sql"];

async function applyFile(client, fileName) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) {
    console.log(`Skipping ${fileName} (not present in image)`);
    return { applied: false, bytes: 0 };
  }
  const sql = fs.readFileSync(filePath, "utf8");
  const bytes = Buffer.byteLength(sql, "utf8");
  console.log(`Applying ${fileName} (${bytes} bytes)...`);
  await client.query(sql);
  console.log(`Applied ${fileName}`);
  return { applied: true, bytes };
}

async function main() {
  const connString = process.env.DATABASE_ADMIN_URL;
  if (!connString) {
    console.error("DATABASE_ADMIN_URL is not set");
    process.exit(1);
  }

  const client = new Client({ connectionString: connString });
  await client.connect();
  console.log("Connected to database");

  let appliedCount = 0;
  for (const fileName of FILES_IN_ORDER) {
    const { applied } = await applyFile(client, fileName);
    if (applied) appliedCount += 1;
  }

  await client.end();
  if (appliedCount === 0) {
    console.error("No SQL files were applied — image is missing init.sql");
    process.exit(1);
  }
  console.log(`Migration complete: ${appliedCount} file(s) applied`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
