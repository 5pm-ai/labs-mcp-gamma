const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

async function main() {
  const connString = process.env.DATABASE_ADMIN_URL;
  if (!connString) {
    console.error("DATABASE_ADMIN_URL is not set");
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, "init.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  const client = new Client({ connectionString: connString });
  await client.connect();
  console.log("Connected to database");

  await client.query(sql);
  console.log("Schema applied successfully");

  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
