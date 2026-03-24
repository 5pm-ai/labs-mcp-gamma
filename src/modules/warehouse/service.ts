import { withUserContext } from "../shared/postgres.js";
import { envelopeDecrypt } from "./crypto.js";
import { getConnectorFactory } from "./registry.js";
import type { WarehouseType, AuthMethod, WarehouseResult } from "./types.js";

import "./connectors/bigquery.js";
import "./connectors/snowflake.js";
import "./connectors/clickhouse.js";

interface ConnectorRow {
  id: string;
  name: string;
  type: WarehouseType;
  auth_method: AuthMethod;
  credentials_enc: Buffer;
  credentials_iv: Buffer;
  credentials_tag: Buffer;
  wrapped_dek: Buffer;
  status: string;
}

export interface WarehouseInfo {
  id: string;
  name: string;
  type: WarehouseType;
  status: string;
}

export async function listWarehouses(userId: string): Promise<WarehouseInfo[]> {
  const result = await withUserContext(userId, async (client) => {
    return client.query<WarehouseInfo>(
      `SELECT id, name, type, status
       FROM warehouse_connectors
       ORDER BY created_at DESC`,
    );
  });
  return result.rows;
}

export async function executeWarehouseQuery(
  userId: string,
  connectorId: string,
  sql: string,
): Promise<WarehouseResult> {
  const row = await withUserContext(userId, async (client) => {
    const result = await client.query<ConnectorRow>(
      `SELECT id, name, type, auth_method,
              credentials_enc, credentials_iv, credentials_tag, wrapped_dek, status
       FROM warehouse_connectors
       WHERE id = $1`,
      [connectorId],
    );
    return result.rows[0];
  });

  if (!row) {
    throw new Error("Warehouse connector not found or access denied");
  }

  if (row.status !== "connected") {
    throw new Error(`Warehouse connector "${row.name}" is in ${row.status} state`);
  }

  const credentialsJson = await envelopeDecrypt({
    ciphertext: row.credentials_enc,
    iv: row.credentials_iv,
    authTag: row.credentials_tag,
    wrappedDek: row.wrapped_dek,
  });

  const credentials = JSON.parse(credentialsJson) as Record<string, unknown>;
  const factory = getConnectorFactory(row.type);
  const connector = factory(credentials, row.auth_method);

  try {
    return await connector.execute(sql);
  } finally {
    await connector.close();
  }
}
