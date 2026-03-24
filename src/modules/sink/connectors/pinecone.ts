import { Pinecone } from "@pinecone-database/pinecone";
import type { SinkConnector, SinkResult } from "../types.js";
import { registerSinkConnector } from "../registry.js";

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

  async close(): Promise<void> {}
}

registerSinkConnector("pinecone", (creds, config) => new PineconeConnector(creds, config));
