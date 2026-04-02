import { withUserContext } from "../../shared/postgres.js";

export interface UserScope {
  scopeId: string;
  scopeName: string;
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
    if (scopeRow.rows.length === 0) return { scopeId: "", scopeName: "", columns: [] };

    const scopeId = scopeRow.rows[0].scope_id;
    const scopeMeta = await client.query<{ name: string }>(
      "SELECT name FROM scopes WHERE id = $1",
      [scopeId],
    );
    const scopeName = scopeMeta.rows[0]?.name ?? "";

    const cols = await client.query<{
      connector_id: string; schema_name: string; table_name: string; column_name: string;
    }>(
      "SELECT connector_id, schema_name, table_name, column_name FROM scope_columns WHERE scope_id = $1",
      [scopeId],
    );

    return {
      scopeId,
      scopeName,
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

export function buildSinkFilter(scope: UserScope, warehouseConnectorIds: string[]): Record<string, unknown> {
  const allowedColumns = scope.columns
    .filter((c) => warehouseConnectorIds.includes(c.connectorId))
    .map((c) => c.columnName);

  if (allowedColumns.length === 0) return { columns: { $in: ["__DENY_ALL__"] } };

  const unique = [...new Set(allowedColumns)];
  return { columns: { $in: unique } };
}

export function getAllowedColumnsForConnector(scope: UserScope, connectorId: string): Set<string> {
  const allowed = new Set<string>();
  for (const col of scope.columns) {
    if (col.connectorId === connectorId) {
      allowed.add(`${col.schemaName}.${col.tableName}.${col.columnName}`);
    }
  }
  return allowed;
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
