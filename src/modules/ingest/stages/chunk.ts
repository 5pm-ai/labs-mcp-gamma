import type { DocumentRecord, ChunkRecord } from "../types.js";
import type { StageReporter } from "../reporter.js";

const TARGET_CHUNK_CHARS = 1500;
const OVERLAP_CHARS = 200;

function splitIntoChunks(text: string): string[] {
  if (text.length <= TARGET_CHUNK_CHARS) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + TARGET_CHUNK_CHARS, text.length);

    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > start + TARGET_CHUNK_CHARS / 2) {
        end = lastNewline + 1;
      }
    }

    chunks.push(text.slice(start, end));
    start = Math.max(start + 1, end - OVERLAP_CHARS);
  }

  return chunks;
}

export async function runChunkText(
  documents: DocumentRecord[],
  reporter: StageReporter,
): Promise<ChunkRecord[]> {
  const stageKey = "chunk_text";

  await reporter.updateStage(stageKey, {
    status: "running",
    startedAt: new Date(),
    itemsTotal: documents.length,
  });
  await reporter.writeLog(stageKey, "info", `Chunking ${documents.length} document(s)`);

  const allChunks: ChunkRecord[] = [];

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const textChunks = splitIntoChunks(doc.content);

    for (let j = 0; j < textChunks.length; j++) {
      allChunks.push({
        id: `${doc.id}_chunk_${j}`,
        documentId: doc.id,
        schema: doc.schema,
        table: doc.table,
        content: textChunks[j],
        columns: doc.columns,
        relationships: doc.relationships,
        chunkIndex: j,
      });
    }

    await reporter.updateStage(stageKey, { itemsProcessed: i + 1 });
  }

  await reporter.updateRunMetrics({ chunksCreated: allChunks.length });
  await reporter.updateStage(stageKey, { status: "done", completedAt: new Date() });
  await reporter.writeLog(stageKey, "info", `Created ${allChunks.length} chunk(s) from ${documents.length} document(s)`);

  return allChunks;
}
