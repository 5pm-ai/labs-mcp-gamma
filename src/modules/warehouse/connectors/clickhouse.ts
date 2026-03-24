import { createClient } from "@clickhouse/client";
import type {
  WarehouseConnector, WarehouseResult,
  SchemaInfo, TableInfo, ColumnInfo, RelationshipInfo,
} from "../types.js";
import { registerConnector } from "../registry.js";

class ClickHouseConnector implements WarehouseConnector {
  private client: ReturnType<typeof createClient>;
  private database: string;

  constructor(credentials: Record<string, unknown>) {
    const url = credentials.url as string;
    if (!url) throw new Error("ClickHouse requires url");

    this.database = (credentials.database as string) || "default";

    this.client = createClient({
      url,
      username: (credentials.username as string) || "default",
      password: (credentials.password as string) || "",
      database: this.database,
    });
  }

  private async runQuery(sql: string): Promise<Record<string, unknown>[]> {
    const result = await this.client.query({ query: sql, format: "JSONEachRow" });
    return result.json<Record<string, unknown>>();
  }

  async execute(sql: string): Promise<WarehouseResult> {
    const rows = await this.runQuery(sql);
    if (rows.length === 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const columns = Object.keys(rows[0]);
    return { columns, rows, rowCount: rows.length };
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const rows = await this.runQuery(
      `SELECT name FROM system.databases
       WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
       ORDER BY name`,
    );
    return rows.map((r) => ({ schema: r.name as string }));
  }

  async listTables(schema: string): Promise<TableInfo[]> {
    const rows = await this.runQuery(
      `SELECT name, total_rows, comment
       FROM system.tables
       WHERE database = '${schema.replace(/'/g, "\\'")}'
       AND is_temporary = 0
       ORDER BY name`,
    );
    return rows.map((r) => ({
      schema,
      table: r.name as string,
      rowCount: r.total_rows != null ? Number(r.total_rows) : undefined,
      comment: (r.comment as string) || undefined,
    }));
  }

  async listColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.runQuery(
      `SELECT name, type, comment, is_in_primary_key
       FROM system.columns
       WHERE database = '${schema.replace(/'/g, "\\'")}'
       AND table = '${table.replace(/'/g, "\\'")}'
       ORDER BY position`,
    );
    return rows.map((r) => ({
      schema,
      table,
      column: r.name as string,
      dataType: r.type as string,
      nullable: (r.type as string).startsWith("Nullable"),
      isPrimaryKey: r.is_in_primary_key === 1,
      comment: (r.comment as string) || undefined,
    }));
  }

  async listRelationships(_schema: string): Promise<RelationshipInfo[]> {
    return [];
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

registerConnector("clickhouse", (creds) => new ClickHouseConnector(creds));
