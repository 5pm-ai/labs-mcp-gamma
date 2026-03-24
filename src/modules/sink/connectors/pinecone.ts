import { Pinecone, type RecordMetadata } from "@pinecone-database/pinecone";
import type { SinkConnector, SinkResult, VectorRecord, UpsertResult } from "../types.js";
import { registerSinkConnector } from "../registry.js";

const MAX_REQUEST_BYTES = 1.8 * 1024 * 1024;
const METADATA_OVERHEAD_PER_RECORD = 1024;

class PineconeConnector implements SinkConnector {
  private pc: Pinecone;
  private indexName: string;
  private defaultNamespace: string;

  constructor(credentials: Record<string, unknown>, sinkConfig: Record<string, unknown>) {
    const apiKey = credentials.apiKey as string;
    if (!apiKey) throw new Error("Pinecone requires apiKey");

    this.indexName = (sinkConfig.indexName as string) || "";
    if (!this.indexName) throw new Error("Pinecone requires indexName in config");

    this.defaultNamespace = (sinkConfig.namespace as string) || "";
    this.pc = new Pinecone({ apiKey });
  }

  async query(vector: number[], topK: number, namespace?: string): Promise<SinkResult> {
    const index = this.pc.index(this.indexName);
    const ns = namespace || this.defaultNamespace;
    const target = ns ? index.namespace(ns) : index;

    const response = await target.query({
      vector,
      topK,
      includeMetadata: true,
    });

    return {
      matches: (response.matches || []).map((m) => ({
        id: m.id,
        score: m.score,
        metadata: m.metadata as Record<string, unknown> | undefined,
      })),
      namespace: response.namespace || ns || "",
    };
  }

  async upsert(records: VectorRecord[], namespace?: string): Promise<UpsertResult> {
    const index = this.pc.index(this.indexName);
    const ns = namespace || this.defaultNamespace;
    const target = ns ? index.namespace(ns) : index;

    const dim = records.length > 0 ? records[0].values.length : 1536;
    const bytesPerRecord = (dim * 4) + METADATA_OVERHEAD_PER_RECORD;
    const batchSize = Math.max(1, Math.floor(MAX_REQUEST_BYTES / bytesPerRecord));

    let upsertedCount = 0;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await target.upsert({
        records: batch.map((r) => ({
          id: r.id,
          values: r.values,
          metadata: r.metadata as RecordMetadata | undefined,
        })),
      });
      upsertedCount += batch.length;
    }

    return { upsertedCount };
  }

  async close(): Promise<void> {}
}

registerSinkConnector("pinecone", (creds, config) => new PineconeConnector(creds, config));
