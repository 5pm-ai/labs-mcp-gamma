import { BigQuery } from "@google-cloud/bigquery";
import type { WarehouseConnector, WarehouseResult } from "../types.js";
import { registerConnector } from "../registry.js";

class BigQueryConnector implements WarehouseConnector {
  private bq: BigQuery;

  constructor(credentials: Record<string, unknown>) {
    const serviceAccountKey = credentials.serviceAccountKey as Record<string, string> | undefined;
    if (!serviceAccountKey || typeof serviceAccountKey !== "object") {
      throw new Error("BigQuery requires serviceAccountKey in credentials");
    }

    const projectId = (credentials.projectId as string) || serviceAccountKey.project_id;
    if (!projectId) {
      throw new Error("BigQuery requires projectId");
    }

    this.bq = new BigQuery({ projectId, credentials: serviceAccountKey });
  }

  async execute(sql: string): Promise<WarehouseResult> {
    const [rows] = await this.bq.query(sql);
    if (!rows || rows.length === 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const columns = Object.keys(rows[0] as Record<string, unknown>);
    return { columns, rows: rows as Record<string, unknown>[], rowCount: rows.length };
  }

  async close(): Promise<void> {}
}

registerConnector("bigquery", (creds) => new BigQueryConnector(creds));
