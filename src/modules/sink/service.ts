import { withUserContext } from "../shared/postgres.js";
import { envelopeDecrypt } from "../warehouse/crypto.js";
import { getSinkConnectorFactory } from "./registry.js";
import { OpenAIEmbedder } from "../ingest/embedder.js";
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
  embeddingModel: string | null;
  embeddingDimensions: number | null;
}

export async function listSinks(userId: string): Promise<SinkInfo[]> {
  const result = await withUserContext(userId, async (client) => {
    return client.query<{
      id: string; name: string; type: SinkType;
      config: Record<string, unknown>; status: string;
      embedding_model: string | null; embedding_dimensions: number | null;
    }>(
      `SELECT id, name, type, config, status, embedding_model, embedding_dimensions
       FROM sink_connectors
       ORDER BY created_at DESC`,
    );
  });
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    config: r.config,
    status: r.status,
    embeddingModel: r.embedding_model,
    embeddingDimensions: r.embedding_dimensions,
  }));
}

export async function executeSinkQuery(
  userId: string,
  connectorId: string,
  vector: number[],
  topK: number,
  namespace?: string,
  filter?: Record<string, unknown>,
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
    return await connector.query(vector, topK, namespace, filter);
  } finally {
    await connector.close();
  }
}

interface SinkRowWithEmbedding extends SinkRow {
  embedding_model: string | null;
  embedding_dimensions: number | null;
}

export async function executeSinkTextQuery(
  userId: string,
  connectorId: string,
  query: string,
  topK: number,
  openaiApiKey: string,
  namespace?: string,
  filter?: Record<string, unknown>,
): Promise<SinkResult> {
  const row = await withUserContext(userId, async (client) => {
    const result = await client.query<SinkRowWithEmbedding>(
      `SELECT id, name, type, credentials_enc, credentials_iv, credentials_tag, wrapped_dek, config, status,
              embedding_model, embedding_dimensions
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

  let model = row.embedding_model;
  let dimensions = row.embedding_dimensions;

  if (!model || !dimensions) {
    const ingestRow = await withUserContext(userId, async (client) => {
      const r = await client.query<{ embedding_model: string; embedding_dimensions: number }>(
        "SELECT embedding_model, embedding_dimensions FROM ingests WHERE sink_connector_id = $1 ORDER BY created_at DESC LIMIT 1",
        [connectorId],
      );
      return r.rows[0];
    });
    if (ingestRow) {
      model = model || ingestRow.embedding_model;
      dimensions = dimensions || ingestRow.embedding_dimensions;
    }
  }

  if (!model || !dimensions) {
    throw new Error("Sink has no embedding model configured and no ingests found. Set embedding_model and embedding_dimensions on the sink connector.");
  }

  const embedder = new OpenAIEmbedder(openaiApiKey);
  const { vectors } = await embedder.embedBatch([query], model, dimensions);

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
    return await connector.query(vectors[0], topK, namespace, filter);
  } finally {
    await connector.close();
  }
}
