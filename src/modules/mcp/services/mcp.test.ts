import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { WarehouseInfo } from "../../warehouse/service.js";
import type { SinkInfo } from "../../sink/service.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const MOCK_WAREHOUSES: WarehouseInfo[] = [
  { id: "wh-aaa", name: "Snowflake Prod", type: "snowflake", status: "connected" },
  { id: "wh-bbb", name: "BigQuery Dev", type: "bigquery", status: "connected" },
];

const MOCK_SINKS: SinkInfo[] = [
  { id: "sk-aaa", name: "Pinecone Prod", type: "pinecone", config: { indexName: "prod-idx" }, status: "connected", embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536 },
];

const mockListWarehouses = jest.fn<() => Promise<WarehouseInfo[]>>();
const mockListSinks = jest.fn<() => Promise<SinkInfo[]>>();
const mockExecuteWarehouseQuery = jest.fn();
const mockExecuteSinkTextQuery = jest.fn();
const mockResolveUserScope = jest.fn();
const mockIsPostgresReady = jest.fn(() => true);

jest.unstable_mockModule("../../../config.js", () => ({
  config: {
    kms: { enabled: true },
    openai: { apiKey: "test-key" },
  },
}));

jest.unstable_mockModule("../../shared/postgres.js", () => ({
  isPostgresReady: mockIsPostgresReady,
  withUserContext: jest.fn(async (_userId: unknown, fn: unknown) =>
    (fn as (client: { query: jest.Mock }) => unknown)({ query: jest.fn(() => ({ rows: [] })) }),
  ),
}));

jest.unstable_mockModule("../../warehouse/service.js", () => ({
  listWarehouses: mockListWarehouses,
  executeWarehouseQuery: mockExecuteWarehouseQuery,
}));

jest.unstable_mockModule("../../sink/service.js", () => ({
  listSinks: mockListSinks,
  executeSinkTextQuery: mockExecuteSinkTextQuery,
}));

jest.unstable_mockModule("./scope.js", () => ({
  resolveUserScope: mockResolveUserScope,
  buildSinkFilter: jest.fn(),
  sanitizeSinkResults: jest.fn((matches: unknown) => matches),
}));

jest.unstable_mockModule("./sql-validator.js", () => ({
  validateAndRewriteSql: jest.fn(async () => ({ allowed: true })),
}));

const { createMcpServer } = await import("./mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

async function setupClientServer() {
  const { server } = createMcpServer("user-test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

describe("MCP Server — list_connectors tool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListWarehouses.mockResolvedValue(MOCK_WAREHOUSES);
    mockListSinks.mockResolvedValue(MOCK_SINKS);
    mockResolveUserScope.mockResolvedValue(null);
    mockIsPostgresReady.mockReturnValue(true);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
  });

  describe("list_tools", () => {
    it("always includes list_connectors tool", async () => {
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const names = tools.map((t: Tool) => t.name);
      expect(names).toContain("list_connectors");
    });

    it("list_connectors description mentions the recommended workflow", async () => {
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const lc = tools.find((t: Tool) => t.name === "list_connectors")!;
      expect(lc.description).toMatch(/list_connectors/);
      expect(lc.description).toMatch(/sink/);
      expect(lc.description).toMatch(/warehouse/);
    });

    it("always registers explore_warehouse and explore_sink even with zero connectors", async () => {
      mockListWarehouses.mockResolvedValue([]);
      mockListSinks.mockResolvedValue([]);
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const names = tools.map((t: Tool) => t.name);
      expect(names).toContain("explore_warehouse");
      expect(names).toContain("explore_sink");
    });

    it("includes connector hint in warehouse tool description", async () => {
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const wh = tools.find((t: Tool) => t.name === "warehouse")!;
      expect(wh.description).toMatch(/list_connectors/);
    });

    it("includes connector hint in sink tool description", async () => {
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const sk = tools.find((t: Tool) => t.name === "sink")!;
      expect(sk.description).toMatch(/list_connectors/);
    });

    it("includes connector hint in explore tool descriptions", async () => {
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const ew = tools.find((t: Tool) => t.name === "explore_warehouse")!;
      const es = tools.find((t: Tool) => t.name === "explore_sink")!;
      expect(ew.description).toMatch(/list_connectors/);
      expect(es.description).toMatch(/list_connectors/);
    });

    it("shows 'call list_connectors to check for updates' when no connectors exist", async () => {
      mockListWarehouses.mockResolvedValue([]);
      mockListSinks.mockResolvedValue([]);
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const wh = tools.find((t: Tool) => t.name === "warehouse")!;
      expect(wh.description).toMatch(/list_connectors to check/);
    });
  });

  describe("call list_connectors", () => {
    it("returns warehouse and sink connectors with IDs", async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({ name: "list_connectors", arguments: {} });
      const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(body.warehouses).toHaveLength(2);
      expect(body.sinks).toHaveLength(1);
      expect(body.warehouses[0]).toEqual({ id: "wh-aaa", name: "Snowflake Prod", type: "snowflake", status: "connected" });
      expect(body.sinks[0]).toEqual({ id: "sk-aaa", name: "Pinecone Prod", type: "pinecone", status: "connected" });
    });

    it("returns empty lists when no connectors configured", async () => {
      mockListWarehouses.mockResolvedValue([]);
      mockListSinks.mockResolvedValue([]);
      const { client } = await setupClientServer();
      const result = await client.callTool({ name: "list_connectors", arguments: {} });
      const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(body.warehouses).toHaveLength(0);
      expect(body.sinks).toHaveLength(0);
    });

    it("includes workflow guidance in response", async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({ name: "list_connectors", arguments: {} });
      const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(body.workflow).toBeDefined();
      expect(body.workflow).toMatch(/sink/);
      expect(body.workflow).toMatch(/warehouse/);
    });
  });
});

describe("MCP Server — stale connector error handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListWarehouses.mockResolvedValue(MOCK_WAREHOUSES);
    mockListSinks.mockResolvedValue(MOCK_SINKS);
    mockResolveUserScope.mockResolvedValue(null);
    mockIsPostgresReady.mockReturnValue(true);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
  });

  it("returns helpful error when warehouse connector not found", async () => {
    mockExecuteWarehouseQuery.mockRejectedValue(new Error("Warehouse connector not found or access denied"));
    const { client } = await setupClientServer();
    const result = await client.callTool({ name: "warehouse", arguments: { sql: "SELECT 1", connectorId: "stale-uuid" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/stale-uuid/);
    expect(text).toMatch(/list_connectors/);
    expect(text).toMatch(/outdated/);
  });

  it("returns helpful error when sink connector not found", async () => {
    mockExecuteSinkTextQuery.mockRejectedValue(new Error("Sink connector not found or access denied"));
    const { client } = await setupClientServer();
    const result = await client.callTool({ name: "sink", arguments: { query: "test", topK: 5, connectorId: "stale-sink-id" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/stale-sink-id/);
    expect(text).toMatch(/list_connectors/);
    expect(text).toMatch(/outdated/);
  });

  it("re-throws non-connector errors from warehouse", async () => {
    mockExecuteWarehouseQuery.mockRejectedValue(new Error("Query timeout after 30s"));
    const { client } = await setupClientServer();
    await expect(
      client.callTool({ name: "warehouse", arguments: { sql: "SELECT 1", connectorId: "wh-aaa" } }),
    ).rejects.toThrow();
  });

  it("re-throws non-connector errors from sink", async () => {
    mockExecuteSinkTextQuery.mockRejectedValue(new Error("Embedding API rate limit exceeded"));
    const { client } = await setupClientServer();
    await expect(
      client.callTool({ name: "sink", arguments: { query: "test", topK: 5, connectorId: "sk-aaa" } }),
    ).rejects.toThrow();
  });

  it("returns helpful error for explore_warehouse with stale connector", async () => {
    mockExecuteWarehouseQuery.mockRejectedValue(new Error("Warehouse connector not found or access denied"));
    const { client } = await setupClientServer();
    const result = await client.callTool({ name: "explore_warehouse", arguments: { sql: "SELECT 1", connectorId: "gone-uuid" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/gone-uuid/);
    expect(text).toMatch(/list_connectors/);
  });

  it("returns helpful error for explore_sink with stale connector", async () => {
    mockExecuteSinkTextQuery.mockRejectedValue(new Error("Sink connector not found or access denied"));
    const { client } = await setupClientServer();
    const result = await client.callTool({ name: "explore_sink", arguments: { query: "test", topK: 5, connectorId: "gone-sink" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/gone-sink/);
    expect(text).toMatch(/list_connectors/);
  });
});
