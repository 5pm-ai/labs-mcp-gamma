import { withUserContext } from "../../shared/postgres.js";

export interface UserScope {
  scopeId: string;
  scopeName: string;
  warehouseConnectorIds: string[];
  sinkConnectorIds: string[];
  columns: Array<{
    connectorId: string;
    schemaName: string;
    tableName: string;
    columnName: string;
  }>;
}

export async function resolveUserScope(userId: string): Promise<UserScope | null> {
  const result = await withUserContext(userId, async (client) => {
    const membership = await client.query<{ team_id: string; role: string }>(
      "SELECT team_id, role FROM team_members WHERE user_id = $1 LIMIT 1",
      [userId],
    );
    if (membership.rows.length === 0) return null;

    const { role } = membership.rows[0];
    if (role === "org_admin" || role === "platform_admin") return null;

    const scopeRow = await client.query<{ scope_id: string }>(
      "SELECT scope_id FROM scope_members WHERE user_id = $1",
      [userId],
    );
    if (scopeRow.rows.length === 0) return null; // unscoped = unrestricted

    const scopeId = scopeRow.rows[0].scope_id;
    const scopeMeta = await client.query<{ name: string }>(
      "SELECT name FROM scopes WHERE id = $1",
      [scopeId],
    );
    const scopeName = scopeMeta.rows[0]?.name ?? "";

    const ingestRows = await client.query<{
      warehouse_connector_id: string | null;
      sink_connector_id: string | null;
    }>(
      `SELECT i.warehouse_connector_id, i.sink_connector_id
       FROM scope_ingests si
       JOIN ingests i ON i.id = si.ingest_id
       WHERE si.scope_id = $1 AND i.deleted_at IS NULL`,
      [scopeId],
    );

    const whIds = new Set<string>();
    const sinkIds = new Set<string>();
    for (const row of ingestRows.rows) {
      if (row.warehouse_connector_id) whIds.add(row.warehouse_connector_id);
      if (row.sink_connector_id) sinkIds.add(row.sink_connector_id);
    }

    const cols = await client.query<{
      connector_id: string; schema_name: string; table_name: string; column_name: string;
    }>(
      "SELECT connector_id, schema_name, table_name, column_name FROM scope_columns WHERE scope_id = $1",
      [scopeId],
    );

    return {
      scopeId,
      scopeName,
      warehouseConnectorIds: [...whIds],
      sinkConnectorIds: [...sinkIds],
      columns: cols.rows.map((r) => ({
        connectorId: r.connector_id,
        schemaName: r.schema_name,
        tableName: r.table_name,
        columnName: r.column_name,
      })),
    };
  });

  return result;
}

export function buildSinkFilter(scope: UserScope): Record<string, unknown> {
  const allowedColumns = scope.columns
    .filter((c) => scope.warehouseConnectorIds.includes(c.connectorId))
    .map((c) => c.columnName);

  if (allowedColumns.length === 0) return { columns: { $in: ["__DENY_ALL__"] } };

  const unique = [...new Set(allowedColumns)];
  return { columns: { $in: unique } };
}

export function sanitizeSinkResults(
  matches: Array<{ id: string; score?: number; metadata?: Record<string, unknown> }>,
  scope: UserScope,
): Array<{ id: string; score?: number; metadata?: Record<string, unknown> }> {
  const allowedTables = new Set<string>();
  for (const col of scope.columns) {
    allowedTables.add(`${col.schemaName}.${col.tableName}`.toLowerCase());
  }

  return matches.filter((m) => {
    if (!m.metadata) return false;
    const schema = String(m.metadata.schema ?? "").toLowerCase();
    const table = String(m.metadata.table ?? "").toLowerCase();
    if (!schema || !table) return false;
    return allowedTables.has(`${schema}.${table}`);
  });
}

export function getConnectorColumnsLookup(scope: UserScope, connectorId: string): Map<string, Set<string>> {
  const tableColumns = new Map<string, Set<string>>();
  for (const col of scope.columns) {
    if (col.connectorId === connectorId) {
      const key = `${col.schemaName}.${col.tableName}`;
      if (!tableColumns.has(key)) tableColumns.set(key, new Set());
      tableColumns.get(key)!.add(col.columnName);
    }
  }
  return tableColumns;
}
