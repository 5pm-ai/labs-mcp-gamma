import snowflake from "snowflake-sdk";
import type {
  WarehouseConnector, WarehouseResult, AuthMethod,
  SchemaInfo, TableInfo, ColumnInfo, RelationshipInfo,
} from "../types.js";
import { registerConnector } from "../registry.js";

const SYSTEM_DATABASES = new Set(["SNOWFLAKE", "SNOWFLAKE_SAMPLE_DATA"]);

class SnowflakeConnector implements WarehouseConnector {
  private conn: snowflake.Connection;
  private connected = false;
  private database: string;

  constructor(credentials: Record<string, unknown>, authMethod: AuthMethod) {
    const account = credentials.account as string;
    if (!account) throw new Error("Snowflake requires account");

    this.database = (credentials.database as string) || "";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connOpts: any = { account };

    if (authMethod === "key_pair") {
      connOpts.username = credentials.username;
      connOpts.authenticator = "SNOWFLAKE_JWT";
      connOpts.privateKey = credentials.privateKeyPem;
      if (credentials.privateKeyPass) connOpts.privateKeyPass = credentials.privateKeyPass;
    } else if (authMethod === "oauth_client_credentials") {
      connOpts.authenticator = "OAUTH_CLIENT_CREDENTIALS";
      connOpts.oauthClientId = credentials.oauthClientId;
      connOpts.oauthClientSecret = credentials.oauthClientSecret;
      connOpts.oauthTokenRequestUrl = credentials.oauthTokenRequestUrl;
      if (credentials.oauthScope) connOpts.oauthScope = credentials.oauthScope;
    }

    if (credentials.warehouse) connOpts.warehouse = credentials.warehouse;
    if (credentials.database) connOpts.database = credentials.database;
    if (credentials.schema) connOpts.schema = credentials.schema;
    if (credentials.role) connOpts.role = credentials.role;

    this.conn = snowflake.createConnection(connOpts);
  }

  private get dbPrefix(): string {
    return this.database ? `${this.database}.` : "";
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await new Promise<void>((resolve, reject) => {
        this.conn.connect((err) => (err ? reject(err) : resolve()));
      });
      this.connected = true;
    }
  }

  private async runQuery(sql: string): Promise<Record<string, unknown>[]> {
    await this.ensureConnected();
    return new Promise<Record<string, unknown>[]>((resolve, reject) => {
      this.conn.execute({
        sqlText: sql,
        complete: (err, _stmt, rows) => {
          if (err) reject(err);
          else resolve((rows || []) as Record<string, unknown>[]);
        },
      });
    });
  }

  private async discoverDatabases(): Promise<string[]> {
    if (this.database) return [this.database];
    const rows = await this.runQuery("SHOW DATABASES");
    return rows
      .map((r) => (r.name ?? r.NAME) as string)
      .filter((name) => name && !SYSTEM_DATABASES.has(name.toUpperCase()));
  }

  async execute(sql: string): Promise<WarehouseResult> {
    const rows = await this.runQuery(sql);
    if (rows.length === 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const columns = Object.keys(rows[0]);
    return { columns, rows, rowCount: rows.length };
  }

  private async listSchemasForDb(db: string): Promise<SchemaInfo[]> {
    const rows = await this.runQuery(
      `SELECT SCHEMA_NAME FROM ${db}.INFORMATION_SCHEMA.SCHEMATA
       WHERE SCHEMA_NAME NOT IN ('INFORMATION_SCHEMA')
       ORDER BY SCHEMA_NAME`,
    );
    const schemas = rows.map((r) => ({ schema: r.SCHEMA_NAME as string }));

    const showRows = await this.runQuery(
      `SHOW SCHEMAS IN DATABASE ${db}`,
    ).catch(() => [] as Record<string, unknown>[]);

    const seen = new Set(schemas.map((s) => s.schema));
    for (const r of showRows) {
      const name = (r.name ?? r.NAME) as string;
      if (name && name !== "INFORMATION_SCHEMA" && !seen.has(name)) {
        schemas.push({ schema: name });
        seen.add(name);
      }
    }

    return schemas.sort((a, b) => a.schema.localeCompare(b.schema));
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const databases = await this.discoverDatabases();
    const allSchemas: SchemaInfo[] = [];
    for (const db of databases) {
      const schemas = await this.listSchemasForDb(db);
      allSchemas.push(...schemas);
    }
    return allSchemas;
  }

  async listTables(schema: string): Promise<TableInfo[]> {
    const databases = await this.discoverDatabases();
    const allTables: TableInfo[] = [];
    for (const db of databases) {
      const rows = await this.runQuery(
        `SELECT TABLE_NAME, TABLE_TYPE, ROW_COUNT, COMMENT
         FROM ${db}.INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'
         ORDER BY TABLE_NAME`,
      );
      allTables.push(...rows.map((r) => ({
        schema,
        table: r.TABLE_NAME as string,
        tableType: (r.TABLE_TYPE as string) || undefined,
        rowCount: r.ROW_COUNT != null ? Number(r.ROW_COUNT) : undefined,
        comment: (r.COMMENT as string) || undefined,
      })));
    }
    return allTables;
  }

  async listColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const databases = await this.discoverDatabases();
    const allColumns: ColumnInfo[] = [];
    for (const db of databases) {
      const rows = await this.runQuery(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COMMENT
         FROM ${db}.INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'
         AND TABLE_NAME = '${table.replace(/'/g, "''")}'
         ORDER BY ORDINAL_POSITION`,
      );
      if (rows.length === 0) continue;

      const pkRows = await this.runQuery(
        `SHOW PRIMARY KEYS IN ${db}."${schema}"."${table}"`,
      ).catch(() => [] as Record<string, unknown>[]);
      const pkColumns = new Set(pkRows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string));

      allColumns.push(...rows.map((r) => ({
        schema,
        table,
        column: r.COLUMN_NAME as string,
        dataType: r.DATA_TYPE as string,
        nullable: r.IS_NULLABLE === "YES",
        isPrimaryKey: pkColumns.has(r.COLUMN_NAME as string),
        comment: (r.COMMENT as string) || undefined,
      })));
    }
    return allColumns;
  }

  async listRelationships(schema: string): Promise<RelationshipInfo[]> {
    const databases = await this.discoverDatabases();
    const allRels: RelationshipInfo[] = [];
    for (const db of databases) {
      try {
        const rows = await this.runQuery(
          `SHOW IMPORTED KEYS IN SCHEMA ${db}."${schema}"`,
        );
        allRels.push(...rows.map((r) => ({
          fromSchema: (r.fk_schema_name ?? r.FK_SCHEMA_NAME) as string,
          fromTable: (r.fk_table_name ?? r.FK_TABLE_NAME) as string,
          fromColumn: (r.fk_column_name ?? r.FK_COLUMN_NAME) as string,
          toSchema: (r.pk_schema_name ?? r.PK_SCHEMA_NAME) as string,
          toTable: (r.pk_table_name ?? r.PK_TABLE_NAME) as string,
          toColumn: (r.pk_column_name ?? r.PK_COLUMN_NAME) as string,
          constraintName: (r.fk_name ?? r.FK_NAME) as string,
        })));
      } catch {
        // FK discovery not supported for this schema/db
      }
    }
    return allRels;
  }

  async close(): Promise<void> {
    this.conn.destroy(() => {});
  }
}

registerConnector("snowflake", (creds, authMethod) => new SnowflakeConnector(creds, authMethod));
