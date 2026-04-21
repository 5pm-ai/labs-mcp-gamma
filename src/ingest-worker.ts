import "dotenv/config";
import pg from "pg";
import { envelopeDecrypt } from "./modules/warehouse/crypto.js";
import { getConnectorFactory } from "./modules/warehouse/registry.js";
import { getSinkConnectorFactory } from "./modules/sink/registry.js";
import { runIngestPipeline } from "./modules/ingest/pipeline.js";
import type { IngestPipelineConfig } from "./modules/ingest/types.js";
import type { WarehouseType, AuthMethod } from "./modules/warehouse/types.js";
import type { SinkType } from "./modules/sink/types.js";

import "./modules/warehouse/connectors/bigquery.js";
import "./modules/warehouse/connectors/snowflake.js";
import "./modules/warehouse/connectors/clickhouse.js";
import "./modules/sink/connectors/pinecone.js";

const runId = process.env.INGEST_RUN_ID;
if (!runId) { console.error("INGEST_RUN_ID environment variable is required"); process.exit(1); }

const userId = process.env.INGEST_USER_ID;
if (!userId) { console.error("INGEST_USER_ID environment variable is required"); process.exit(1); }

const databaseUrl = process.env.INGEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) { console.error("INGEST_DATABASE_URL (or DATABASE_URL) environment variable is required"); process.exit(1); }

const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) { console.error("OPENAI_API_KEY environment variable is required"); process.exit(1); }

if (!process.env.KMS_KEY_NAME) { console.error("KMS_KEY_NAME environment variable is required"); process.exit(1); }

let shuttingDown = false;
process.on("SIGTSTP", () => { console.log("SIGTSTP received, pausing..."); shuttingDown = true; });
process.on("SIGCONT", () => { console.log("SIGCONT received, resuming..."); shuttingDown = false; });

async function withRlsContext<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.user_id = '${userId}'`);
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

async function main(): Promise<void> {
  console.log(`Ingest worker starting for run ${runId}, user ${userId}`);

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl!.includes("sslmode=no-verify") ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10000,
    max: 2,
  });
  pool.on("error", (err) => console.error("Pool error:", err));

  try {
    const { ingestId, ingest, whRow, sinkRow, keypairMaterial } = await withRlsContext(pool, async (client) => {
      const runResult = await client.query<{ ingest_id: string; status: string }>(
        "SELECT ingest_id, status FROM ingest_runs WHERE id = $1",
        [runId],
      );
      if (runResult.rows.length === 0) throw new Error(`Ingest run ${runId} not found`);
      if (runResult.rows[0].status !== "queued") throw new Error(`Run is '${runResult.rows[0].status}', expected 'queued'`);

      const ingestId = runResult.rows[0].ingest_id;

      const ingestResult = await client.query<{
        warehouse_connector_id: string; sink_connector_id: string;
        embedding_model: string; embedding_dimensions: number;
      }>(
        "SELECT warehouse_connector_id, sink_connector_id, embedding_model, embedding_dimensions FROM ingests WHERE id = $1",
        [ingestId],
      );
      if (ingestResult.rows.length === 0) throw new Error(`Ingest ${ingestId} not found`);

      const ingest = ingestResult.rows[0];

      const whResult = await client.query<{
        type: string; auth_method: string;
        credentials_enc: Buffer; credentials_iv: Buffer; credentials_tag: Buffer; wrapped_dek: Buffer;
        status: string;
        keypair_id: string | null;
      }>(
        "SELECT type, auth_method, credentials_enc, credentials_iv, credentials_tag, wrapped_dek, status, keypair_id FROM warehouse_connectors WHERE id = $1",
        [ingest.warehouse_connector_id],
      );
      if (whResult.rows.length === 0) throw new Error("Warehouse connector not found");
      if (whResult.rows[0].status !== "connected") throw new Error(`Warehouse is '${whResult.rows[0].status}'`);

      let keypairMaterial: { privateKeyPem: string; privateKeyPass?: string } | null = null;
      if (whResult.rows[0].keypair_id) {
        const kpResult = await client.query<{
          private_key_enc: Buffer; private_key_iv: Buffer; private_key_tag: Buffer;
          wrapped_dek: Buffer; status: string;
        }>(
          "SELECT private_key_enc, private_key_iv, private_key_tag, wrapped_dek, status FROM warehouse_keypairs WHERE id = $1",
          [whResult.rows[0].keypair_id],
        );
        const kp = kpResult.rows[0];
        if (!kp) throw new Error("Warehouse connector references a missing key pair");
        if (kp.status !== "active") throw new Error(`Warehouse connector key pair is '${kp.status}'`);
        const plaintext = await envelopeDecrypt({
          ciphertext: kp.private_key_enc, iv: kp.private_key_iv,
          authTag: kp.private_key_tag, wrappedDek: kp.wrapped_dek,
        });
        keypairMaterial = JSON.parse(plaintext) as { privateKeyPem: string; privateKeyPass?: string };
        await client.query(
          "UPDATE warehouse_keypairs SET last_used_at = now() WHERE id = $1",
          [whResult.rows[0].keypair_id],
        );
      }

      const sinkResult = await client.query<{
        type: string;
        credentials_enc: Buffer; credentials_iv: Buffer; credentials_tag: Buffer; wrapped_dek: Buffer;
        config: Record<string, unknown>; status: string;
      }>(
        "SELECT type, credentials_enc, credentials_iv, credentials_tag, wrapped_dek, config, status FROM sink_connectors WHERE id = $1",
        [ingest.sink_connector_id],
      );
      if (sinkResult.rows.length === 0) throw new Error("Sink connector not found");
      if (sinkResult.rows[0].status !== "connected") throw new Error(`Sink is '${sinkResult.rows[0].status}'`);

      return { ingestId, ingest, whRow: whResult.rows[0], sinkRow: sinkResult.rows[0], keypairMaterial };
    });

    const whCreds = JSON.parse(await envelopeDecrypt({
      ciphertext: whRow.credentials_enc, iv: whRow.credentials_iv,
      authTag: whRow.credentials_tag, wrappedDek: whRow.wrapped_dek,
    })) as Record<string, unknown>;

    if (keypairMaterial) {
      whCreds.privateKeyPem = keypairMaterial.privateKeyPem;
      if (keypairMaterial.privateKeyPass) {
        whCreds.privateKeyPass = keypairMaterial.privateKeyPass;
      }
    }

    const warehouseType = whRow.type as WarehouseType;
    const authMethod = whRow.auth_method as AuthMethod;
    const warehouseConnector = getConnectorFactory(warehouseType)(whCreds, authMethod);

    const sinkCreds = JSON.parse(await envelopeDecrypt({
      ciphertext: sinkRow.credentials_enc, iv: sinkRow.credentials_iv,
      authTag: sinkRow.credentials_tag, wrappedDek: sinkRow.wrapped_dek,
    })) as Record<string, unknown>;

    const sinkType = sinkRow.type as SinkType;
    const sinkConnector = getSinkConnectorFactory(sinkType)(sinkCreds, sinkRow.config);
    const sinkNamespace = (sinkRow.config.namespace as string) || undefined;

    await withRlsContext(pool, async (client) => {
      await client.query("UPDATE ingests SET status = 'running', updated_at = now() WHERE id = $1", [ingestId]);
    });

    const pipelineConfig: IngestPipelineConfig = {
      runId: runId!,
      ingestId,
      userId: userId!,
      warehouseConnectorId: ingest.warehouse_connector_id,
      sinkConnectorId: ingest.sink_connector_id,
      embeddingModel: ingest.embedding_model,
      embeddingDimensions: ingest.embedding_dimensions,
    };

    try {
      await runIngestPipeline(
        pipelineConfig, warehouseConnector, sinkConnector,
        warehouseType, sinkNamespace, openaiApiKey!, pool,
      );
      console.log("Ingest pipeline completed successfully");
    } finally {
      await warehouseConnector.close();
      await sinkConnector.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Ingest worker failed:", message);

    try {
      await withRlsContext(pool, async (client) => {
        await client.query(
          "UPDATE ingest_runs SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2 AND status != 'completed'",
          [message, runId],
        );
        const ingestRow = await client.query<{ ingest_id: string }>(
          "SELECT ingest_id FROM ingest_runs WHERE id = $1", [runId],
        );
        if (ingestRow.rows.length > 0) {
          await client.query(
            "UPDATE ingests SET status = 'error', last_run_id = $1, updated_at = now() WHERE id = $2",
            [runId, ingestRow.rows[0].ingest_id],
          );
        }
      });
    } catch (dbErr) {
      console.error("Failed to mark run as failed in DB:", dbErr);
    }

    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void shuttingDown;
main();
