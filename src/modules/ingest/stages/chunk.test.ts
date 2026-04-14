import { jest, describe, it, expect } from "@jest/globals";

const mockReporter = {
  updateStage: jest.fn(async () => {}),
  writeLog: jest.fn(async () => {}),
  updateRunMetrics: jest.fn(async () => {}),
};

const { runChunkText } = await import("./chunk.js");

function makeDoc(id: string, contentLength: number) {
  const line = "  - COL_NAME: VARCHAR (NOT NULL)\n";
  const lines = Math.ceil(contentLength / line.length);
  const content = "Table: SCHEMA.TABLE\n\nColumns:\n" + line.repeat(lines);
  return {
    id,
    schema: "S",
    table: "T",
    content: content.slice(0, contentLength),
    columns: ["c"],
    relationships: [],
  };
}

describe("splitIntoChunks (via runChunkText)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("produces 1 chunk for a small document (< 1500 chars)", async () => {
    const doc = makeDoc("small", 500);
    const chunks = await runChunkText([doc], mockReporter as never);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(doc.content);
  });

  it("produces 1 chunk for a document exactly at the limit", async () => {
    const doc = makeDoc("exact", 1500);
    const chunks = await runChunkText([doc], mockReporter as never);
    expect(chunks).toHaveLength(1);
  });

  it("produces 2 chunks for a document slightly over the limit", async () => {
    const doc = makeDoc("over", 1800);
    const chunks = await runChunkText([doc], mockReporter as never);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content.length).toBeGreaterThan(700);
    expect(chunks[1].content.length).toBeGreaterThan(200);
  });

  it("does NOT produce micro-chunk tail for a ~2800 char document", async () => {
    const doc = makeDoc("medium", 2800);
    const chunks = await runChunkText([doc], mockReporter as never);
    expect(chunks.length).toBeLessThanOrEqual(4);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(200);
    }
  });

  it("handles a 300-column table (~20k chars) without exploding chunk count", async () => {
    const doc = makeDoc("large", 19500);
    const chunks = await runChunkText([doc], mockReporter as never);
    expect(chunks.length).toBeGreaterThanOrEqual(10);
    expect(chunks.length).toBeLessThanOrEqual(20);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(200);
    }
  });

  it("every chunk has correct metadata from the document", async () => {
    const doc = makeDoc("meta", 3000);
    const chunks = await runChunkText([doc], mockReporter as never);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].id).toBe(`meta_chunk_${i}`);
      expect(chunks[i].documentId).toBe("meta");
      expect(chunks[i].schema).toBe("S");
      expect(chunks[i].table).toBe("T");
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  it("chunks cover the full document content", async () => {
    const doc = makeDoc("coverage", 5000);
    const chunks = await runChunkText([doc], mockReporter as never);
    const lastChunk = chunks[chunks.length - 1];
    expect(doc.content.endsWith(lastChunk.content.slice(-50))).toBe(true);
    expect(chunks[0].content.startsWith(doc.content.slice(0, 50))).toBe(true);
  });

  it("multiple documents each chunk independently (no cross-contamination)", async () => {
    const docs = [makeDoc("a", 3000), makeDoc("b", 500), makeDoc("c", 8000)];
    const chunks = await runChunkText(docs, mockReporter as never);
    const byDoc = new Map<string, number>();
    for (const c of chunks) {
      byDoc.set(c.documentId, (byDoc.get(c.documentId) || 0) + 1);
    }
    expect(byDoc.get("a")!).toBeLessThanOrEqual(5);
    expect(byDoc.get("b")).toBe(1);
    expect(byDoc.get("c")!).toBeLessThanOrEqual(10);
  });

  it("regression: 244 tables should produce < 2000 total chunks, not 20k+", async () => {
    const docs = Array.from({ length: 244 }, (_, i) => {
      const cols = 30 + Math.floor(Math.random() * 70);
      return makeDoc(`doc_${i}`, cols * 55 + 100);
    });
    const chunks = await runChunkText(docs, mockReporter as never);
    expect(chunks.length).toBeLessThan(2000);
    expect(chunks.length).toBeGreaterThan(244);
  });
});
