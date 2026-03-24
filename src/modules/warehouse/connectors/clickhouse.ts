import { createClient } from "@clickhouse/client";
import type { WarehouseConnector, WarehouseResult } from "../types.js";
import { registerConnector } from "../registry.js";

class ClickHouseConnector implements WarehouseConnector {
  private client: ReturnType<typeof createClient>;

  constructor(credentials: Record<string, unknown>) {
    const url = credentials.url as string;
    if (!url) throw new Error("ClickHouse requires url");

    this.client = createClient({
      url,
      username: (credentials.username as string) || "default",
      password: (credentials.password as string) || "",
      database: (credentials.database as string) || "default",
    });
  }

  async execute(sql: string): Promise<WarehouseResult> {
    const result = await this.client.query({ query: sql, format: "JSONEachRow" });
    const rows = await result.json<Record<string, unknown>>();

    if (rows.length === 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const columns = Object.keys(rows[0]);
    return { columns, rows, rowCount: rows.length };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

registerConnector("clickhouse", (creds) => new ClickHouseConnector(creds));
