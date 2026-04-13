import type { WarehouseConnector, SchemaInfo, RelationshipInfo } from "../../warehouse/types.js";
import type { StageReporter } from "../reporter.js";

export async function runExtractRelationships(
  connector: WarehouseConnector,
  schemas: SchemaInfo[],
  reporter: StageReporter,
): Promise<RelationshipInfo[]> {
  const stageKey = "extract_relationships";

  await reporter.updateStage(stageKey, {
    status: "running",
    startedAt: new Date(),
    itemsTotal: schemas.length,
  });
  await reporter.writeLog(stageKey, "info", "Extracting relationships across schemas...");

  const allRelationships: RelationshipInfo[] = [];

  for (let i = 0; i < schemas.length; i++) {
    const schema = schemas[i];
    const schemaLabel = schema.database ? `${schema.database}.${schema.schema}` : schema.schema;
    try {
      const rels = await connector.listRelationships(schema.schema, schema.database);
      allRelationships.push(...rels);
      if (rels.length > 0) {
        await reporter.writeLog(stageKey, "info", `  ${rels.length} relationship(s) in ${schemaLabel}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reporter.writeLog(stageKey, "warn", `  Relationship extraction skipped for ${schemaLabel}: ${msg}`);
    }
    await reporter.updateStage(stageKey, { itemsProcessed: i + 1 });
  }

  await reporter.updateRunMetrics({ relationshipsDiscovered: allRelationships.length });
  await reporter.updateStage(stageKey, { status: "done", completedAt: new Date() });
  await reporter.writeLog(stageKey, "info", `Extracted ${allRelationships.length} relationship(s) total`);

  return allRelationships;
}
