import { withUserContext } from "../shared/postgres.js";
import { envelopeDecrypt } from "../warehouse/crypto.js";
import { getSinkConnectorFactory } from "./registry.js";
import type { SinkType, SinkResult } from "./types.js";

import "./connectors/pinecone.js";

interface SinkRow {
  id: string;
  name: string;
  type: SinkType;
  credentials_enc: Buffer;
  credentials_iv: Buffer;
  credentials_tag: Buffer;
  wrapped_dek: Buffer;
  config: Record<string, unknown>;
  status: string;
}

export interface SinkInfo {
  id: string;
  name: string;
  type: SinkType;
  config: Record<string, unknown>;
  status: string;
}

export async function listSinks(userId: string): Promise<SinkInfo[]> {
  const result = await withUserContext(userId, async (client) => {
    return client.query<SinkInfo>(
      `SELECT id, name, type, config, status
       FROM sink_connectors
       ORDER BY created_at DESC`,
    );
  });
  return result.rows;
}

export async function executeSinkQuery(
  userId: string,
  connectorId: string,
  vector: number[],
  topK: number,
  namespace?: string,
): Promise<SinkResult> {
  const row = await withUserContext(userId, async (client) => {
    const result = await client.query<SinkRow>(
      `SELECT id, name, type, credentials_enc, credentials_iv, credentials_tag, wrapped_dek, config, status
       FROM sink_connectors
       WHERE id = $1`,
      [connectorId],
    );
    return result.rows[0];
  });

  if (!row) {
    throw new Error("Sink connector not found or access denied");
  }

  if (row.status !== "connected") {
    throw new Error(`Sink connector "${row.name}" is in ${row.status} state`);
  }

  const credentialsJson = await envelopeDecrypt({
    ciphertext: row.credentials_enc,
    iv: row.credentials_iv,
    authTag: row.credentials_tag,
    wrappedDek: row.wrapped_dek,
  });

  const credentials = JSON.parse(credentialsJson) as Record<string, unknown>;
  const factory = getSinkConnectorFactory(row.type);
  const connector = factory(credentials, row.config);

  try {
    return await connector.query(vector, topK, namespace);
  } finally {
    await connector.close();
  }
}
