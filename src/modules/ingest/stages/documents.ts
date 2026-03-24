import type { TableInfo, ColumnInfo, RelationshipInfo } from "../../warehouse/types.js";
import type { DocumentRecord } from "../types.js";
import type { StageReporter } from "../reporter.js";

function buildTableDocument(
  table: TableInfo,
  columns: ColumnInfo[],
  inboundRels: RelationshipInfo[],
  outboundRels: RelationshipInfo[],
): string {
  const lines: string[] = [];

  lines.push(`Table: ${table.schema}.${table.table}`);
  if (table.comment) lines.push(`Description: ${table.comment}`);
  if (table.rowCount != null) lines.push(`Approximate rows: ${table.rowCount.toLocaleString()}`);
  lines.push("");

  lines.push("Columns:");
  for (const col of columns) {
    const flags: string[] = [];
    if (col.isPrimaryKey) flags.push("PK");
    if (!col.nullable) flags.push("NOT NULL");
    if (col.comment) flags.push(col.comment);
    const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    lines.push(`  - ${col.column}: ${col.dataType}${flagStr}`);
  }

  if (outboundRels.length > 0) {
    lines.push("");
    lines.push("Foreign keys (this table references):");
    for (const rel of outboundRels) {
      lines.push(`  - ${rel.fromColumn} -> ${rel.toSchema}.${rel.toTable}.${rel.toColumn} [${rel.constraintName}]`);
    }
  }

  if (inboundRels.length > 0) {
    lines.push("");
    lines.push("Referenced by:");
    for (const rel of inboundRels) {
      lines.push(`  - ${rel.fromSchema}.${rel.fromTable}.${rel.fromColumn} -> ${rel.toColumn} [${rel.constraintName}]`);
    }
  }

  return lines.join("\n");
}

export async function runGenerateDocuments(
  tables: TableInfo[],
  columns: ColumnInfo[],
  relationships: RelationshipInfo[],
  reporter: StageReporter,
): Promise<DocumentRecord[]> {
  const stageKey = "generate_documents";

  await reporter.updateStage(stageKey, {
    status: "running",
    startedAt: new Date(),
    itemsTotal: tables.length,
  });
  await reporter.writeLog(stageKey, "info", `Generating documents for ${tables.length} table(s)`);

  const columnsByTable = new Map<string, ColumnInfo[]>();
  for (const col of columns) {
    const key = `${col.schema}.${col.table}`;
    const list = columnsByTable.get(key) || [];
    list.push(col);
    columnsByTable.set(key, list);
  }

  const documents: DocumentRecord[] = [];

  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    const key = `${table.schema}.${table.table}`;
    const tableCols = columnsByTable.get(key) || [];

    const outbound = relationships.filter(
      (r) => r.fromSchema === table.schema && r.fromTable === table.table,
    );
    const inbound = relationships.filter(
      (r) => r.toSchema === table.schema && r.toTable === table.table,
    );

    const content = buildTableDocument(table, tableCols, inbound, outbound);

    documents.push({
      id: `doc_${table.schema}_${table.table}`,
      schema: table.schema,
      table: table.table,
      content,
      columns: tableCols.map((c) => c.column),
      relationships: [...outbound, ...inbound],
    });

    await reporter.updateStage(stageKey, { itemsProcessed: i + 1 });
  }

  await reporter.updateRunMetrics({ documentsGenerated: documents.length });
  await reporter.updateStage(stageKey, { status: "done", completedAt: new Date() });
  await reporter.writeLog(stageKey, "info", `Generated ${documents.length} document(s)`);

  return documents;
}
