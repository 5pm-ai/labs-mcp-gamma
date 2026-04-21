import pg from "pg";
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
  keypair_id: string | null;
}

/**
 * Resolve a referenced warehouse_keypairs row into the raw PEM + optional
 * passphrase. Returns null if the keypair is missing, retired, or not
 * visible to the caller via RLS. Reads inside the caller's `withUserContext`
 * transaction so `app.user_id` is set when RLS policies evaluate.
 */
async function loadKeypairPrivateMaterial(
  client: pg.PoolClient,
  keypairId: string,
): Promise<{ privateKeyPem: string; privateKeyPass?: string } | null> {
  const result = await client.query<{
    private_key_enc: Buffer;
    private_key_iv: Buffer;
    private_key_tag: Buffer;
    wrapped_dek: Buffer;
    status: string;
  }>(
    `SELECT private_key_enc, private_key_iv, private_key_tag, wrapped_dek, status
     FROM warehouse_keypairs WHERE id = $1`,
    [keypairId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.status !== "active") return null;

  const plaintext = await envelopeDecrypt({
    ciphertext: row.private_key_enc,
    iv: row.private_key_iv,
    authTag: row.private_key_tag,
    wrappedDek: row.wrapped_dek,
  });
  const parsed = JSON.parse(plaintext) as {
    privateKeyPem: string;
    privateKeyPass?: string;
  };
  return parsed;
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
  const resolved = await withUserContext(userId, async (client) => {
    const result = await client.query<ConnectorRow>(
      `SELECT id, name, type, auth_method,
              credentials_enc, credentials_iv, credentials_tag, wrapped_dek, status, keypair_id
       FROM warehouse_connectors
       WHERE id = $1`,
      [connectorId],
    );
    const row = result.rows[0];
    if (!row) return null;

    const credentialsJson = await envelopeDecrypt({
      ciphertext: row.credentials_enc,
      iv: row.credentials_iv,
      authTag: row.credentials_tag,
      wrappedDek: row.wrapped_dek,
    });
    const credentials = JSON.parse(credentialsJson) as Record<string, unknown>;

    if (row.keypair_id) {
      const material = await loadKeypairPrivateMaterial(client, row.keypair_id);
      if (!material) {
        throw new Error(
          `Warehouse connector "${row.name}" references a key pair that is retired or missing`,
        );
      }
      credentials.privateKeyPem = material.privateKeyPem;
      if (material.privateKeyPass) {
        credentials.privateKeyPass = material.privateKeyPass;
      }
      // Update last_used_at inside the same transaction so RLS still applies.
      await client.query(
        "UPDATE warehouse_keypairs SET last_used_at = now() WHERE id = $1",
        [row.keypair_id],
      );
    }

    return { row, credentials };
  });

  if (!resolved) {
    throw new Error("Warehouse connector not found or access denied");
  }

  const { row, credentials } = resolved;

  if (row.status !== "connected") {
    throw new Error(`Warehouse connector "${row.name}" is in ${row.status} state`);
  }

  const factory = getConnectorFactory(row.type);
  const connector = factory(credentials, row.auth_method);

  try {
    return await connector.execute(sql);
  } finally {
    await connector.close();
  }
}
