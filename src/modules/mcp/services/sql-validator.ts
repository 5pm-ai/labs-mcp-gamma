import pkg from "node-sql-parser";
const { Parser } = pkg;
import type { UserScope } from "./scope.js";
import { withUserContext } from "../../shared/postgres.js";

export interface SqlValidationResult {
  allowed: boolean;
  rewrittenSql?: string;
  deniedColumns?: string[];
  deniedTables?: string[];
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
    const key = `${row.schema_name}.${row.table_name}`.toLowerCase();
    if (!catalog.has(key)) catalog.set(key, []);
    catalog.get(key)!.push(row.column_name.toLowerCase());
  }
  return catalog;
}

type ScopeTableMap = Map<string, Set<string>>;

function buildScopeTableMap(scope: UserScope, connectorId: string): ScopeTableMap {
  const map: ScopeTableMap = new Map();
  for (const col of scope.columns) {
    if (col.connectorId !== connectorId) continue;
    const key = `${col.schemaName}.${col.tableName}`.toLowerCase();
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(col.columnName.toLowerCase());
  }
  return map;
}

interface TableRef {
  qualified: string;
  alias: string | null;
  schema: string;
  table: string;
}

function extractTableRefs(from: unknown): TableRef[] {
  const refs: TableRef[] = [];
  if (!from || typeof from !== "object") return refs;

  const node = from as Record<string, unknown>;

  if (node.type === "dual") return refs;

  if (typeof node.table === "string") {
    const schema = typeof node.schema === "string" ? node.schema : "";
    const db = typeof node.db === "string" ? node.db : "";
    const effectiveSchema = schema || db;
    const qualified = effectiveSchema ? `${effectiveSchema}.${node.table}` : node.table;
    const alias = typeof node.as === "string" ? node.as : null;
    refs.push({ qualified, alias, schema: effectiveSchema, table: node.table });
  }

  if (Array.isArray(node.columns)) {
    for (const col of node.columns) {
      refs.push(...extractTableRefs(col));
    }
  }

  return refs;
}

function resolveTableKey(
  tableRef: string,
  tableRefs: TableRef[],
  catalog: Map<string, string[]>,
): string | null {
  const lower = tableRef.toLowerCase();

  if (catalog.has(lower)) return lower;

  const byAlias = tableRefs.find((t) => t.alias?.toLowerCase() === lower);
  if (byAlias) {
    const q = byAlias.qualified.toLowerCase();
    if (catalog.has(q)) return q;
    const match = [...catalog.keys()].find((k) => k.endsWith(`.${byAlias.table.toLowerCase()}`));
    if (match) return match;
  }

  const match = [...catalog.keys()].find(
    (k) => k === lower || k.endsWith(`.${lower}`)
  );
  if (match) return match;

  return null;
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
    return { allowed: false, error: "Could not parse SQL for scope validation. Simplify the query or contact your admin." };
  }

  const stmts = Array.isArray(ast) ? ast : [ast];
  const scopeMap = buildScopeTableMap(scope, connectorId);
  const catalog = await loadCatalogForConnector(userId, connectorId);

  if (scopeMap.size === 0) {
    return { allowed: false, error: "Your scope has no allowed columns for this connector." };
  }

  let needsRewrite = false;
  const deniedColumns: string[] = [];
  const deniedTables: string[] = [];

  for (const stmt of stmts) {
    if (!stmt || typeof stmt !== "object") continue;
    const s = stmt as unknown as Record<string, unknown>;

    if (s.type !== "select") continue;

    const from = s.from;
    const tableRefs: TableRef[] = [];
    if (Array.isArray(from)) {
      for (const f of from) {
        tableRefs.push(...extractTableRefs(f));
      }
    }

    for (const ref of tableRefs) {
      const catalogKey = resolveTableKey(ref.qualified, tableRefs, catalog);
      if (catalogKey && !scopeMap.has(catalogKey)) {
        deniedTables.push(ref.qualified);
      }
    }

    if (deniedTables.length > 0) {
      return {
        allowed: false,
        deniedTables: [...new Set(deniedTables)],
        error: `Access denied: table(s) [${[...new Set(deniedTables)].join(", ")}] are not in your scope "${scope.scopeName}". Your scope only allows: ${[...scopeMap.keys()].join(", ")}.`,
      };
    }

    const columns = s.columns;

    const isSelectStar = columns === "*" || (
      Array.isArray(columns) && columns.length === 1 &&
      (columns[0] as Record<string, unknown>)?.expr &&
      ((columns[0] as Record<string, unknown>).expr as Record<string, unknown>)?.column === "*"
    );

    if (isSelectStar) {
      if (tableRefs.length === 0) {
        return { allowed: false, error: "Cannot resolve SELECT * without table references. Please specify columns explicitly." };
      }

      const expandedCols: unknown[] = [];
      for (const ref of tableRefs) {
        const catalogKey = resolveTableKey(ref.qualified, tableRefs, catalog);
        if (!catalogKey) continue;

        const allowedCols = scopeMap.get(catalogKey);
        if (!allowedCols || allowedCols.size === 0) continue;

        const allCols = catalog.get(catalogKey) ?? [];
        const allowed = allCols.filter((c) => allowedCols.has(c));

        for (const colName of allowed) {
          expandedCols.push({
            expr: { type: "column_ref", table: ref.alias ?? ref.table, column: colName.toUpperCase() },
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
          if (expr.column === "*") continue;

          const colName = expr.column.toLowerCase();
          const colTable = typeof expr.table === "string" ? expr.table : null;

          if (colTable) {
            const catalogKey = resolveTableKey(colTable, tableRefs, catalog);
            if (catalogKey) {
              const allowedCols = scopeMap.get(catalogKey);
              if (!allowedCols || !allowedCols.has(colName)) {
                deniedColumns.push(`${colTable}.${expr.column}`);
              }
            } else if (tableRefs.length === 1) {
              const singleKey = resolveTableKey(tableRefs[0].qualified, tableRefs, catalog);
              if (singleKey) {
                const allowedCols = scopeMap.get(singleKey);
                if (!allowedCols || !allowedCols.has(colName)) {
                  deniedColumns.push(expr.column);
                }
              }
            }
          } else {
            let foundAllowed = false;
            for (const ref of tableRefs) {
              const catalogKey = resolveTableKey(ref.qualified, tableRefs, catalog);
              if (!catalogKey) continue;
              const allowedCols = scopeMap.get(catalogKey);
              if (allowedCols?.has(colName)) {
                foundAllowed = true;
                break;
              }
            }
            if (!foundAllowed) {
              deniedColumns.push(expr.column);
            }
          }
        }
      }
    }
  }

  if (deniedColumns.length > 0) {
    const unique = [...new Set(deniedColumns)];
    return {
      allowed: false,
      deniedColumns: unique,
      error: `Access denied: columns [${unique.join(", ")}] are not in your scope "${scope.scopeName}". Remove them or ask your admin to update your scope.`,
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
