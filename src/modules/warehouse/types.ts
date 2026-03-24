export type WarehouseType = "bigquery" | "snowflake" | "clickhouse";
export type AuthMethod = "service_account_json" | "key_pair" | "oauth_client_credentials" | "password";

export interface WarehouseResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface WarehouseConnector {
  execute(sql: string): Promise<WarehouseResult>;
  close(): Promise<void>;
}

export type ConnectorFactory = (
  credentials: Record<string, unknown>,
  authMethod: AuthMethod,
) => WarehouseConnector;
