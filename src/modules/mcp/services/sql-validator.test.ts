import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import type { UserScope } from "./scope.js";

// ── Catalog: tables the warehouse connector has discovered ─────────────────
const CATALOG_ROWS = [
  { schema_name: "schema_a", table_name: "table_1", column_name: "col_a" },
  { schema_name: "schema_a", table_name: "table_1", column_name: "col_b" },
  { schema_name: "schema_a", table_name: "table_1", column_name: "col_c" },
  { schema_name: "schema_a", table_name: "table_1", column_name: "secret_col" },
  { schema_name: "schema_b", table_name: "secret_table", column_name: "x" },
  { schema_name: "schema_b", table_name: "secret_table", column_name: "y" },
];

const mockQuery = jest.fn();

jest.unstable_mockModule("../../shared/postgres.js", () => ({
  withUserContext: jest.fn(async (_userId: unknown, fn: unknown) =>
    (fn as (client: { query: typeof mockQuery }) => unknown)({ query: mockQuery }),
  ),
}));

const { validateAndRewriteSql } = await import("./sql-validator.js");
const { sanitizeSinkResults } = await import("./scope.js");

// ── Fixtures ───────────────────────────────────────────────────────────────

const USER_ID = "user-1";
const CONNECTOR_ID = "conn-1";

const SCOPE: UserScope = {
  scopeId: "scope-1",
  scopeName: "Marketing Analyst",
  warehouseConnectorIds: [CONNECTOR_ID],
  sinkConnectorIds: ["sink-1"],
  columns: [
    { connectorId: CONNECTOR_ID, schemaName: "schema_a", tableName: "table_1", columnName: "col_a" },
    { connectorId: CONNECTOR_ID, schemaName: "schema_a", tableName: "table_1", columnName: "col_b" },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function setupMockQuery() {
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes("warehouse_connectors")) {
      return { rows: [{ type: "bigquery" }] };
    }
    if (sql.includes("connector_columns")) {
      return { rows: CATALOG_ROWS };
    }
    return { rows: [] };
  });
}

async function validate(sql: string, scope = SCOPE) {
  return validateAndRewriteSql(USER_ID, CONNECTOR_ID, sql, scope);
}

// ── SQL Validator Tests ────────────────────────────────────────────────────

describe("sql-validator (pen test remediations)", () => {
  beforeEach(setupMockQuery);

  // ── Vuln #6: Non-SELECT passthrough ──────────────────────────────────
  describe("#6: non-SELECT rejection", () => {
    it("rejects INSERT", async () => {
      const r = await validate("INSERT INTO schema_a.table_1 (col_a) VALUES ('x')");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/Only SELECT/i);
    });

    it("rejects DELETE", async () => {
      const r = await validate("DELETE FROM schema_a.table_1 WHERE col_a = 'x'");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/Only SELECT|Could not parse/i);
    });

    it("rejects UPDATE", async () => {
      const r = await validate("UPDATE schema_a.table_1 SET col_a = 'y'");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/Only SELECT|Could not parse/i);
    });
  });

  // ── Vuln #2: INFORMATION_SCHEMA / deny-by-default ────────────────────
  describe("#2: INFORMATION_SCHEMA and deny-by-default", () => {
    it("blocks INFORMATION_SCHEMA.TABLES", async () => {
      const r = await validate("SELECT table_name FROM INFORMATION_SCHEMA.TABLES");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/system table|not in the data catalog/i);
    });

    it("blocks INFORMATION_SCHEMA.COLUMNS", async () => {
      const r = await validate("SELECT column_name FROM INFORMATION_SCHEMA.COLUMNS");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/system table|not in the data catalog/i);
    });

    it("blocks unknown tables not in catalog (deny-by-default)", async () => {
      const r = await validate("SELECT x FROM completely_unknown_table");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/not in the data catalog/i);
    });

    it("blocks tables in catalog but not in scope", async () => {
      const r = await validate("SELECT x FROM schema_b.secret_table");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/not in your scope/i);
    });
  });

  // ── Vuln #1: CTE (WITH clause) bypass ────────────────────────────────
  describe("#1: CTE bypass", () => {
    it("blocks CTE referencing out-of-scope table", async () => {
      const r = await validate(
        "WITH leak AS (SELECT x FROM schema_b.secret_table) SELECT x FROM leak",
      );
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/schema_b\.secret_table/i);
    });

    it("blocks nested CTE referencing out-of-scope table", async () => {
      const r = await validate(
        `WITH step1 AS (SELECT col_a FROM schema_a.table_1),
              step2 AS (SELECT x FROM schema_b.secret_table)
         SELECT col_a FROM step1`,
      );
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/schema_b\.secret_table/i);
    });

    it("allows CTE referencing only in-scope tables", async () => {
      const r = await validate(
        "WITH summary AS (SELECT col_a FROM schema_a.table_1) SELECT col_a FROM summary",
      );
      expect(r.allowed).toBe(true);
    });
  });

  // ── Vuln #3: Subquery in WHERE ───────────────────────────────────────
  describe("#3: WHERE subquery", () => {
    it("blocks WHERE IN subquery with out-of-scope table", async () => {
      const r = await validate(
        "SELECT col_a FROM schema_a.table_1 WHERE col_a IN (SELECT x FROM schema_b.secret_table)",
      );
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/schema_b\.secret_table/i);
    });

    it("blocks WHERE EXISTS with out-of-scope table", async () => {
      const r = await validate(
        "SELECT col_a FROM schema_a.table_1 WHERE EXISTS (SELECT 1 FROM schema_b.secret_table)",
      );
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/schema_b\.secret_table/i);
    });

    it("allows WHERE subquery against in-scope table", async () => {
      const r = await validate(
        "SELECT col_a FROM schema_a.table_1 WHERE col_b IN (SELECT col_b FROM schema_a.table_1)",
      );
      expect(r.allowed).toBe(true);
    });
  });

  // ── Vuln #4: Scalar subquery in SELECT ───────────────────────────────
  describe("#4: scalar subquery in SELECT", () => {
    it("blocks scalar subquery with out-of-scope table", async () => {
      const r = await validate(
        "SELECT (SELECT x FROM schema_b.secret_table) AS leaked FROM schema_a.table_1",
      );
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/schema_b\.secret_table/i);
    });
  });

  // ── UNION branch validation ──────────────────────────────────────────
  describe("UNION branches", () => {
    it("blocks UNION ALL with out-of-scope table", async () => {
      const r = await validate(
        "SELECT col_a FROM schema_a.table_1 UNION ALL SELECT x FROM schema_b.secret_table",
      );
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/schema_b\.secret_table/i);
    });
  });

  // ── Round 2: Column validation bypass via expression wrapping ────────
  describe("R2: column bypass via expression wrapping", () => {
    it("blocks CONCAT(denied_col, '')", async () => {
      const r = await validate("SELECT CONCAT(secret_col, '') AS leaked FROM schema_a.table_1");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/secret_col/i);
    });

    it("blocks UPPER(denied_col)", async () => {
      const r = await validate("SELECT UPPER(secret_col) FROM schema_a.table_1");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/secret_col/i);
    });

    it("blocks MAX(denied_col)", async () => {
      const r = await validate("SELECT MAX(secret_col) FROM schema_a.table_1");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/secret_col/i);
    });

    it("blocks IF(denied_col IS NOT NULL, denied_col, 'x')", async () => {
      const r = await validate(
        "SELECT IF(secret_col IS NOT NULL, secret_col, 'x') FROM schema_a.table_1",
      );
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/secret_col/i);
    });

    it("blocks CASE WHEN denied_col THEN denied_col END", async () => {
      const r = await validate(
        "SELECT CASE WHEN secret_col IS NOT NULL THEN secret_col END FROM schema_a.table_1",
      );
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/secret_col/i);
    });

    it("blocks ORDER BY denied_col", async () => {
      const r = await validate("SELECT col_a FROM schema_a.table_1 ORDER BY secret_col");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/secret_col/i);
    });

    it("blocks HAVING MAX(denied_col)", async () => {
      const r = await validate(
        "SELECT col_a FROM schema_a.table_1 GROUP BY col_a HAVING MAX(secret_col) > '0'",
      );
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/secret_col/i);
    });

    it("allows functions wrapping only in-scope columns", async () => {
      const r = await validate("SELECT UPPER(col_a), MAX(col_b) FROM schema_a.table_1");
      expect(r.allowed).toBe(true);
    });

    it("blocks mixed allowed + denied columns inside functions", async () => {
      const r = await validate("SELECT CONCAT(col_a, secret_col) FROM schema_a.table_1");
      expect(r.allowed).toBe(false);
      expect(r.error).toMatch(/secret_col/i);
    });
  });

  // ── Round 2: Error message oracle ──────────────────────────────────
  describe("R2: error message oracle", () => {
    it("does not reveal scope name in error", async () => {
      const r = await validate("SELECT secret_col FROM schema_a.table_1");
      expect(r.allowed).toBe(false);
      expect(r.error).not.toMatch(/Marketing Analyst/);
    });

    it("does not reveal allowed table list in table denial", async () => {
      const r = await validate("SELECT x FROM schema_b.secret_table");
      expect(r.allowed).toBe(false);
      expect(r.error).not.toMatch(/schema_a\.table_1/);
    });
  });

  // ── Legitimate queries (no regression) ───────────────────────────────
  describe("legitimate queries", () => {
    it("allows simple SELECT with in-scope columns", async () => {
      const r = await validate("SELECT col_a, col_b FROM schema_a.table_1");
      expect(r.allowed).toBe(true);
    });

    it("rewrites SELECT * to scope-allowed columns", async () => {
      const r = await validate("SELECT * FROM schema_a.table_1");
      expect(r.allowed).toBe(true);
      expect(r.rewrittenSql).toBeDefined();
    });

    it("denies out-of-scope columns at top level", async () => {
      const r = await validate("SELECT secret_col FROM schema_a.table_1");
      expect(r.allowed).toBe(false);
      expect(r.deniedColumns).toContain("secret_col");
    });

    it("allows WHERE clause without subquery", async () => {
      const r = await validate("SELECT col_a FROM schema_a.table_1 WHERE col_a = 'test'");
      expect(r.allowed).toBe(true);
    });

    it("allows GROUP BY / ORDER BY on in-scope columns", async () => {
      const r = await validate(
        "SELECT col_a, col_b FROM schema_a.table_1 GROUP BY col_a, col_b ORDER BY col_a",
      );
      expect(r.allowed).toBe(true);
    });
  });
});

// ── Vuln #5: Sink metadata leakage ─────────────────────────────────────────

describe("sanitizeSinkResults (pen test #5)", () => {
  const scope: UserScope = {
    scopeId: "scope-1",
    scopeName: "Test",
    warehouseConnectorIds: [CONNECTOR_ID],
    sinkConnectorIds: ["sink-1"],
    columns: [
      { connectorId: CONNECTOR_ID, schemaName: "schema_a", tableName: "table_1", columnName: "col_a" },
    ],
  };

  it("keeps matches with in-scope table metadata", () => {
    const matches = [
      { id: "1", score: 0.9, metadata: { schema: "schema_a", table: "table_1", content: "desc", columns: ["col_a"] } },
    ];
    const result = sanitizeSinkResults(matches, scope);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
    expect(result[0].metadata?.content).toBe("desc");
  });

  it("drops matches with out-of-scope table metadata", () => {
    const matches = [
      { id: "1", score: 0.9, metadata: { schema: "schema_b", table: "secret_table", content: "secret", columns: ["x"] } },
    ];
    const result = sanitizeSinkResults(matches, scope);
    expect(result).toHaveLength(0);
  });

  it("drops matches without table metadata (conservative deny)", () => {
    const matches = [
      { id: "1", score: 0.9, metadata: { content: "orphan content" } },
    ];
    const result = sanitizeSinkResults(matches, scope);
    expect(result).toHaveLength(0);
  });

  it("drops matches with no metadata at all", () => {
    const matches = [{ id: "1", score: 0.9 }];
    const result = sanitizeSinkResults(matches, scope);
    expect(result).toHaveLength(0);
  });

  it("filters mixed results correctly", () => {
    const matches = [
      { id: "1", score: 0.9, metadata: { schema: "schema_a", table: "table_1", columns: ["col_a"] } },
      { id: "2", score: 0.8, metadata: { schema: "schema_b", table: "secret_table", columns: ["x"] } },
      { id: "3", score: 0.7, metadata: { schema: "schema_a", table: "table_1", columns: ["col_a"] } },
    ];
    const result = sanitizeSinkResults(matches, scope);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id)).toEqual(["1", "3"]);
  });

  it("R2: strips out-of-scope column names from metadata", () => {
    const matches = [
      { id: "1", score: 0.9, metadata: { schema: "schema_a", table: "table_1", columns: ["col_a", "secret_col", "another_col"] } },
    ];
    const result = sanitizeSinkResults(matches, scope);
    expect(result).toHaveLength(1);
    expect(result[0].metadata?.columns).toEqual(["col_a"]);
  });
});
