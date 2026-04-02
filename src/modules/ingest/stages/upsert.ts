import type { SinkConnector, VectorRecord } from "../../sink/types.js";
import type { EmbeddedChunk } from "./embed.js";
import type { StageReporter } from "../reporter.js";

const UPSERT_BATCH_SIZE = 100;

export async function runUpsertToSink(
  embeddedChunks: EmbeddedChunk[],
  sinkConnector: SinkConnector,
  warehouseConnectorId: string,
  ingestId: string,
  namespace: string | undefined,
  reporter: StageReporter,
): Promise<number> {
  const stageKey = "upsert_to_sink";

  await reporter.updateStage(stageKey, {
    status: "running",
    startedAt: new Date(),
    itemsTotal: embeddedChunks.length,
  });
  await reporter.writeLog(stageKey, "info", `Upserting ${embeddedChunks.length} vector(s) to sink`);

  const records: VectorRecord[] = embeddedChunks.map((ec) => ({
    id: ec.chunk.id,
    values: ec.vector,
    metadata: {
      warehouseConnectorId,
      ingestId,
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

  let totalUpserted = 0;

  for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
    const batch = records.slice(i, i + UPSERT_BATCH_SIZE);
    const result = await sinkConnector.upsert(batch, namespace);
    totalUpserted += result.upsertedCount;

    await reporter.updateStage(stageKey, { itemsProcessed: totalUpserted });
    await reporter.updateRunMetrics({ vectorsUpserted: totalUpserted });
  }

  await reporter.updateStage(stageKey, { status: "done", completedAt: new Date() });
  await reporter.writeLog(stageKey, "info", `Upserted ${totalUpserted} vector(s)`);

  return totalUpserted;
}
