import pkg from "node-sql-parser";
const { Parser } = pkg;
import type { UserScope } from "./scope.js";
import { withUserContext } from "../../shared/postgres.js";

export interface SqlValidationResult {
  allowed: boolean;
  rewrittenSql?: string;
  deniedColumns?: string[];
  error?: string;
}

const DIALECT_MAP: Record<string, string> = {
  snowflake: "Snowflake",
  bigquery: "BigQuery",
  clickhouse: "MySQL",
};

async function resolveConnectorDialect(userId: string, connectorId: string): Promise<string> {
  const result = await withUserContext(userId, async (client) => {
    return client.query<{ type: string }>(
      "SELECT type FROM warehouse_connectors WHERE id = $1",
      [connectorId],
    );
  });
  const type = result.rows[0]?.type ?? "snowflake";
  return DIALECT_MAP[type] ?? "Snowflake";
}

async function loadCatalogForConnector(
  userId: string,
  connectorId: string,
): Promise<Map<string, string[]>> {
  const result = await withUserContext(userId, async (client) => {
    return client.query<{ schema_name: string; table_name: string; column_name: string }>(
      "SELECT schema_name, table_name, column_name FROM connector_columns WHERE connector_id = $1",
      [connectorId],
    );
  });

  const catalog = new Map<string, string[]>();
  for (const row of result.rows) {
    const key = `${row.schema_name}.${row.table_name}`;
    if (!catalog.has(key)) catalog.set(key, []);
    catalog.get(key)!.push(row.column_name);
  }
  return catalog;
}

function extractTableRef(from: unknown): string[] {
  const tables: string[] = [];
  if (!from || typeof from !== "object") return tables;

  const node = from as Record<string, unknown>;

  if (node.type === "dual") return tables;

  if (typeof node.table === "string") {
    const schema = typeof node.schema === "string" ? node.schema : "";
    const qualified = schema ? `${schema}.${node.table}` : node.table;
    tables.push(qualified);
  }

  if (Array.isArray(node.columns)) {
    for (const col of node.columns) {
      tables.push(...extractTableRef(col));
    }
  }

  return tables;
}

function extractTablesFromAst(ast: Record<string, unknown>): string[] {
  const tables: string[] = [];

  const from = ast.from;
  if (Array.isArray(from)) {
    for (const f of from) {
      tables.push(...extractTableRef(f));
    }
  }

  return tables;
}

export async function validateAndRewriteSql(
  userId: string,
  connectorId: string,
  sql: string,
  scope: UserScope,
): Promise<SqlValidationResult> {
  const dialect = await resolveConnectorDialect(userId, connectorId);
  const parser = new Parser();

  let ast: ReturnType<typeof parser.astify>;
  try {
    ast = parser.astify(sql, { database: dialect });
  } catch {
    return { allowed: true };
  }

  const stmts = Array.isArray(ast) ? ast : [ast];
  const catalog = await loadCatalogForConnector(userId, connectorId);

  const allowedColumnNames = new Set<string>();
  for (const col of scope.columns) {
    if (col.connectorId === connectorId) {
      allowedColumnNames.add(col.columnName.toLowerCase());
    }
  }

  if (allowedColumnNames.size === 0) {
    return { allowed: false, error: "Your scope has no allowed columns for this connector." };
  }

  let needsRewrite = false;
  const deniedColumns: string[] = [];

  for (const stmt of stmts) {
    if (!stmt || typeof stmt !== "object") continue;
    const s = stmt as unknown as Record<string, unknown>;

    if (s.type !== "select") continue;

    const columns = s.columns;

    if (columns === "*") {
      const tables = extractTablesFromAst(s);
      if (tables.length === 0) {
        return { allowed: false, error: "Cannot resolve SELECT * without table references. Please specify columns explicitly." };
      }

      const expandedCols: unknown[] = [];
      for (const tbl of tables) {
        let catalogKey = tbl;
        if (!catalog.has(catalogKey)) {
          const match = [...catalog.keys()].find((k) => k.endsWith(`.${tbl}`) || k.toLowerCase() === tbl.toLowerCase());
          if (match) catalogKey = match;
        }
        const allCols = catalog.get(catalogKey) ?? [];
        if (allCols.length === 0) continue;

        const allowed = allCols.filter((c) => allowedColumnNames.has(c.toLowerCase()));
        if (allowed.length === 0) continue;

        for (const colName of allowed) {
          expandedCols.push({
            expr: { type: "column_ref", table: null, column: colName },
            as: null,
          });
        }
      }

      if (expandedCols.length === 0) {
        return { allowed: false, error: "SELECT * resolves to zero allowed columns for your scope." };
      }

      s.columns = expandedCols;
      needsRewrite = true;
      continue;
    }

    if (Array.isArray(columns)) {
      for (const col of columns) {
        if (!col || typeof col !== "object") continue;
        const c = col as Record<string, unknown>;
        const expr = c.expr as Record<string, unknown> | undefined;
        if (!expr) continue;

        if (expr.type === "column_ref" && typeof expr.column === "string") {
          if (expr.column === "*") {
            continue;
          }
          if (!allowedColumnNames.has(expr.column.toLowerCase())) {
            deniedColumns.push(expr.column);
          }
        }
      }
    }
  }

  if (deniedColumns.length > 0) {
    return {
      allowed: false,
      deniedColumns: [...new Set(deniedColumns)],
      error: `Access denied: columns [${[...new Set(deniedColumns)].join(", ")}] are not in your scope "${scope.scopeName}". Remove them or ask your admin to update your scope.`,
    };
  }

  if (needsRewrite) {
    try {
      const rewritten = parser.sqlify(Array.isArray(ast) ? ast : [ast], { database: dialect });
      return { allowed: true, rewrittenSql: rewritten };
    } catch {
      return { allowed: true, rewrittenSql: sql };
    }
  }

  return { allowed: true };
}
