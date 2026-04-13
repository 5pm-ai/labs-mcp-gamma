import type { SinkConnector, VectorRecord } from "../../sink/types.js";
import type { EmbeddedChunk } from "./embed.js";
import type { StageReporter } from "../reporter.js";

const UPSERT_BATCH_SIZE = 100;

function toRecords(
  embeddedChunks: EmbeddedChunk[],
  warehouseConnectorId: string,
  ingestId: string,
): VectorRecord[] {
  return embeddedChunks.map((ec) => ({
    id: ec.chunk.id,
    values: ec.vector,
    metadata: {
      warehouseConnectorId,
      ingestId,
      database: ec.chunk.database ?? "",
      schema: ec.chunk.schema,
      table: ec.chunk.table,
      columns: ec.chunk.columns,
      relationships: ec.chunk.relationships.map(
        (r) => `${r.fromSchema}.${r.fromTable}.${r.fromColumn}->${r.toSchema}.${r.toTable}.${r.toColumn}`,
      ),
      chunkIndex: ec.chunk.chunkIndex,
      content: ec.chunk.content.slice(0, 500),
    },
  }));
}

export class StreamingUpserter {
  private sinkConnector: SinkConnector;
  private warehouseConnectorId: string;
  private ingestId: string;
  private namespace: string | undefined;
  private reporter: StageReporter;
  totalUpserted = 0;

  constructor(
    sinkConnector: SinkConnector,
    warehouseConnectorId: string,
    ingestId: string,
    namespace: string | undefined,
    reporter: StageReporter,
  ) {
    this.sinkConnector = sinkConnector;
    this.warehouseConnectorId = warehouseConnectorId;
    this.ingestId = ingestId;
    this.namespace = namespace;
    this.reporter = reporter;
  }

  async start(totalChunks: number): Promise<void> {
    await this.reporter.updateStage("upsert_to_sink", {
      status: "running",
      startedAt: new Date(),
      itemsTotal: totalChunks,
    });
    await this.reporter.writeLog("upsert_to_sink", "info", `Streaming upsert for ~${totalChunks} vector(s)`);
  }

  async upsertBatch(embeddedChunks: EmbeddedChunk[]): Promise<void> {
    const records = toRecords(embeddedChunks, this.warehouseConnectorId, this.ingestId);
    for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
      const batch = records.slice(i, i + UPSERT_BATCH_SIZE);
      const result = await this.sinkConnector.upsert(batch, this.namespace);
      this.totalUpserted += result.upsertedCount;
      await this.reporter.updateStage("upsert_to_sink", { itemsProcessed: this.totalUpserted });
      await this.reporter.updateRunMetrics({ vectorsUpserted: this.totalUpserted });
    }
  }

  async finish(): Promise<void> {
    await this.reporter.updateStage("upsert_to_sink", { status: "done", completedAt: new Date() });
    await this.reporter.writeLog("upsert_to_sink", "info", `Upserted ${this.totalUpserted} vector(s)`);
  }
}
