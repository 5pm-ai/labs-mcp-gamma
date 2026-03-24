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
import { listSinks, executeSinkQuery } from "../../sink/service.js";
import type { SinkInfo } from "../../sink/service.js";

type ToolInput = Tool["inputSchema"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJsonSchema = (schema: z.ZodType<any>): ToolInput => {
  return z.toJSONSchema(schema) as ToolInput;
};

const WarehouseQuerySchema = z.object({
  sql: z.string().describe("SQL query to execute against the warehouse"),
  connectorId: z.string().optional().describe("Warehouse connector ID. If omitted and only one connector exists, it will be used automatically."),
});

const SinkQuerySchema = z.object({
  vector: z.array(z.number()).describe("Query vector for similarity search"),
  topK: z.number().default(10).describe("Number of nearest neighbors to return"),
  connectorId: z.string().optional().describe("Sink connector ID. If omitted and only one connector exists, it will be used automatically."),
  namespace: z.string().optional().describe("Pinecone namespace to search within"),
});

enum ToolName {
  WAREHOUSE = "warehouse",
  SINK = "sink",
}

const WAREHOUSE_APP_URI = "ui://warehouse/app.html";

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

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const warehouses = await getWarehouses();
    const sinks = await getSinks();
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
        description: "Interactive UI for the warehouse tool",
        mimeType: "text/html;profile=mcp-app",
      });
    }

    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri === "warehouse://connectors") {
      const warehouses = await getWarehouses();
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify(warehouses, null, 2),
        }],
      };
    }

    if (uri === "sink://connectors") {
      const sinks = await getSinks();
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

    throw new Error(`Unknown prompt: ${name}`);
  });

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [];

    if (isWarehouseAvailable()) {
      const warehouses = await listWarehouses(userId);
      const connectorList = warehouses.length > 0
        ? warehouses.map((w) => `${w.name} (${w.type}) id:${w.id}`).join("; ")
        : "none configured";

      tools.push({
        name: ToolName.WAREHOUSE,
        description:
          `Execute a SQL query against a data warehouse. Available connectors: ${connectorList}`,
        inputSchema: toJsonSchema(WarehouseQuerySchema),
        _meta: { ui: { resourceUri: WAREHOUSE_APP_URI } },
      });

      const sinks = await listSinks(userId);
      const sinkList = sinks.length > 0
        ? sinks.map((s) => `${s.name} (${s.type}) id:${s.id}`).join("; ")
        : "none configured";

      tools.push({
        name: ToolName.SINK,
        description:
          `Query a vector store (semantic search). Available sinks: ${sinkList}`,
        inputSchema: toJsonSchema(SinkQuerySchema),
      });
    }

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === ToolName.WAREHOUSE) {
      const { sql, connectorId } = WarehouseQuerySchema.parse(args);

      let resolvedId = connectorId;
      if (!resolvedId) {
        const warehouses = await listWarehouses(userId);
        if (warehouses.length === 0) {
          return {
            content: [{ type: "text", text: "No warehouse connectors configured for your team." }],
            isError: true,
          };
        }
        if (warehouses.length > 1) {
          const lines = warehouses.map(
            (w) => `• ${w.name} (${w.type}) — id: ${w.id}`,
          );
          return {
            content: [{
              type: "text",
              text: `Multiple connectors available. Please specify connectorId:\n${lines.join("\n")}`,
            }],
            isError: true,
          };
        }
        resolvedId = warehouses[0].id;
      }

      const result = await executeWarehouseQuery(userId, resolvedId, sql);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ columns: result.columns, rows: result.rows, rowCount: result.rowCount }, null, 2),
        }],
      };
    }

    if (name === ToolName.SINK) {
      const { vector, topK, connectorId, namespace } = SinkQuerySchema.parse(args);

      let resolvedId = connectorId;
      if (!resolvedId) {
        const sinks = await listSinks(userId);
        if (sinks.length === 0) {
          return {
            content: [{ type: "text", text: "No sink connectors configured for your team." }],
            isError: true,
          };
        }
        if (sinks.length > 1) {
          const lines = sinks.map(
            (s) => `• ${s.name} (${s.type}) — id: ${s.id}`,
          );
          return {
            content: [{
              type: "text",
              text: `Multiple sinks available. Please specify connectorId:\n${lines.join("\n")}`,
            }],
            isError: true,
          };
        }
        resolvedId = sinks[0].id;
      }

      const result = await executeSinkQuery(userId, resolvedId, vector, topK, namespace);
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
