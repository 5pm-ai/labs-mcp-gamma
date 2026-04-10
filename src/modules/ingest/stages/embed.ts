import type { ChunkRecord } from "../types.js";
import type { OpenAIEmbedder } from "../embedder.js";
import type { StageReporter } from "../reporter.js";

export interface EmbeddedChunk {
  chunk: ChunkRecord;
  vector: number[];
}

const EMBED_BATCH_SIZE = 512;

export async function runEmbedAndStream(
  chunks: ChunkRecord[],
  embedder: OpenAIEmbedder,
  model: string,
  dimensions: number,
  reporter: StageReporter,
  onBatch: (batch: EmbeddedChunk[]) => Promise<void>,
): Promise<{ totalEmbedded: number; totalTokensUsed: number }> {
  const stageKey = "embed_vectors";

  await reporter.updateStage(stageKey, {
    status: "running",
    startedAt: new Date(),
    itemsTotal: chunks.length,
  });
  await reporter.writeLog(stageKey, "info", `Embedding ${chunks.length} chunk(s) with ${model} (${dimensions}d)`);

  let totalEmbedded = 0;
  let totalTokensUsed = 0;

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((c) => c.content);

    const result = await embedder.embedBatch(texts, model, dimensions);
    totalTokensUsed += result.tokensUsed;

    const embedded: EmbeddedChunk[] = batch.map((chunk, j) => ({ chunk, vector: result.vectors[j] }));
    await onBatch(embedded);
    totalEmbedded += embedded.length;

    await reporter.updateStage(stageKey, { itemsProcessed: Math.min(i + EMBED_BATCH_SIZE, chunks.length) });
    await reporter.updateRunMetrics({
      vectorsEmbedded: totalEmbedded,
      totalTokensUsed,
    });

    if (i + EMBED_BATCH_SIZE < chunks.length) {
      await reporter.writeLog(
        stageKey, "info",
        `Embedded ${totalEmbedded}/${chunks.length} chunks (${totalTokensUsed} tokens used)`,
      );
    }
  }

  await reporter.updateStage(stageKey, { status: "done", completedAt: new Date() });
  await reporter.writeLog(stageKey, "info", `Embedded ${totalEmbedded} chunk(s), ${totalTokensUsed} total tokens`);

  return { totalEmbedded, totalTokensUsed };
}
