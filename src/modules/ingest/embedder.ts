export interface EmbedBatchResult {
  vectors: number[][];
  tokensUsed: number;
}

export class OpenAIEmbedder {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.openai.com/v1") {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for embedding");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async embedBatch(
    texts: string[],
    model: string,
    dimensions: number,
  ): Promise<EmbedBatchResult> {
    if (texts.length === 0) return { vectors: [], tokensUsed: 0 };

    const MAX_BATCH = 2048;
    const allVectors: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const result = await this.callApi(batch, model, dimensions);
      allVectors.push(...result.vectors);
      totalTokens += result.tokensUsed;
    }

    return { vectors: allVectors, tokensUsed: totalTokens };
  }

  private async callApi(
    texts: string[],
    model: string,
    dimensions: number,
    retries = 3,
  ): Promise<EmbedBatchResult> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ input: texts, model, dimensions }),
        });

        if (response.status === 429 && attempt < retries) {
          const retryAfter = Number(response.headers.get("retry-after") || "1");
          await this.sleep(retryAfter * 1000 * Math.pow(2, attempt));
          continue;
        }

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`OpenAI embedding API error ${response.status}: ${body}`);
        }

        const json = await response.json() as {
          data: Array<{ embedding: number[]; index: number }>;
          usage: { total_tokens: number };
        };

        const sorted = json.data.sort((a, b) => a.index - b.index);
        return {
          vectors: sorted.map((d) => d.embedding),
          tokensUsed: json.usage.total_tokens,
        };
      } catch (err) {
        if (attempt === retries) throw err;
        await this.sleep(1000 * Math.pow(2, attempt));
      }
    }

    throw new Error("Exhausted retries for OpenAI embedding API");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
