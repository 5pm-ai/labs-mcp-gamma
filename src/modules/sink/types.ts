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

export interface SinkConnector {
  query(vector: number[], topK: number, namespace?: string): Promise<SinkResult>;
  close(): Promise<void>;
}

export type SinkConnectorFactory = (
  credentials: Record<string, unknown>,
  sinkConfig: Record<string, unknown>,
) => SinkConnector;
