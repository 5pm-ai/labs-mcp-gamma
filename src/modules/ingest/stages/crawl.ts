import type { WarehouseConnector, SchemaInfo, TableInfo, ColumnInfo } from "../../warehouse/types.js";
import type { StageReporter } from "../reporter.js";

export interface CrawlOutput {
  schemas: SchemaInfo[];
  tables: TableInfo[];
  columns: ColumnInfo[];
}

export async function runCrawl(
  connector: WarehouseConnector,
  reporter: StageReporter,
): Promise<CrawlOutput> {
  const stageKey = "crawl_schemas";

  await reporter.updateStage(stageKey, { status: "running", startedAt: new Date() });
  await reporter.writeLog(stageKey, "info", "Discovering schemas...");

  const schemas = await connector.listSchemas();
  await reporter.updateStage(stageKey, { itemsTotal: schemas.length });
  await reporter.writeLog(stageKey, "info", `Found ${schemas.length} schema(s)`);
  await reporter.updateRunMetrics({ schemasDiscovered: schemas.length });

  const allTables: TableInfo[] = [];
  const allColumns: ColumnInfo[] = [];

  for (let i = 0; i < schemas.length; i++) {
    const schema = schemas[i];
    const schemaLabel = schema.database ? `${schema.database}.${schema.schema}` : schema.schema;
    await reporter.writeLog(stageKey, "info", `Crawling schema: ${schemaLabel}`);

    const tables = await connector.listTables(schema.schema, schema.database);
    allTables.push(...tables);
    await reporter.writeLog(stageKey, "info", `  ${tables.length} table(s) in ${schemaLabel}`);

    for (const table of tables) {
      const columns = await connector.listColumns(schema.schema, table.table, schema.database);
      allColumns.push(...columns);
    }

    await reporter.updateStage(stageKey, { itemsProcessed: i + 1 });
    await reporter.updateRunMetrics({
      tablesDiscovered: allTables.length,
      columnsDiscovered: allColumns.length,
    });
  }

  await reporter.updateStage(stageKey, { status: "done", completedAt: new Date() });
  await reporter.writeLog(
    stageKey, "info",
    `Crawl complete: ${schemas.length} schemas, ${allTables.length} tables, ${allColumns.length} columns`,
  );

  return { schemas, tables: allTables, columns: allColumns };
}
