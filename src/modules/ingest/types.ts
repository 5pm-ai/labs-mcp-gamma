import type { SchemaInfo, TableInfo, ColumnInfo, RelationshipInfo } from "../warehouse/types.js";

export interface StageDefinition {
  key: string;
  label: string;
  order: number;
}

export interface StageUpdate {
  status?: "pending" | "running" | "done" | "failed" | "skipped";
  startedAt?: Date;
  completedAt?: Date;
  itemsProcessed?: number;
  itemsTotal?: number;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface RunMetrics {
  schemasDiscovered?: number;
  tablesDiscovered?: number;
  columnsDiscovered?: number;
  relationshipsDiscovered?: number;
  documentsGenerated?: number;
  chunksCreated?: number;
  vectorsEmbedded?: number;
  vectorsUpserted?: number;
  totalTokensUsed?: number;
}

export interface CrawlResult {
  schemas: SchemaInfo[];
  tables: TableInfo[];
  columns: ColumnInfo[];
  relationships: RelationshipInfo[];
}

export interface DocumentRecord {
  id: string;
  schema: string;
  table: string;
  content: string;
  columns: string[];
  relationships: RelationshipInfo[];
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  schema: string;
  table: string;
  content: string;
  columns: string[];
  relationships: RelationshipInfo[];
  chunkIndex: number;
}

export interface IngestPipelineConfig {
  runId: string;
  ingestId: string;
  userId: string;
  warehouseConnectorId: string;
  sinkConnectorId: string;
  embeddingModel: string;
  embeddingDimensions: number;
}

export const PIPELINE_STAGES: StageDefinition[] = [
  { key: "preflight", label: "Preflight Check", order: 0 },
  { key: "crawl_schemas", label: "Crawl Schemas", order: 1 },
  { key: "persist_catalog", label: "Persist Catalog", order: 2 },
  { key: "extract_relationships", label: "Extract Relationships", order: 3 },
  { key: "generate_documents", label: "Generate Documents", order: 4 },
  { key: "chunk_text", label: "Chunk Text", order: 5 },
  { key: "embed_vectors", label: "Embed Vectors", order: 6 },
  { key: "upsert_to_sink", label: "Upsert to Sink", order: 7 },
];
