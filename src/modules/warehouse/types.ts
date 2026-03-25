export type WarehouseType = "bigquery" | "snowflake" | "clickhouse";
export type AuthMethod = "service_account_json" | "key_pair" | "oauth_client_credentials" | "password";

export interface WarehouseResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface SchemaInfo {
  schema: string;
}

export interface TableInfo {
  schema: string;
  table: string;
  tableType?: string;
  rowCount?: number;
  comment?: string;
}

export interface ColumnInfo {
  schema: string;
  table: string;
  column: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  comment?: string;
}

export interface RelationshipInfo {
  fromSchema: string;
  fromTable: string;
  fromColumn: string;
  toSchema: string;
  toTable: string;
  toColumn: string;
  constraintName: string;
}

export interface WarehouseConnector {
  execute(sql: string): Promise<WarehouseResult>;
  listSchemas(): Promise<SchemaInfo[]>;
  listTables(schema: string): Promise<TableInfo[]>;
  listColumns(schema: string, table: string): Promise<ColumnInfo[]>;
  listRelationships(schema: string): Promise<RelationshipInfo[]>;
  close(): Promise<void>;
}

export type ConnectorFactory = (
  credentials: Record<string, unknown>,
  authMethod: AuthMethod,
) => WarehouseConnector;
