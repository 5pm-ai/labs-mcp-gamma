import pg from "pg";
import type { WarehouseConnector } from "../warehouse/types.js";
import type { SinkConnector } from "../sink/types.js";
import type { IngestPipelineConfig } from "./types.js";
import { PIPELINE_STAGES } from "./types.js";
import { StageReporter } from "./reporter.js";
import { OpenAIEmbedder } from "./embedder.js";
import { runPreflight } from "./stages/preflight.js";
import { runCrawl } from "./stages/crawl.js";
import { runExtractRelationships } from "./stages/relationships.js";
import { runGenerateDocuments } from "./stages/documents.js";
import { runChunkText } from "./stages/chunk.js";
import { runEmbedVectors } from "./stages/embed.js";
import { runUpsertToSink } from "./stages/upsert.js";

async function withRls(pool: pg.Pool, userId: string, fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.user_id = '${userId}'`);
    await fn(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function runIngestPipeline(
  config: IngestPipelineConfig,
  warehouseConnector: WarehouseConnector,
  sinkConnector: SinkConnector,
  warehouseType: string,
  sinkNamespace: string | undefined,
  openaiApiKey: string,
  pool: pg.Pool,
): Promise<void> {
  const reporter = new StageReporter(pool, config.runId, config.userId);

  await reporter.initStages(PIPELINE_STAGES);
  await reporter.startRun();
  await reporter.writeLog(null, "info", `Starting ingest pipeline for run ${config.runId}`);

  let currentStageKey = "";

  try {
    currentStageKey = "preflight";
    await runPreflight(warehouseConnector, sinkConnector, warehouseType, reporter);

    currentStageKey = "crawl_schemas";
    const crawlResult = await runCrawl(warehouseConnector, reporter);

    currentStageKey = "extract_relationships";
    const relationships = await runExtractRelationships(
      warehouseConnector, crawlResult.schemas, reporter,
    );

    currentStageKey = "generate_documents";
    const documents = await runGenerateDocuments(
      crawlResult.tables, crawlResult.columns, relationships, reporter,
    );

    currentStageKey = "chunk_text";
    const chunks = await runChunkText(documents, reporter);

    currentStageKey = "embed_vectors";
    const embedder = new OpenAIEmbedder(openaiApiKey);
    const { embeddedChunks } = await runEmbedVectors(
      chunks, embedder, config.embeddingModel, config.embeddingDimensions, reporter,
    );

    currentStageKey = "upsert_to_sink";
    await runUpsertToSink(
      embeddedChunks, sinkConnector,
      config.warehouseConnectorId, config.ingestId,
      sinkNamespace, reporter,
    );

    await reporter.completeRun("completed");
    await reporter.writeLog(null, "info", "Ingest pipeline completed successfully");

    await withRls(pool, config.userId, async (client) => {
      await client.query(
        "UPDATE ingests SET status = 'idle', last_run_id = $1, updated_at = now() WHERE id = $2",
        [config.runId, config.ingestId],
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await reporter.updateStage(currentStageKey, {
      status: "failed",
      completedAt: new Date(),
      errorMessage: message,
    });
    await reporter.skipRemainingStages(currentStageKey);
    await reporter.writeLog(currentStageKey, "error", message);
    await reporter.completeRun("failed", message);

    await withRls(pool, config.userId, async (client) => {
      await client.query(
        "UPDATE ingests SET status = 'error', last_run_id = $1, updated_at = now() WHERE id = $2",
        [config.runId, config.ingestId],
      );
    }).catch(() => {});

    throw err;
  }
}
