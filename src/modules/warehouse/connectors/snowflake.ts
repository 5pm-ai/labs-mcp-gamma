import snowflake from "snowflake-sdk";
import type { WarehouseConnector, WarehouseResult, AuthMethod } from "../types.js";
import { registerConnector } from "../registry.js";

class SnowflakeConnector implements WarehouseConnector {
  private conn: snowflake.Connection;

  constructor(credentials: Record<string, unknown>, authMethod: AuthMethod) {
    const account = credentials.account as string;
    if (!account) throw new Error("Snowflake requires account");

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

  async execute(sql: string): Promise<WarehouseResult> {
    await new Promise<void>((resolve, reject) => {
      this.conn.connect((err) => (err ? reject(err) : resolve()));
    });

    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      this.conn.execute({
        sqlText: sql,
        complete: (err, _stmt, rows) => {
          if (err) reject(err);
          else resolve((rows || []) as Record<string, unknown>[]);
        },
      });
    });

    if (rows.length === 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const columns = Object.keys(rows[0]);
    return { columns, rows, rowCount: rows.length };
  }

  async close(): Promise<void> {
    this.conn.destroy(() => {});
  }
}

registerConnector("snowflake", (creds, authMethod) => new SnowflakeConnector(creds, authMethod));
