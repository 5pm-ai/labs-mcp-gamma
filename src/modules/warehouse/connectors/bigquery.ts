import { BigQuery } from "@google-cloud/bigquery";
import type {
  WarehouseConnector, WarehouseResult,
  SchemaInfo, TableInfo, ColumnInfo, RelationshipInfo,
} from "../types.js";
import { registerConnector } from "../registry.js";

class BigQueryConnector implements WarehouseConnector {
  private bq: BigQuery;
  private projectId: string;

  constructor(credentials: Record<string, unknown>) {
    const serviceAccountKey = credentials.serviceAccountKey as Record<string, string> | undefined;
    if (!serviceAccountKey || typeof serviceAccountKey !== "object") {
      throw new Error("BigQuery requires serviceAccountKey in credentials");
    }

    this.projectId = (credentials.projectId as string) || serviceAccountKey.project_id;
    if (!this.projectId) {
      throw new Error("BigQuery requires projectId");
    }

    this.bq = new BigQuery({ projectId: this.projectId, credentials: serviceAccountKey });
  }

  async execute(sql: string): Promise<WarehouseResult> {
    const [rows] = await this.bq.query(sql);
    if (!rows || rows.length === 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const columns = Object.keys(rows[0] as Record<string, unknown>);
    return { columns, rows: rows as Record<string, unknown>[], rowCount: rows.length };
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const [datasets] = await this.bq.getDatasets();
    return datasets.map((ds) => ({ schema: ds.id! }));
  }

  async listTables(schema: string): Promise<TableInfo[]> {
    const dataset = this.bq.dataset(schema);
    const [tables] = await dataset.getTables();
    return tables.map((t) => ({
      schema,
      table: t.id!,
      rowCount: t.metadata?.numRows ? Number(t.metadata.numRows) : undefined,
      comment: t.metadata?.description || undefined,
    }));
  }

  async listColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const [rows] = await this.bq.query({
      query: `SELECT column_name, data_type, is_nullable, column_default
              FROM \`${this.projectId}.${schema}.INFORMATION_SCHEMA.COLUMNS\`
              WHERE table_name = @tableName
              ORDER BY ordinal_position`,
      params: { tableName: table },
    });

    const pkResult = await this.bq.query({
      query: `SELECT ccu.column_name
              FROM \`${this.projectId}.${schema}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS\` tc
              JOIN \`${this.projectId}.${schema}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE\` ccu
                ON tc.constraint_name = ccu.constraint_name
              WHERE tc.table_name = @tableName AND tc.constraint_type = 'PRIMARY KEY'`,
      params: { tableName: table },
    });
    const pkColumns = new Set((pkResult[0] || []).map((r: Record<string, unknown>) => r.column_name as string));

    return (rows || []).map((r: Record<string, unknown>) => ({
      schema,
      table,
      column: r.column_name as string,
      dataType: r.data_type as string,
      nullable: r.is_nullable === "YES",
      isPrimaryKey: pkColumns.has(r.column_name as string),
    }));
  }

  async listRelationships(schema: string): Promise<RelationshipInfo[]> {
    try {
      const [rows] = await this.bq.query({
        query: `SELECT
                  tc.constraint_name,
                  kcu.table_name AS from_table,
                  kcu.column_name AS from_column,
                  ccu.table_name AS to_table,
                  ccu.column_name AS to_column
                FROM \`${this.projectId}.${schema}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS\` tc
                JOIN \`${this.projectId}.${schema}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE\` kcu
                  ON tc.constraint_name = kcu.constraint_name
                JOIN \`${this.projectId}.${schema}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE\` ccu
                  ON tc.constraint_name = ccu.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY'`,
      });

      return (rows || []).map((r: Record<string, unknown>) => ({
        fromSchema: schema,
        fromTable: r.from_table as string,
        fromColumn: r.from_column as string,
        toSchema: schema,
        toTable: r.to_table as string,
        toColumn: r.to_column as string,
        constraintName: r.constraint_name as string,
      }));
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {}
}

registerConnector("bigquery", (creds) => new BigQueryConnector(creds));
