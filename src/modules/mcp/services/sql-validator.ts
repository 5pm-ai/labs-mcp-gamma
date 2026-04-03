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

const SYSTEM_SCHEMAS = new Set([
  "information_schema",
  "pg_catalog",
  "pg_toast",
  "sys",
  "mysql",
  "performance_schema",
  "account_usage",
  "organization_usage",
  "reader_account_usage",
]);

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

function resolveColumnName(column: unknown): string | null {
  if (typeof column === "string") return column;
  if (column && typeof column === "object") {
    const obj = column as Record<string, unknown>;
    if (obj.expr && typeof obj.expr === "object") {
      const expr = obj.expr as Record<string, unknown>;
      if (typeof expr.value === "string") return expr.value;
    }
  }
  return null;
}

function collectColumnRefs(
  node: unknown,
): Array<{ table: string | null; column: string }> {
  const refs: Array<{ table: string | null; column: string }> = [];
  if (!node || typeof node !== "object") return refs;

  if (Array.isArray(node)) {
    for (const item of node) refs.push(...collectColumnRefs(item));
    return refs;
  }

  const obj = node as Record<string, unknown>;

  if (obj.type === "column_ref") {
    const colName = resolveColumnName(obj.column);
    if (colName && colName !== "*") {
      refs.push({ table: typeof obj.table === "string" ? obj.table : null, column: colName });
    }
    return refs;
  }

  if (obj.type === "select") return refs;

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      refs.push(...collectColumnRefs(value));
    }
  }
  return refs;
}

function collectUsingColumns(using: unknown): Array<{ table: null; column: string }> {
  const refs: Array<{ table: null; column: string }> = [];
  if (!using) return refs;
  const items = Array.isArray(using) ? using : [using];
  for (const item of items) {
    if (typeof item === "string") {
      refs.push({ table: null, column: item });
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.value === "string" ? obj.value
        : typeof obj.column === "string" ? obj.column
        : resolveColumnName(obj);
      if (name) refs.push({ table: null, column: name });
    }
  }
  return refs;
}

function isSystemTable(qualified: string): boolean {
  const parts = qualified.toLowerCase().split(".");
  return parts.some((p) => SYSTEM_SCHEMAS.has(p));
}

// ---------------------------------------------------------------------------
// Recursive AST validation
// ---------------------------------------------------------------------------

interface ValidateCtx {
  scopeMap: ScopeTableMap;
  catalog: Map<string, string[]>;
  knownAliases: Set<string>;
}

const MAX_DEPTH = 32;

function walkForNestedSelects(
  node: unknown,
  ctx: ValidateCtx,
  depth: number,
): string | null {
  if (depth > MAX_DEPTH) return "Query too deeply nested.";
  if (!node || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const err = walkForNestedSelects(item, ctx, depth);
      if (err) return err;
    }
    return null;
  }

  const obj = node as Record<string, unknown>;

  if (obj.type === "select") {
    return validateSelectNode(obj, ctx, depth + 1);
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const err = walkForNestedSelects(value, ctx, depth);
      if (err) return err;
    }
  }

  return null;
}

function validateSelectNode(
  s: Record<string, unknown>,
  ctx: ValidateCtx,
  depth: number,
): string | null {
  if (depth > MAX_DEPTH) return "Query too deeply nested.";

  const localAliases = new Set(ctx.knownAliases);

  // 1. CTEs — register names, validate inner bodies
  if (Array.isArray(s.with)) {
    for (const cte of s.with) {
      const cteObj = cte as Record<string, unknown>;
      let cteName: string | null = null;
      if (typeof cteObj.name === "string") {
        cteName = cteObj.name.toLowerCase();
      } else if (cteObj.name && typeof cteObj.name === "object") {
        const v = (cteObj.name as Record<string, unknown>).value;
        if (typeof v === "string") cteName = v.toLowerCase();
      }
      if (cteName) localAliases.add(cteName);

      const rawStmt = cteObj.stmt as Record<string, unknown> | undefined;
      const cteBody = (
        (rawStmt && typeof rawStmt.ast === "object" ? rawStmt.ast : rawStmt)
        ?? cteObj.ast
      ) as Record<string, unknown> | undefined;
      if (cteBody) {
        if (cteBody.type !== "select") {
          return `Only SELECT statements are allowed inside CTEs. Found "${String(cteBody.type)}".`;
        }
        const err = validateSelectNode(
          cteBody,
          { ...ctx, knownAliases: localAliases },
          depth + 1,
        );
        if (err) return err;
      }
    }
  }

  const localCtx: ValidateCtx = { ...ctx, knownAliases: localAliases };

  // 2. FROM — extract table refs, track derived-table aliases, walk for subqueries
  const tableRefs: TableRef[] = [];
  if (Array.isArray(s.from)) {
    for (const f of s.from) {
      const fObj = f as Record<string, unknown>;
      tableRefs.push(...extractTableRefs(fObj));

      if (
        fObj.expr &&
        typeof fObj.expr === "object" &&
        (fObj.expr as Record<string, unknown>).type === "select"
      ) {
        const alias = typeof fObj.as === "string" ? fObj.as.toLowerCase() : null;
        if (alias) localAliases.add(alias);
      }

      const err = walkForNestedSelects(f, localCtx, depth);
      if (err) return err;
    }
  }

  for (const ref of tableRefs) {
    const lq = ref.qualified.toLowerCase();
    const lt = ref.table.toLowerCase();

    if (localAliases.has(lq) || localAliases.has(lt)) continue;

    if (isSystemTable(ref.qualified)) {
      return `Access denied: system table "${ref.qualified}" is not accessible to scoped users.`;
    }

    const catalogKey = resolveTableKey(ref.qualified, tableRefs, ctx.catalog);
    if (catalogKey === null) {
      return (
        `Access denied: table "${ref.qualified}" is not in the data catalog. ` +
        "It may need to be re-ingested, or contact your admin."
      );
    }
    if (!ctx.scopeMap.has(catalogKey)) {
      return `Access denied: table "${ref.qualified}" is not in your scope. Contact your admin to update your scope.`;
    }
  }

  // 3. Deny SELECT * when FROM has tables with denied columns
  const hasSelectStar = s.columns === "*" || (
    Array.isArray(s.columns) && s.columns.length === 1 &&
    (() => {
      const first = (s.columns as Record<string, unknown>[])[0];
      const expr = first?.expr as Record<string, unknown> | undefined;
      return expr && resolveColumnName(expr.column) === "*";
    })()
  );
  if (hasSelectStar && depth > 0) {
    for (const ref of tableRefs) {
      const lt = ref.table.toLowerCase();
      const lq = ref.qualified.toLowerCase();
      if (localAliases.has(lq) || localAliases.has(lt)) continue;
      const catalogKey = resolveTableKey(ref.qualified, tableRefs, ctx.catalog);
      if (!catalogKey) continue;
      const catalogCols = ctx.catalog.get(catalogKey) ?? [];
      const allowedCols = ctx.scopeMap.get(catalogKey);
      if (catalogCols.some((c) => !allowedCols?.has(c))) {
        return (
          "SELECT * is not allowed here because the table contains columns outside your scope. " +
          "Please specify columns explicitly."
        );
      }
    }
  }

  // 4. Walk all clauses for nested subqueries (table validation in nested SELECTs)
  if (s.columns && s.columns !== "*" && Array.isArray(s.columns)) {
    for (const col of s.columns) {
      const err = walkForNestedSelects(col, localCtx, depth);
      if (err) return err;
    }
  }

  for (const clause of [s.where, s.having, s.orderby, s.groupby, s.window]) {
    if (clause) {
      const err = walkForNestedSelects(clause, localCtx, depth);
      if (err) return err;
    }
  }

  // 5. Column validation at THIS SELECT level (covers CTEs, derived tables, etc.)
  const allColRefs = [
    ...collectColumnRefs(s.columns),
    ...collectColumnRefs(s.where),
    ...collectColumnRefs(s.having),
    ...collectColumnRefs(s.orderby),
    ...collectColumnRefs(s.groupby),
    ...collectColumnRefs(s.window),
  ];
  if (Array.isArray(s.from)) {
    for (const f of s.from) {
      const fObj = f as Record<string, unknown>;
      if (fObj.on) allColRefs.push(...collectColumnRefs(fObj.on));
      if (fObj.using) allColRefs.push(...collectUsingColumns(fObj.using));
    }
  }

  for (const colRef of allColRefs) {
    const colName = colRef.column.toLowerCase();
    if (colRef.table) {
      const catalogKey = resolveTableKey(colRef.table, tableRefs, ctx.catalog);
      if (catalogKey) {
        const allowedCols = ctx.scopeMap.get(catalogKey);
        if (!allowedCols || !allowedCols.has(colName)) {
          return `Access denied: column "${colRef.column}" is not in your scope. Contact your admin.`;
        }
      } else {
        let inCatalog = false;
        for (const cols of ctx.catalog.values()) {
          if (cols.includes(colName)) { inCatalog = true; break; }
        }
        if (inCatalog) {
          let inScope = false;
          for (const allowed of ctx.scopeMap.values()) {
            if (allowed.has(colName)) { inScope = true; break; }
          }
          if (!inScope) {
            return `Access denied: column "${colRef.column}" is not in your scope. Contact your admin.`;
          }
        }
      }
    } else {
      let foundAllowed = false;
      let checkedAnyTable = false;
      for (const tRef of tableRefs) {
        const catalogKey = resolveTableKey(tRef.qualified, tableRefs, ctx.catalog);
        if (!catalogKey) continue;
        checkedAnyTable = true;
        if (ctx.scopeMap.get(catalogKey)?.has(colName)) {
          foundAllowed = true;
          break;
        }
      }
      if (checkedAnyTable && !foundAllowed) {
        return `Access denied: column "${colRef.column}" is not in your scope. Contact your admin.`;
      }
      if (!checkedAnyTable) {
        let inCatalog = false;
        for (const cols of ctx.catalog.values()) {
          if (cols.includes(colName)) { inCatalog = true; break; }
        }
        if (inCatalog) {
          let inScope = false;
          for (const allowed of ctx.scopeMap.values()) {
            if (allowed.has(colName)) { inScope = true; break; }
          }
          if (!inScope) {
            return `Access denied: column "${colRef.column}" is not in your scope. Contact your admin.`;
          }
        }
      }
    }
  }

  // 6. UNION / INTERSECT / EXCEPT
  if (s._next && typeof s._next === "object") {
    const next = s._next as Record<string, unknown>;
    if (next.type === "select") {
      const err = validateSelectNode(next, localCtx, depth + 1);
      if (err) return err;
    } else {
      const err = walkForNestedSelects(s._next, localCtx, depth);
      if (err) return err;
    }
  }

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

  for (const stmt of stmts) {
    if (!stmt || typeof stmt !== "object") continue;
    const s = stmt as unknown as Record<string, unknown>;

    if (s.type !== "select") {
      return {
        allowed: false,
        error: `Only SELECT queries are allowed for scoped users. Found: ${String(s.type ?? "unknown")}.`,
      };
    }

    // Recursive table + column validation (CTEs, subqueries, JOINs, UNION, etc.)
    const ctx: ValidateCtx = { scopeMap, catalog, knownAliases: new Set() };
    const validationError = validateSelectNode(s, ctx, 0);
    if (validationError) {
      return { allowed: false, error: validationError };
    }

    // SELECT * rewrite (top-level only — expand to scope-allowed columns)
    const from = s.from;
    const tableRefs: TableRef[] = [];
    if (Array.isArray(from)) {
      for (const f of from) {
        tableRefs.push(...extractTableRefs(f));
      }
    }

    const columns = s.columns;
    const isSelectStar = columns === "*" || (
      Array.isArray(columns) && columns.length === 1 &&
      (columns[0] as Record<string, unknown>)?.expr &&
      resolveColumnName(((columns[0] as Record<string, unknown>).expr as Record<string, unknown>)?.column) === "*"
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
    }
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
