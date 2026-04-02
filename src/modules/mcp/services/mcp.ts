import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  LoggingLevel,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { config } from "../../../config.js";
import { isPostgresReady } from "../../shared/postgres.js";
import { listWarehouses, executeWarehouseQuery } from "../../warehouse/service.js";
import type { WarehouseInfo } from "../../warehouse/service.js";
import { listSinks, executeSinkTextQuery } from "../../sink/service.js";
import type { SinkInfo } from "../../sink/service.js";
import { withUserContext } from "../../shared/postgres.js";
import { resolveUserScope, buildSinkFilter } from "./scope.js";
import { validateAndRewriteSql } from "./sql-validator.js";

type ToolInput = Tool["inputSchema"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJsonSchema = (schema: z.ZodType<any>): ToolInput => {
  return z.toJSONSchema(schema) as ToolInput;
};

const WarehouseQuerySchema = z.object({
  sql: z.string().describe("SQL query to execute against the warehouse"),
  connectorId: z.string().describe("Warehouse connector ID (from tool description or warehouse://connectors resource)"),
});

const SinkQuerySchema = z.object({
  query: z.string().describe("Natural language query to search the data catalog. Examples: 'customer orders', 'revenue tables', 'user accounts schema'"),
  topK: z.number().default(10).describe("Number of nearest neighbors to return"),
  connectorId: z.string().describe("Sink connector ID (from tool description or sink://connectors resource)"),
  namespace: z.string().optional().describe("Pinecone namespace to search within"),
});

enum ToolName {
  WAREHOUSE = "warehouse",
  SINK = "sink",
  EXPLORE_WAREHOUSE = "explore_warehouse",
  EXPLORE_SINK = "explore_sink",
}

const WAREHOUSE_APP_URI = "ui://warehouse/app.html";
const SINK_APP_URI = "ui://sink/app.html";
const INGEST_CATALOG_URI = "ingest://catalog";

interface IngestCatalogEntry {
  ingestId: string;
  name: string;
  warehouseConnectorId: string;
  warehouseName: string;
  warehouseType: string;
  sinkName: string;
  sinkType: string;
  embeddingModel: string;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  schemasDiscovered: number;
  tablesDiscovered: number;
  columnsDiscovered: number;
  relationshipsDiscovered: number;
}

const SQL_DIALECT: Record<string, string> = {
  bigquery: "Google Standard SQL",
  snowflake: "Snowflake SQL",
  clickhouse: "ClickHouse SQL",
};

interface McpServerWrapper {
  server: Server;
  cleanup: () => void;
}

export const createMcpServer = (userId: string): McpServerWrapper => {
  const server = new Server(
    {
      name: "5pm/mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: {},
        tools: {},
        logging: {},
      },
    }
  );

  let logLevel: LoggingLevel = "debug";
  const LOG_LEVELS: LoggingLevel[] = [
    "debug", "info", "notice", "warning", "error", "critical", "alert", "emergency",
  ];

  const isWarehouseAvailable = () => config.kms.enabled && isPostgresReady();

  const getWarehouses = async (): Promise<WarehouseInfo[]> => {
    if (!isWarehouseAvailable()) return [];
    return listWarehouses(userId);
  };

  const getSinks = async (): Promise<SinkInfo[]> => {
    if (!isWarehouseAvailable()) return [];
    return listSinks(userId);
  };

  const getScopedConnectors = async () => {
    let warehouses = await getWarehouses();
    let sinks = await getSinks();

    if (isPostgresReady()) {
      const scope = await resolveUserScope(userId);
      if (scope !== null && scope.columns.length > 0) {
        const scopedWhIds = new Set(scope.columns.map((c) => c.connectorId));
        warehouses = warehouses.filter((w) => scopedWhIds.has(w.id));
        const scopedSinkIds = new Set<string>();
        try {
          const sinkResult = await withUserContext(userId, async (client) => {
            return client.query<{ sink_connector_id: string }>(
              `SELECT DISTINCT sink_connector_id FROM ingests
               WHERE warehouse_connector_id = ANY($1)
               AND deleted_at IS NULL AND sink_connector_id IS NOT NULL`,
              [[...scopedWhIds]],
            );
          });
          for (const r of sinkResult.rows) scopedSinkIds.add(r.sink_connector_id);
        } catch { /* best effort */ }
        if (scopedSinkIds.size > 0) sinks = sinks.filter((s) => scopedSinkIds.has(s.id));
      } else if (scope !== null && scope.columns.length === 0) {
        warehouses = [];
        sinks = [];
      }
    }

    return { warehouses, sinks };
  };

  const getIngestCatalog = async (): Promise<IngestCatalogEntry[]> => {
    if (!isWarehouseAvailable()) return [];
    try {
      const result = await withUserContext(userId, async (client) => {
        return client.query<{
          ingest_id: string; name: string;
          warehouse_connector_id: string;
          wh_name: string; wh_type: string;
          sink_name: string; sink_type: string;
          embedding_model: string;
          last_run_status: string | null; last_run_at: string | null;
          schemas_discovered: number; tables_discovered: number;
          columns_discovered: number; relationships_discovered: number;
        }>(
          `SELECT i.id AS ingest_id, i.name,
                  i.warehouse_connector_id,
                  wc.name AS wh_name, wc.type AS wh_type,
                  sc.name AS sink_name, sc.type AS sink_type,
                  i.embedding_model,
                  lr.status AS last_run_status, lr.completed_at AS last_run_at,
                  COALESCE(lr.schemas_discovered, 0) AS schemas_discovered,
                  COALESCE(lr.tables_discovered, 0) AS tables_discovered,
                  COALESCE(lr.columns_discovered, 0) AS columns_discovered,
                  COALESCE(lr.relationships_discovered, 0) AS relationships_discovered
           FROM ingests i
           JOIN warehouse_connectors wc ON wc.id = i.warehouse_connector_id
           JOIN sink_connectors sc ON sc.id = i.sink_connector_id
           LEFT JOIN ingest_runs lr ON lr.id = i.last_run_id
           ORDER BY i.created_at DESC`,
        );
      });
      return result.rows.map((r) => ({
        ingestId: r.ingest_id,
        name: r.name,
        warehouseConnectorId: r.warehouse_connector_id,
        warehouseName: r.wh_name,
        warehouseType: r.wh_type,
        sinkName: r.sink_name,
        sinkType: r.sink_type,
        embeddingModel: r.embedding_model,
        lastRunStatus: r.last_run_status,
        lastRunAt: r.last_run_at,
        schemasDiscovered: r.schemas_discovered,
        tablesDiscovered: r.tables_discovered,
        columnsDiscovered: r.columns_discovered,
        relationshipsDiscovered: r.relationships_discovered,
      }));
    } catch {
      return [];
    }
  };

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const { warehouses, sinks } = await getScopedConnectors();
    const resources = [
      {
        uri: "warehouse://connectors",
        name: "Warehouse Connectors",
        description: "Available data warehouse connectors for the authenticated user's team",
        mimeType: "application/json",
      },
      {
        uri: "sink://connectors",
        name: "Sink Connectors",
        description: "Available vector store sinks for the authenticated user's team",
        mimeType: "application/json",
      },
    ];

    if (warehouses.length > 0) {
      resources.push({
        uri: WAREHOUSE_APP_URI,
        name: "5pm Warehouse App",
        description: "Interactive SQL UI for warehouse queries. Used by the explore_warehouse tool.",
        mimeType: "text/html;profile=mcp-app",
      });
    }

    if (sinks.length > 0) {
      resources.push({
        uri: SINK_APP_URI,
        name: "5pm Sink App",
        description: "Interactive UI for data catalog search results. Used by the explore_sink tool.",
        mimeType: "text/html;profile=mcp-app",
      });
    }

    const catalog = sinks.length > 0 ? await getIngestCatalog() : [];
    if (catalog.length > 0) {
      resources.push({
        uri: INGEST_CATALOG_URI,
        name: "Ingest Catalog",
        description: "START HERE — Data topology manifest showing ingested warehouses, their schema/table/column counts, and warehouse-to-sink bindings. Read this first to understand what data is available, then use the sink tool to discover specific tables.",
        mimeType: "application/json",
      });
    }

    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri === "warehouse://connectors") {
      const { warehouses } = await getScopedConnectors();
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify(warehouses, null, 2),
        }],
      };
    }

    if (uri === "sink://connectors") {
      const { sinks } = await getScopedConnectors();
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify(sinks, null, 2),
        }],
      };
    }

    if (uri === WAREHOUSE_APP_URI) {
      const distDir = path.join(import.meta.dirname, "../../../apps");
      const html = await fs.readFile(path.join(distDir, "mcp-app.html"), "utf-8");
      return {
        contents: [{
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: html,
        }],
      };
    }

    if (uri === SINK_APP_URI) {
      const distDir = path.join(import.meta.dirname, "../../../apps");
      const html = await fs.readFile(path.join(distDir, "sink-app.html"), "utf-8");
      return {
        contents: [{
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: html,
        }],
      };
    }

    if (uri === INGEST_CATALOG_URI) {
      let catalog = await getIngestCatalog();
      if (isPostgresReady()) {
        const scope = await resolveUserScope(userId);
        if (scope !== null && scope.columns.length > 0) {
          const scopedWhIds = new Set(scope.columns.map((c) => c.connectorId));
          catalog = catalog.filter((c) => scopedWhIds.has(c.warehouseConnectorId ?? ""));
        } else if (scope !== null && scope.columns.length === 0) {
          catalog = [];
        }
      }
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify(catalog, null, 2),
        }],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // ---------------------------------------------------------------------------
  // Prompts
  // ---------------------------------------------------------------------------
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: "warehouse_guide",
          description: "Guide for querying data warehouses via the warehouse tool",
          arguments: [
            {
              name: "connectorId",
              description: "Optional connector ID to get dialect-specific guidance",
              required: false,
            },
          ],
        },
        {
          name: "sink_guide",
          description: "Guide for querying vector stores via the sink tool",
          arguments: [
            {
              name: "connectorId",
              description: "Optional connector ID to get sink-specific guidance",
              required: false,
            },
          ],
        },
        {
          name: "ingest_catalog_guide",
          description: "Guide for discovering data topology through the ingest catalog and sink tool",
          arguments: [],
        },
      ],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "warehouse_guide") {
      const warehouses = await getWarehouses();

      let guide: string;
      if (warehouses.length === 0) {
        guide = "No warehouse connectors are configured for your team. Ask your team admin to add one in the 5pm control plane.";
      } else {
        const connectorLines = warehouses.map(
          (w) => `- ${w.name} (${SQL_DIALECT[w.type] || w.type}) — id: ${w.id} — status: ${w.status}`,
        );

        const targetId = args?.connectorId as string | undefined;
        const target = targetId ? warehouses.find((w) => w.id === targetId) : undefined;
        const dialectHint = target
          ? `\n\nTarget connector "${target.name}" uses ${SQL_DIALECT[target.type] || target.type}. Write SQL in that dialect.`
          : "\n\nSpecify connectorId when calling the warehouse tool, and write SQL in the dialect matching the connector type.";

        guide = [
          "You have access to the following data warehouse connectors:",
          "",
          ...connectorLines,
          dialectHint,
          "",
          'Call the "warehouse" tool with { sql, connectorId } to execute queries.',
        ].join("\n");
      }

      return {
        messages: [{ role: "user", content: { type: "text", text: guide } }],
      };
    }

    if (name === "sink_guide") {
      const sinks = await getSinks();

      let guide: string;
      if (sinks.length === 0) {
        guide = "No vector store sinks are configured for your team. Ask your team admin to add one in the 5pm control plane.";
      } else {
        const connectorLines = sinks.map(
          (s) => `- ${s.name} (${s.type}) — id: ${s.id} — index: ${(s.config as Record<string, unknown>).indexName || "unknown"} — status: ${s.status}`,
        );

        const targetId = args?.connectorId as string | undefined;
        const target = targetId ? sinks.find((s) => s.id === targetId) : undefined;
        const targetHint = target
          ? `\n\nTarget sink "${target.name}" uses index "${(target.config as Record<string, unknown>).indexName || "unknown"}".`
          : "\n\nSpecify connectorId when calling the sink tool if you have multiple sinks.";

        guide = [
          "You have access to the following vector store sinks:",
          "",
          ...connectorLines,
          targetHint,
          "",
          'Call the "sink" tool with { vector, topK, connectorId?, namespace? } to perform similarity search.',
          "You must provide a pre-computed embedding vector matching the index dimension.",
        ].join("\n");
      }

      return {
        messages: [{ role: "user", content: { type: "text", text: guide } }],
      };
    }

    if (name === "ingest_catalog_guide") {
      const catalog = await getIngestCatalog();

      let guide: string;
      if (catalog.length === 0) {
        guide = "No ingest pipelines have been run. Ask your team admin to create and run an ingest in the 5pm control plane.";
      } else {
        const lines = catalog.map((c) => [
          `- "${c.name}": ${c.warehouseName} (${c.warehouseType}) → ${c.sinkName} (${c.sinkType})`,
          `  Model: ${c.embeddingModel} | Last run: ${c.lastRunStatus || "never"}`,
          `  Discovered: ${c.schemasDiscovered} schemas, ${c.tablesDiscovered} tables, ${c.columnsDiscovered} columns, ${c.relationshipsDiscovered} relationships`,
        ].join("\n"));

        guide = [
          "The ingest catalog shows which warehouses have been introspected and indexed into vector sinks.",
          "Read the ingest://catalog resource for the full manifest.",
          "",
          "To discover data topology:",
          '1. Use the "sink" tool with a semantic query vector to find relevant schemas/tables',
          "2. Each sink result includes metadata: warehouseConnectorId, schema, table, columns, relationships",
          "3. Use the warehouseConnectorId from sink results to query the actual warehouse for data",
          "",
          "Current ingests:",
          "",
          ...lines,
        ].join("\n");
      }

      return {
        messages: [{ role: "user", content: { type: "text", text: guide } }],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [];

    if (isWarehouseAvailable()) {
      const { warehouses, sinks } = await getScopedConnectors();

      const connectorList = warehouses.length > 0
        ? warehouses.map((w) => `${w.name} (${w.type}) id:${w.id}`).join("; ")
        : "none configured";

      const catalog = sinks.length > 0 ? await getIngestCatalog() : [];
      const hasCatalog = catalog.length > 0;

      const whDesc = hasCatalog
        ? `Execute a SQL statement against a data warehouse. IMPORTANT: Use the "sink" tool first to discover available schemas, tables, and columns before writing SQL. The sink contains an indexed catalog of the warehouse structure. Available connectors: ${connectorList}`
        : `Execute a SQL statement against a data warehouse. Available connectors: ${connectorList}`;

      const whIds = warehouses.map((w) => w.id);
      const whSchema = toJsonSchema(WarehouseQuerySchema);
      if (whIds.length > 0 && whSchema.properties && typeof whSchema.properties === "object") {
        (whSchema.properties as Record<string, Record<string, unknown>>).connectorId = {
          type: "string",
          description: `Warehouse connector ID. ${warehouses.map((w) => `"${w.id}" = ${w.name} (${w.type})`).join(", ")}`,
          enum: whIds,
        };
      }

      tools.push({
        name: ToolName.WAREHOUSE,
        description: whDesc,
        inputSchema: whSchema,
      });

      const sinkIds = sinks.map((s) => s.id);
      const catalogSummary = hasCatalog
        ? `. Indexed warehouses: ${catalog.map((c) => `${c.warehouseName} (${c.schemasDiscovered} schemas, ${c.tablesDiscovered} tables)`).join("; ")}`
        : "";

      const sinkSchema = toJsonSchema(SinkQuerySchema);
      if (sinkIds.length > 0 && sinkSchema.properties && typeof sinkSchema.properties === "object") {
        (sinkSchema.properties as Record<string, Record<string, unknown>>).connectorId = {
          type: "string",
          description: `Sink connector ID. ${sinks.map((s) => `"${s.id}" = ${s.name} (${s.type})`).join(", ")}`,
          enum: sinkIds,
        };
      }

      tools.push({
        name: ToolName.SINK,
        description:
          `Search the data catalog to discover database structure — schemas, tables, columns, and relationships. Use this tool to understand what data is available before querying a warehouse. Accepts a natural language query (e.g. "customer orders", "revenue by region"). Returns matching table descriptions with schema, column types, and foreign key relationships${catalogSummary}`,
        inputSchema: sinkSchema,
      });

      if (sinks.length > 0) {
        tools.push({
          name: ToolName.EXPLORE_SINK,
          description: `Visual explorer for data catalog search results. Same as the sink tool but renders results in an interactive UI. Use to visually browse discovered schemas, tables, columns, and relationships`,
          inputSchema: sinkSchema,
          _meta: { ui: { resourceUri: SINK_APP_URI } },
        });
      }

      if (warehouses.length > 0) {
        tools.push({
          name: ToolName.EXPLORE_WAREHOUSE,
          description: `Visual SQL explorer for warehouse query results. Same as the warehouse tool but renders results in an interactive table UI. Use after discovering tables via the sink tool`,
          inputSchema: whSchema,
          _meta: { ui: { resourceUri: WAREHOUSE_APP_URI } },
        });
      }
    }

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === ToolName.WAREHOUSE || name === ToolName.EXPLORE_WAREHOUSE) {
      const { sql, connectorId } = WarehouseQuerySchema.parse(args);

      let finalSql = sql;
      if (isPostgresReady()) {
        const scope = await resolveUserScope(userId);
        if (scope !== null) {
          if (scope.columns.length === 0) {
            return {
              content: [{ type: "text", text: "Access denied: you have no scope assigned. Contact your org admin to set up column-level access." }],
              isError: true,
            };
          }
          const validation = await validateAndRewriteSql(userId, connectorId, sql, scope);
          if (!validation.allowed) {
            return {
              content: [{ type: "text", text: validation.error ?? "Query denied by scope policy." }],
              isError: true,
            };
          }
          if (validation.rewrittenSql) {
            finalSql = validation.rewrittenSql;
          }
        }
      }

      const result = await executeWarehouseQuery(userId, connectorId, finalSql);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ columns: result.columns, rows: result.rows, rowCount: result.rowCount }, null, 2),
        }],
      };
    }

    if (name === ToolName.SINK || name === ToolName.EXPLORE_SINK) {
      const { query, topK, connectorId, namespace } = SinkQuerySchema.parse(args);

      if (!config.openai.apiKey) {
        return {
          content: [{ type: "text", text: "Sink text search unavailable: OPENAI_API_KEY not configured on the MCP server." }],
          isError: true,
        };
      }

      let sinkFilter: Record<string, unknown> | undefined;
      if (isPostgresReady()) {
        const scope = await resolveUserScope(userId);
        if (scope !== null) {
          if (scope.columns.length === 0) {
            return {
              content: [{ type: "text", text: "Access denied: you have no scope assigned. Contact your org admin to set up column-level access." }],
              isError: true,
            };
          }
          const warehouseIds = await withUserContext(userId, async (client) => {
            const r = await client.query<{ warehouse_connector_id: string }>(
              "SELECT DISTINCT warehouse_connector_id FROM ingests WHERE sink_connector_id = $1 AND deleted_at IS NULL AND warehouse_connector_id IS NOT NULL",
              [connectorId],
            );
            return r.rows.map((row) => row.warehouse_connector_id);
          });
          sinkFilter = buildSinkFilter(scope, warehouseIds);
        }
      }

      const result = await executeSinkTextQuery(userId, connectorId, query, topK, config.openai.apiKey, namespace, sinkFilter);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ matches: result.matches, namespace: result.namespace }, null, 2),
        }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------
  server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const { level } = request.params;
    logLevel = level;

    await server.notification({
      method: "notifications/message",
      params: {
        level: "debug",
        logger: "5pm-mcp",
        data: `Logging level set to: ${logLevel}`,
      },
    });

    return {};
  });

  // Suppress unused variable – logLevel is read by future log filtering
  void logLevel;
  void LOG_LEVELS;

  const cleanup = () => {};

  return { server, cleanup };
};
