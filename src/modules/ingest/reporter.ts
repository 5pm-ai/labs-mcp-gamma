import pg from "pg";
import type { StageDefinition, StageUpdate, RunMetrics } from "./types.js";

export class StageReporter {
  private pool: pg.Pool;
  private runId: string;
  private userId: string;

  constructor(pool: pg.Pool, runId: string, userId: string) {
    this.pool = pool;
    this.runId = runId;
    this.userId = userId;
  }

  private async withContext<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL app.user_id = '${this.userId}'`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async initStages(stages: StageDefinition[]): Promise<void> {
    await this.withContext(async (client) => {
      for (const stage of stages) {
        await client.query(
          `INSERT INTO ingest_run_stages (run_id, stage_key, stage_label, stage_order, status)
           VALUES ($1, $2, $3, $4, 'pending')
           ON CONFLICT (run_id, stage_key) DO NOTHING`,
          [this.runId, stage.key, stage.label, stage.order],
        );
      }
    });
  }

  async updateStage(stageKey: string, update: StageUpdate): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [this.runId, stageKey];
    let idx = 3;

    if (update.status !== undefined) { sets.push(`status = $${idx++}`); params.push(update.status); }
    if (update.startedAt !== undefined) { sets.push(`started_at = $${idx++}`); params.push(update.startedAt); }
    if (update.completedAt !== undefined) { sets.push(`completed_at = $${idx++}`); params.push(update.completedAt); }
    if (update.itemsProcessed !== undefined) { sets.push(`items_processed = $${idx++}`); params.push(update.itemsProcessed); }
    if (update.itemsTotal !== undefined) { sets.push(`items_total = $${idx++}`); params.push(update.itemsTotal); }
    if (update.errorMessage !== undefined) { sets.push(`error_message = $${idx++}`); params.push(update.errorMessage); }
    if (update.metadata !== undefined) { sets.push(`metadata = $${idx++}`); params.push(JSON.stringify(update.metadata)); }

    if (sets.length === 0) return;

    await this.withContext(async (client) => {
      await client.query(
        `UPDATE ingest_run_stages SET ${sets.join(", ")} WHERE run_id = $1 AND stage_key = $2`,
        params,
      );
    });
  }

  async writeLog(
    stageKey: string | null,
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.withContext(async (client) => {
      await client.query(
        `INSERT INTO ingest_run_logs (run_id, stage_key, level, message, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [this.runId, stageKey, level, message, JSON.stringify(metadata || {})],
      );
    });
  }

  async updateRunMetrics(metrics: RunMetrics): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [this.runId];
    let idx = 2;

    const fields: [keyof RunMetrics, string][] = [
      ["schemasDiscovered", "schemas_discovered"],
      ["tablesDiscovered", "tables_discovered"],
      ["columnsDiscovered", "columns_discovered"],
      ["relationshipsDiscovered", "relationships_discovered"],
      ["documentsGenerated", "documents_generated"],
      ["chunksCreated", "chunks_created"],
      ["vectorsEmbedded", "vectors_embedded"],
      ["vectorsUpserted", "vectors_upserted"],
      ["totalTokensUsed", "total_tokens_used"],
    ];

    for (const [tsKey, dbKey] of fields) {
      if (metrics[tsKey] !== undefined) { sets.push(`${dbKey} = $${idx++}`); params.push(metrics[tsKey]); }
    }

    if (sets.length === 0) return;

    await this.withContext(async (client) => {
      await client.query(`UPDATE ingest_runs SET ${sets.join(", ")} WHERE id = $1`, params);
    });
  }

  async startRun(): Promise<void> {
    await this.withContext(async (client) => {
      await client.query("UPDATE ingest_runs SET status = 'running', started_at = now() WHERE id = $1", [this.runId]);
    });
  }

  async completeRun(status: "completed" | "failed", errorMessage?: string): Promise<void> {
    await this.withContext(async (client) => {
      await client.query(
        "UPDATE ingest_runs SET status = $1, completed_at = now(), error_message = $2 WHERE id = $3",
        [status, errorMessage || null, this.runId],
      );
    });
  }

  async skipRemainingStages(afterStageKey: string): Promise<void> {
    await this.withContext(async (client) => {
      await client.query(
        `UPDATE ingest_run_stages SET status = 'skipped'
         WHERE run_id = $1 AND status = 'pending'
         AND stage_order > (SELECT stage_order FROM ingest_run_stages WHERE run_id = $1 AND stage_key = $2)`,
        [this.runId, afterStageKey],
      );
    });
  }
}
