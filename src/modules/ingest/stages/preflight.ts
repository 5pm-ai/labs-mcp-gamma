import type { WarehouseConnector } from "../../warehouse/types.js";
import type { SinkConnector } from "../../sink/types.js";
import type { StageReporter } from "../reporter.js";

const WH_ERROR_HINTS: Record<string, string> = {
  bigquery: "Ensure the service account has roles/bigquery.metadataViewer or roles/bigquery.dataViewer",
  snowflake: "Ensure the role has USAGE on the database and schemas",
  clickhouse: "Ensure the user can read system.tables and system.columns",
};

export async function runPreflight(
  warehouseConnector: WarehouseConnector,
  sinkConnector: SinkConnector,
  warehouseType: string,
  reporter: StageReporter,
): Promise<void> {
  const stageKey = "preflight";

  await reporter.updateStage(stageKey, { status: "running", startedAt: new Date() });
  await reporter.writeLog(stageKey, "info", "Starting preflight checks");

  await reporter.writeLog(stageKey, "info", "Testing warehouse introspection access...");
  try {
    const schemas = await warehouseConnector.listSchemas();
    await reporter.writeLog(stageKey, "info", `Warehouse accessible — ${schemas.length} schema(s) visible`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = WH_ERROR_HINTS[warehouseType] || "Check connector credentials and permissions";
    throw new Error(`Warehouse introspection failed: ${message}. ${hint}`);
  }

  await reporter.writeLog(stageKey, "info", "Testing sink write access...");
  try {
    const testId = `__preflight_test_${Date.now()}`;
    await sinkConnector.upsert(
      [{ id: testId, values: new Array(8).fill(0), metadata: { _preflight: true } }],
    );
    await reporter.writeLog(stageKey, "info", "Sink write access confirmed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Sink write test failed: ${message}. Ensure the API key has write access to the index.`);
  }

  await reporter.updateStage(stageKey, { status: "done", completedAt: new Date() });
  await reporter.writeLog(stageKey, "info", "Preflight checks passed");
}
