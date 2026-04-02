export type SinkType = "pinecone";
export type SinkAuthMethod = "api_key";

export interface SinkMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface SinkResult {
  matches: SinkMatch[];
  namespace: string;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface UpsertResult {
  upsertedCount: number;
}

export interface SinkConnector {
  query(vector: number[], topK: number, namespace?: string, filter?: Record<string, unknown>): Promise<SinkResult>;
  upsert(records: VectorRecord[], namespace?: string): Promise<UpsertResult>;
  close(): Promise<void>;
}

export type SinkConnectorFactory = (
  credentials: Record<string, unknown>,
  sinkConfig: Record<string, unknown>,
) => SinkConnector;
