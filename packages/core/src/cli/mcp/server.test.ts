import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "./server";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LexiconPlugin } from "../../lexicon";
import type { Serializer } from "../../serializer";

function createMockPlugin(overrides?: Partial<LexiconPlugin>): LexiconPlugin {
  return {
    name: "mock",
    serializer: { name: "mock", serialize: () => "" } as unknown as Serializer,
    generate: async () => {},
    validate: async () => {},
    coverage: async () => {},
    package: async () => {},
    ...overrides,
  };
}

describe("McpServer", () => {
  let server: McpServer;
  let testDir: string;

  beforeEach(async () => {
    server = new McpServer();
    testDir = join(tmpdir(), `chant-mcp-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Protocol basics
  // -----------------------------------------------------------------------

  describe("initialize", () => {
    test("returns server info and capabilities", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      expect(response.error).toBeUndefined();
      const result = response.result as Record<string, unknown>;
      // No requested version → negotiates to the latest supported revision (#1194).
      expect(result.protocolVersion).toBe("2026-07-28");
      expect(result.capabilities).toBeDefined();
      expect((result.serverInfo as Record<string, unknown>).name).toBe("chant");
      expect((result.serverInfo as Record<string, unknown>).version).toBe("0.1.0");
    });

    test("capabilities include tools and resources", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      const result = response!.result as Record<string, unknown>;
      const caps = result.capabilities as Record<string, unknown>;
      expect(caps.tools).toBeDefined();
      expect(caps.resources).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // Dual-revision negotiation (#1194)
    // -----------------------------------------------------------------------

    test("a 2024-11-05 client requesting its own version gets it back unchanged", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "old-client", version: "1.0" } },
      });
      expect(response!.error).toBeUndefined();
      const result = response!.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2024-11-05");
    });

    test("a 2026-07-28 client requesting its version gets the latest revision", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { _meta: { protocolVersion: "2026-07-28" } },
      });
      expect(response!.error).toBeUndefined();
      const result = response!.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2026-07-28");
    });

    test("an unrecognized requested version falls back to the latest supported", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      });
      const result = response!.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2026-07-28");
    });

    test("no requested version at all defaults to the latest supported", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      const result = response!.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2026-07-28");
    });
  });

  // -----------------------------------------------------------------------
  // _meta parsing (#1194)
  // -----------------------------------------------------------------------

  describe("_meta parsing", () => {
    test("reads requested protocol version from _meta on initialize", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { _meta: { protocolVersion: "2024-11-05" } },
      });
      const result = response!.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2024-11-05");
    });

    test("_meta protocolVersion takes precedence over a legacy top-level one", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", _meta: { protocolVersion: "2026-07-28" } },
      });
      const result = response!.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2026-07-28");
    });

    test("client identity in _meta does not interfere with tool dispatch", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search",
          arguments: { query: "bucket" },
          _meta: {
            protocolVersion: "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "some-agent", version: "3.0" },
          },
        },
      });
      expect(response!.error).toBeUndefined();
      const result = response!.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.query).toBe("bucket");
    });

    test("a request with no _meta and no legacy fields is unaffected", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      expect(response!.error).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Notification silence (#1194)
  // -----------------------------------------------------------------------

  describe("notifications", () => {
    test("a message with no id gets no response", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      });
      expect(response).toBeNull();
    });

    test("an id-less message is not routed through dispatch as Unknown method", async () => {
      // notifications/initialized isn't a dispatch case; silence must come
      // from the id check, not from swallowing a dispatch error.
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        method: "notifications/anything",
      });
      expect(response).toBeNull();
    });

    test("a message with id 0 (falsy but present) still gets a response", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 0,
        method: "tools/list",
      });
      expect(response).not.toBeNull();
      expect(response!.id).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // server/discover (#1194)
  // -----------------------------------------------------------------------

  describe("server/discover", () => {
    test("a 2026-07-28 client can discover capabilities without calling initialize", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: { protocolVersion: "2026-07-28" } },
      });
      expect(response!.error).toBeUndefined();
      const result = response!.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2026-07-28");
      expect(result.serverInfo).toBeDefined();
      expect(result.capabilities).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(Array.isArray(result.resources)).toBe(true);
    });

    test("discover's tools list matches tools/list", async () => {
      const discover = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
      const list = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const discoverNames = (discover!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
      const listNames = (list!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
      expect(discoverNames).toEqual(listNames);
    });

    test("discover's resources list matches resources/list, including plugin contributions", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpResources: () => [
          {
            uri: "catalog",
            name: "Test Catalog",
            description: "Test resource catalog",
            mimeType: "application/json",
            handler: async () => "[]",
          },
        ],
      });
      const s = new McpServer([plugin]);
      const discover = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
      const list = await s.handleRequest({ jsonrpc: "2.0", id: 2, method: "resources/list" });
      const discoverUris = (discover!.result as { resources: Array<{ uri: string }> }).resources.map((r) => r.uri).sort();
      const listUris = (list!.result as { resources: Array<{ uri: string }> }).resources.map((r) => r.uri).sort();
      expect(discoverUris).toEqual(listUris);
      expect(discoverUris).toContain("chant://test-lex/catalog");
    });

    test("negotiates protocol version the same way as initialize", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { protocolVersion: "2024-11-05" },
      });
      const result = response!.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2024-11-05");
    });
  });

  // -----------------------------------------------------------------------
  // Structured tool output (#1194)
  // -----------------------------------------------------------------------

  describe("structured tool output", () => {
    test("an object-returning handler gets structuredContent alongside text", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query: "bucket" } },
      });
      const result = response!.result as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent!.query).toBe("bucket");
      const parsedText = JSON.parse(result.content[0].text);
      expect(result.structuredContent).toEqual(parsedText);
    });

    test("a string-returning handler has no structuredContent", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpTools: () => [
          {
            name: "greet",
            description: "Greet",
            inputSchema: { type: "object", properties: {} },
            handler: async () => "hello from plugin",
          },
        ],
      });
      const s = new McpServer([plugin]);
      const response = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "test-lex:greet", arguments: {} },
      });
      const result = response!.result as { structuredContent?: unknown };
      expect(result.structuredContent).toBeUndefined();
    });

    test("an isError response has no structuredContent", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "unknown-tool", arguments: {} },
      });
      const result = response!.result as { isError: boolean; structuredContent?: unknown };
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    });
  });

  describe("error handling", () => {
    test("returns error for unknown method", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "unknown/method",
      });
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32603);
      expect(response.error?.message).toContain("Unknown method");
    });
  });

  // -----------------------------------------------------------------------
  // Core tools
  // -----------------------------------------------------------------------

  describe("tools/list", () => {
    test("returns core tools (build, lint, import, explain, scaffold, search)", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expect(response.error).toBeUndefined();

      const result = response.result as { tools: Array<{ name: string }> };
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("build");
      expect(toolNames).toContain("lint");
      expect(toolNames).toContain("import");
      expect(toolNames).toContain("explain");
      expect(toolNames).toContain("scaffold");
      expect(toolNames).toContain("search");
    });

    test("each tool has name, description, and inputSchema", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const result = response.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
      for (const tool of result.tools) {
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(tool.inputSchema).toBeDefined();
        expect((tool.inputSchema as Record<string, unknown>).type).toBe("object");
      }
    });

    test("build tool schema has path property", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
      const buildTool = result.tools.find((t) => t.name === "build")!;
      const props = buildTool.inputSchema.properties as Record<string, unknown>;
      expect(props.path).toBeDefined();
    });

    test("lint tool schema has path and fix properties", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
      const lintTool = result.tools.find((t) => t.name === "lint")!;
      const props = lintTool.inputSchema.properties as Record<string, unknown>;
      expect(props.path).toBeDefined();
      expect(props.fix).toBeDefined();
    });

    test("import tool schema has source and output properties", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
      const importTool = result.tools.find((t) => t.name === "import")!;
      const props = importTool.inputSchema.properties as Record<string, unknown>;
      expect(props.source).toBeDefined();
      expect(props.output).toBeDefined();
    });

    test("explain tool schema has path and format properties", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
      const tool = result.tools.find((t) => t.name === "explain")!;
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.path).toBeDefined();
      expect(props.format).toBeDefined();
    });

    test("scaffold tool schema has pattern and lexicon properties", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
      const tool = result.tools.find((t) => t.name === "scaffold")!;
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.pattern).toBeDefined();
      expect(props.lexicon).toBeDefined();
    });

    test("search tool schema has query, lexicon, and limit properties", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
      const tool = result.tools.find((t) => t.name === "search")!;
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.query).toBeDefined();
      expect(props.lexicon).toBeDefined();
      expect(props.limit).toBeDefined();
    });

    describe("Op tools schema", () => {
      async function getToolProps(name: string): Promise<Record<string, unknown>> {
        const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
        const tool = result.tools.find((t) => t.name === name)!;
        return tool.inputSchema.properties as Record<string, unknown>;
      }

      test("op-list has profile property", async () => {
        const props = await getToolProps("op-list");
        expect(props.profile).toBeDefined();
      });

      test("op-run has name (required) and profile", async () => {
        const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
        const tool = result.tools.find((t) => t.name === "op-run")!;
        const props = tool.inputSchema.properties as Record<string, unknown>;
        expect(props.name).toBeDefined();
        expect(props.profile).toBeDefined();
        expect(tool.inputSchema.required).toContain("name");
      });

      test("op-status has name (required) and profile", async () => {
        const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
        const tool = result.tools.find((t) => t.name === "op-status")!;
        const props = tool.inputSchema.properties as Record<string, unknown>;
        expect(props.name).toBeDefined();
        expect(props.profile).toBeDefined();
        expect(tool.inputSchema.required).toContain("name");
      });

      test("op-signal has name and signal (both required) and profile", async () => {
        const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
        const tool = result.tools.find((t) => t.name === "op-signal")!;
        const props = tool.inputSchema.properties as Record<string, unknown>;
        expect(props.name).toBeDefined();
        expect(props.signal).toBeDefined();
        expect(props.profile).toBeDefined();
        expect(tool.inputSchema.required).toContain("name");
        expect(tool.inputSchema.required).toContain("signal");
      });

      test("op-report has name (required) and profile", async () => {
        const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        const result = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
        const tool = result.tools.find((t) => t.name === "op-report")!;
        const props = tool.inputSchema.properties as Record<string, unknown>;
        expect(props.name).toBeDefined();
        expect(props.profile).toBeDefined();
        expect(tool.inputSchema.required).toContain("name");
      });
    });
  });

  describe("tools/call", () => {
    test("calls lint tool successfully", async () => {
      await writeFile(join(testDir, "clean.ts"), `export const config = { a: 1 };`);

      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "lint", arguments: { path: testDir } },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ type: string; text: string }> };
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe("text");
    });

    test("returns isError for unknown tool", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "unknown-tool", arguments: {} },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });

    test("returns isError when tool handler throws", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "import", arguments: { source: "/nonexistent/file.json" } },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error:");
    });

    test("calls explain tool on empty directory", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "explain", arguments: { path: testDir } },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ type: string; text: string }> };
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Project Summary");
    });

    test("calls explain tool with json format", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "explain", arguments: { path: testDir, format: "json" } },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalEntities).toBe(0);
      expect(parsed.sourceFiles).toBeDefined();
    });

    test("calls explain tool with okf format (#1058)", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "explain", arguments: { path: testDir, format: "okf" } },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.okf_version).toBe("0.2");
      // Even an empty project yields a bundle with a root index.md.
      expect(Object.keys(parsed.files)).toEqual(["index.md"]);
      expect(parsed.files["index.md"]).toContain("okf_version: '0.2'");
    });

    test("calls scaffold tool with generic fallback", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "scaffold", arguments: { pattern: "my-service" } },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.pattern).toBe("my-service");
      expect(parsed.files).toBeDefined();
      expect(parsed.files.length).toBeGreaterThan(0);
    });

    test("calls search tool with no plugins", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query: "bucket" } },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.query).toBe("bucket");
      expect(parsed.total).toBe(0);
      expect(parsed.results).toEqual([]);
    });

    describe("Op tool handlers", () => {
      test("op-list returns list without throwing when Temporal unavailable", async () => {
        const response = await server.handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "op-list", arguments: {} },
        });
        expect(response.error).toBeUndefined();
        const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
        expect(result.content[0].type).toBe("text");
        // May be empty list or error-degraded — but no thrown error
        expect(result.isError).toBeUndefined();
      });

      test("op-run returns isError when Temporal unavailable", async () => {
        const response = await server.handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "op-run", arguments: { name: "nonexistent-op" } },
        });
        expect(response.error).toBeUndefined();
        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        // Either "not found" or Temporal error — either way should not be a protocol error
        expect(result.content[0].text.length).toBeGreaterThan(0);
      });

      test("op-status returns isError when Temporal unavailable", async () => {
        const response = await server.handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "op-status", arguments: { name: "nonexistent-op" } },
        });
        expect(response.error).toBeUndefined();
        const result = response.result as { content: Array<{ text: string }>; isError: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Error:");
      });

      test("op-signal returns isError when Temporal unavailable", async () => {
        const response = await server.handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "op-signal", arguments: { name: "nonexistent-op", signal: "gate" } },
        });
        expect(response.error).toBeUndefined();
        const result = response.result as { content: Array<{ text: string }>; isError: boolean };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Error:");
      });

      test("op-report returns content without throwing when op not found", async () => {
        const response = await server.handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "op-report", arguments: { name: "nonexistent-op" } },
        });
        expect(response.error).toBeUndefined();
        const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
        // Op not found → returns a "not found" message or Temporal error, not a protocol error
        expect(result.content[0].text.length).toBeGreaterThan(0);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Search tool with plugins
  // -----------------------------------------------------------------------

  describe("search with plugins", () => {
    test("searches plugin resource catalogs", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpResources: () => [
          {
            uri: "resource-catalog",
            name: "Test Catalog",
            description: "Test resource catalog",
            mimeType: "application/json",
            handler: async () => JSON.stringify([
              { className: "Bucket", resourceType: "AWS::S3::Bucket", kind: "resource" },
              { className: "Table", resourceType: "AWS::DynamoDB::Table", kind: "resource" },
            ]),
          },
        ],
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query: "bucket" } },
      });

      const result = response.result as { content: Array<{ text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.total).toBe(1);
      expect(parsed.results[0].className).toBe("Bucket");
      expect(parsed.results[0].lexicon).toBe("test-lex");
    });

    test("search respects limit parameter", async () => {
      const entries = Array.from({ length: 30 }, (_, i) => ({
        className: `Type${i}`,
        resourceType: `NS::Type${i}`,
        kind: "resource",
      }));
      const plugin = createMockPlugin({
        name: "big",
        mcpResources: () => [
          {
            uri: "resource-catalog",
            name: "Big Catalog",
            description: "Big catalog",
            mimeType: "application/json",
            handler: async () => JSON.stringify(entries),
          },
        ],
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query: "type", limit: 5 } },
      });

      const parsed = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.total).toBe(30);
      expect(parsed.results.length).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // Scaffold tool with plugins
  // -----------------------------------------------------------------------

  describe("scaffold with plugins", () => {
    test("matches plugin init templates", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        initTemplates: () => ({ src: {
          "config.ts": "export const config = {};",
          "data-bucket.ts": "export const dataBucket = {};",
        } }),
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "scaffold", arguments: { pattern: "bucket", lexicon: "test-lex" } },
      });

      const parsed = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.lexicon).toBe("test-lex");
      expect(parsed.files.length).toBe(1);
      expect(parsed.files[0].filename).toBe("data-bucket.ts");
    });

    test("passes template name to initTemplates", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        initTemplates: (template?: string | undefined) => {
          const src: Record<string, string> = template === "special"
            ? { "special.ts": "export const special = {};" }
            : { "default.ts": "export const def = {};" };
          return { src };
        },
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "scaffold", arguments: { pattern: "special", lexicon: "test-lex", template: "special" } },
      });

      const parsed = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.lexicon).toBe("test-lex");
      expect(parsed.template).toBe("special");
      expect(parsed.files.length).toBe(1);
      expect(parsed.files[0].filename).toBe("special.ts");
    });
  });

  // -----------------------------------------------------------------------
  // Core resources
  // -----------------------------------------------------------------------

  describe("resources/list", () => {
    test("returns core resources", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/list",
      });
      expect(response.error).toBeUndefined();

      const result = response.result as { resources: Array<{ uri: string; name: string; description: string }> };
      const uris = result.resources.map((r) => r.uri);
      expect(uris).toContain("chant://context");
      expect(uris).toContain("chant://examples/list");
      expect(uris).toContain("chant://ops");
      expect(uris).toContain("chant://ops/{name}/runs");
      expect(uris).toContain("chant://ops/{name}/runs/latest");
      expect(uris).toContain("chant://knowledge");

      // Each resource has required fields
      for (const resource of result.resources) {
        expect(typeof resource.uri).toBe("string");
        expect(typeof resource.name).toBe("string");
        expect(typeof resource.description).toBe("string");
      }
    });
  });

  describe("resources/read", () => {
    test("reads context resource as markdown", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "chant://context" },
      });
      expect(response.error).toBeUndefined();

      const result = response.result as { contents: Array<{ uri: string; text: string; mimeType: string }> };
      expect(result.contents[0].mimeType).toBe("text/markdown");
      expect(result.contents[0].text.length).toBeGreaterThan(0);
      expect(result.contents[0].uri).toBe("chant://context");
    });

    test("reads examples list as empty array without plugins", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "chant://examples/list" },
      });
      expect(response.error).toBeUndefined();

      const result = response.result as { contents: Array<{ text: string }> };
      const examples = JSON.parse(result.contents[0].text);
      expect(Array.isArray(examples)).toBe(true);
      expect(examples).toHaveLength(0);
    });

    test("reads examples from plugin resources", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpResources: () => [
          {
            uri: "examples/my-example",
            name: "My Example",
            description: "A test example",
            mimeType: "text/typescript",
            handler: async () => "export const x = 1;",
          },
        ],
      });

      const s = new McpServer([plugin]);

      // List should include the example
      const listResponse = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "chant://examples/list" },
      });
      const examples = JSON.parse((listResponse.result as { contents: Array<{ text: string }> }).contents[0].text);
      expect(examples).toHaveLength(1);
      expect(examples[0].name).toBe("my-example");
      expect(examples[0].description).toBe("A test example");

      // Read the specific example
      const readResponse = await s.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "chant://examples/my-example" },
      });
      expect(readResponse.error).toBeUndefined();
      const result = readResponse.result as { contents: Array<{ text: string; mimeType: string }> };
      expect(result.contents[0].mimeType).toBe("text/typescript");
      expect(result.contents[0].text).toBe("export const x = 1;");
    });

    test("returns error for non-existent example", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "chant://examples/nonexistent" },
      });
      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain("not found");
    });

    test("returns error for unknown resource URI", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "chant://unknown" },
      });
      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain("Unknown resource");
    });

    describe("Op resources", () => {
      test("chant://ops returns an array", async () => {
        const response = await server.handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/read",
          params: { uri: "chant://ops" },
        });
        expect(response.error).toBeUndefined();
        const result = response.result as { contents: Array<{ text: string; mimeType: string }> };
        expect(result.contents[0].mimeType).toBe("application/json");
        const ops = JSON.parse(result.contents[0].text);
        expect(Array.isArray(ops)).toBe(true);
      });

      test("chant://ops/{name}/runs degrades gracefully when Temporal unavailable", async () => {
        const response = await server.handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/read",
          params: { uri: "chant://ops/nonexistent/runs" },
        });
        expect(response.error).toBeUndefined();
        const result = response.result as { contents: Array<{ text: string }> };
        const data = JSON.parse(result.contents[0].text);
        expect(data.error).toBeDefined();
      });

      test("chant://ops/{name}/runs/latest degrades gracefully when Temporal unavailable", async () => {
        const response = await server.handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/read",
          params: { uri: "chant://ops/nonexistent/runs/latest" },
        });
        expect(response.error).toBeUndefined();
        const result = response.result as { contents: Array<{ text: string }> };
        const data = JSON.parse(result.contents[0].text);
        expect(data.error).toBeDefined();
      });
    });

    describe("chant://knowledge", () => {
      test("empty gracefully when no bundle exists", async () => {
        const originalCwd = process.cwd();
        process.chdir(testDir);
        try {
          const response = await server.handleRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "resources/read",
            params: { uri: "chant://knowledge" },
          });
          expect(response.error).toBeUndefined();
          const result = response.result as { contents: Array<{ text: string; mimeType: string }> };
          expect(result.contents[0].mimeType).toBe("application/json");
          const data = JSON.parse(result.contents[0].text);
          expect(data.index).toBeNull();
          expect(data.concepts).toEqual([]);
        } finally {
          process.chdir(originalCwd);
        }
      });

      test("serves the bundle index and concepts when present", async () => {
        const originalCwd = process.cwd();
        process.chdir(testDir);
        try {
          await mkdir(join(testDir, "knowledge", "decisions"), { recursive: true });
          await writeFile(join(testDir, "knowledge", "index.md"), "# Knowledge index\n");
          await writeFile(
            join(testDir, "knowledge", "decisions", "public-assets.md"),
            "---\ntype: decision\ntitle: Public assets\nbinds: bucket\n---\nBody text.\n",
          );

          const response = await server.handleRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "resources/read",
            params: { uri: "chant://knowledge" },
          });
          expect(response.error).toBeUndefined();
          const result = response.result as { contents: Array<{ text: string }> };
          const data = JSON.parse(result.contents[0].text);
          expect(data.index).toBe("# Knowledge index\n");
          expect(data.concepts).toHaveLength(1);
          expect(data.concepts[0]).toMatchObject({
            path: "decisions/public-assets.md",
            type: "decision",
            title: "Public assets",
            binds: ["bucket"],
          });
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  // -----------------------------------------------------------------------
  // Plugin tool contributions
  // -----------------------------------------------------------------------

  describe("plugin tools", () => {
    test("appear in tools/list with lexicon:name prefix", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpTools: () => [
          {
            name: "analyze",
            description: "Analyze infrastructure",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            handler: async () => "analyzed",
          },
        ],
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const result = response.result as { tools: Array<{ name: string; description: string }> };
      const toolNames = result.tools.map((t) => t.name);

      expect(toolNames).toContain("test-lex:analyze");
      // Core tools still present
      expect(toolNames).toContain("build");
      expect(toolNames).toContain("lint");
      expect(toolNames).toContain("import");
    });

    test("preserve description and inputSchema", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpTools: () => [
          {
            name: "scan",
            description: "Scan for issues",
            inputSchema: {
              type: "object",
              properties: { target: { type: "string" } },
              required: ["target"],
            },
            handler: async () => "ok",
          },
        ],
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const result = response.result as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
      const tool = result.tools.find((t) => t.name === "test-lex:scan")!;

      expect(tool.description).toBe("Scan for issues");
      expect(tool.inputSchema.type).toBe("object");
      expect((tool.inputSchema.properties as Record<string, unknown>).target).toBeDefined();
      expect(tool.inputSchema.required).toEqual(["target"]);
    });

    test("can be called and return result", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpTools: () => [
          {
            name: "greet",
            description: "Greet",
            inputSchema: { type: "object", properties: {} },
            handler: async () => "hello from plugin",
          },
        ],
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "test-lex:greet", arguments: {} },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.content[0].text).toContain("hello from plugin");
      expect(result.isError).toBeUndefined();
    });

    test("handler receives forwarded params", async () => {
      let receivedParams: Record<string, unknown> = {};
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpTools: () => [
          {
            name: "echo",
            description: "Echo params",
            inputSchema: { type: "object", properties: { msg: { type: "string" } } },
            handler: async (params) => {
              receivedParams = params;
              return "ok";
            },
          },
        ],
      });

      const s = new McpServer([plugin]);
      await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "test-lex:echo", arguments: { msg: "hi", extra: 42 } },
      });

      expect(receivedParams.msg).toBe("hi");
      expect(receivedParams.extra).toBe(42);
    });

    test("handler error returns isError response", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpTools: () => [
          {
            name: "fail",
            description: "Always fails",
            inputSchema: { type: "object", properties: {} },
            handler: async () => {
              throw new Error("intentional failure");
            },
          },
        ],
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "test-lex:fail", arguments: {} },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("intentional failure");
    });

    test("handler returning object is serialized as JSON", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpTools: () => [
          {
            name: "data",
            description: "Return data",
            inputSchema: { type: "object", properties: {} },
            handler: async () => ({ count: 5, items: ["a", "b"] }),
          },
        ],
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "test-lex:data", arguments: {} },
      });

      const result = response.result as { content: Array<{ text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(5);
      expect(parsed.items).toEqual(["a", "b"]);
    });

    test("multiple plugins contribute tools with namespace isolation", async () => {
      const alpha = createMockPlugin({
        name: "alpha",
        mcpTools: () => [
          {
            name: "scan",
            description: "Alpha scan",
            inputSchema: { type: "object", properties: {} },
            handler: async () => "alpha-result",
          },
        ],
      });
      const beta = createMockPlugin({
        name: "beta",
        mcpTools: () => [
          {
            name: "scan",
            description: "Beta scan",
            inputSchema: { type: "object", properties: {} },
            handler: async () => "beta-result",
          },
        ],
      });

      const s = new McpServer([alpha, beta]);

      // Both appear
      const listRes = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const tools = (listRes.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name)).toContain("alpha:scan");
      expect(tools.map((t) => t.name)).toContain("beta:scan");

      // Each dispatches to correct handler
      const alphaRes = await s.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "alpha:scan", arguments: {} },
      });
      expect((alphaRes.result as { content: Array<{ text: string }> }).content[0].text).toContain("alpha-result");

      const betaRes = await s.handleRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "beta:scan", arguments: {} },
      });
      expect((betaRes.result as { content: Array<{ text: string }> }).content[0].text).toContain("beta-result");
    });
  });

  // -----------------------------------------------------------------------
  // Plugin resource contributions
  // -----------------------------------------------------------------------

  describe("plugin resources", () => {
    test("appear in resources/list with chant://lexicon/uri prefix", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpResources: () => [
          {
            uri: "catalog",
            name: "Test Catalog",
            description: "Test resource catalog",
            mimeType: "application/json",
            handler: async () => "[]",
          },
        ],
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "resources/list" });
      const result = response.result as { resources: Array<{ uri: string; name: string }> };
      const uris = result.resources.map((r) => r.uri);

      expect(uris).toContain("chant://test-lex/catalog");
      expect(uris).toContain("chant://context");
      expect(uris).toContain("chant://examples/list");
    });

    test("can be read by namespaced URI", async () => {
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpResources: () => [
          {
            uri: "data",
            name: "Test Data",
            description: "Test data",
            mimeType: "application/json",
            handler: async () => JSON.stringify({ key: "value" }),
          },
        ],
      });

      const s = new McpServer([plugin]);
      const response = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "chant://test-lex/data" },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { contents: Array<{ uri: string; text: string; mimeType: string }> };
      expect(result.contents[0].uri).toBe("chant://test-lex/data");
      expect(result.contents[0].mimeType).toBe("application/json");
      const data = JSON.parse(result.contents[0].text);
      expect(data.key).toBe("value");
    });

    test("handler is called on read", async () => {
      let handlerCalled = false;
      const plugin = createMockPlugin({
        name: "test-lex",
        mcpResources: () => [
          {
            uri: "lazy",
            name: "Lazy Resource",
            description: "Computed on demand",
            handler: async () => {
              handlerCalled = true;
              return "computed";
            },
          },
        ],
      });

      const s = new McpServer([plugin]);
      // Handler not called on list
      await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "resources/list" });
      expect(handlerCalled).toBe(false);

      // Handler called on read
      await s.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "chant://test-lex/lazy" },
      });
      expect(handlerCalled).toBe(true);
    });

    test("multiple resources from same plugin", async () => {
      const plugin = createMockPlugin({
        name: "multi",
        mcpResources: () => [
          {
            uri: "types",
            name: "Types",
            description: "Type catalog",
            mimeType: "application/json",
            handler: async () => JSON.stringify(["TypeA", "TypeB"]),
          },
          {
            uri: "config",
            name: "Config",
            description: "Configuration",
            mimeType: "text/yaml",
            handler: async () => "key: value",
          },
        ],
      });

      const s = new McpServer([plugin]);
      const listRes = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "resources/list" });
      const uris = (listRes.result as { resources: Array<{ uri: string }> }).resources.map((r) => r.uri);
      expect(uris).toContain("chant://multi/types");
      expect(uris).toContain("chant://multi/config");

      // Read each
      const typesRes = await s.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "chant://multi/types" },
      });
      const typesContent = (typesRes.result as { contents: Array<{ text: string }> }).contents[0].text;
      expect(JSON.parse(typesContent)).toEqual(["TypeA", "TypeB"]);

      const configRes = await s.handleRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "chant://multi/config" },
      });
      const configContent = (configRes.result as { contents: Array<{ text: string; mimeType: string }> }).contents[0];
      expect(configContent.text).toBe("key: value");
      expect(configContent.mimeType).toBe("text/yaml");
    });

    test("plugin resource URI does not shadow core resources", async () => {
      // Even if a plugin URI partially matches core patterns, core should still work
      const plugin = createMockPlugin({
        name: "evil",
        mcpResources: () => [
          {
            uri: "context",
            name: "Evil Context",
            description: "Not the real context",
            handler: async () => "fake",
          },
        ],
      });

      const s = new McpServer([plugin]);

      // Core context still readable
      const coreRes = await s.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "chant://context" },
      });
      expect(coreRes.error).toBeUndefined();
      const coreText = (coreRes.result as { contents: Array<{ text: string }> }).contents[0].text;
      expect(coreText).not.toBe("fake");

      // Plugin resource is at its own namespaced URI
      const pluginRes = await s.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "chant://evil/context" },
      });
      expect(pluginRes.error).toBeUndefined();
      expect((pluginRes.result as { contents: Array<{ text: string }> }).contents[0].text).toBe("fake");
    });
  });

  // -----------------------------------------------------------------------
  // Server with no plugins (backward compatibility)
  // -----------------------------------------------------------------------

  describe("no plugins", () => {
    test("server without plugins argument works identically to original", async () => {
      const s = new McpServer();
      const initRes = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(initRes.error).toBeUndefined();

      const toolsRes = await s.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = (toolsRes.result as { tools: Array<{ name: string }> }).tools;
      expect(tools).toHaveLength(13);
      expect(tools.map((t) => t.name).sort()).toEqual([
        "build", "explain", "import", "lifecycle-diff", "lifecycle-snapshot", "lint",
        "op-list", "op-report", "op-run", "op-signal", "op-status",
        "scaffold", "search",
      ]);

      const resourcesRes = await s.handleRequest({ jsonrpc: "2.0", id: 3, method: "resources/list" });
      const resources = (resourcesRes.result as { resources: Array<{ uri: string }> }).resources;
      expect(resources).toHaveLength(8);
    });

    test("server with empty plugins array works", async () => {
      const s = new McpServer([]);
      const toolsRes = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const tools = (toolsRes.result as { tools: Array<{ name: string }> }).tools;
      expect(tools).toHaveLength(13);
    });
  });
});

describe("plugin namespacing is idempotent (#1341)", () => {
  const tool = (name: string) => ({
    name,
    description: "d",
    inputSchema: { type: "object" as const, properties: {} },
    handler: async () => "",
  });
  const resource = (uri: string) => ({
    uri,
    name: "n",
    description: "d",
    mimeType: "text/plain",
    handler: async () => "",
  });

  async function registeredToolNames(plugin: LexiconPlugin): Promise<string[]> {
    const s = new McpServer([plugin]);
    const res = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    return (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  }

  async function registeredResourceUris(plugin: LexiconPlugin): Promise<string[]> {
    const s = new McpServer([plugin]);
    const res = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "resources/list" });
    return (res.result as { resources: Array<{ uri: string }> }).resources.map((r) => r.uri);
  }

  test("a tool declared bare registers under one namespace", async () => {
    const names = await registeredToolNames(
      createMockPlugin({ name: "gitlab", mcpTools: () => [tool("migrate")] }),
    );
    expect(names).toContain("gitlab:migrate");
  });

  test("a tool that already carries its prefix is not prefixed twice", async () => {
    // createDiffTool emits `${lexiconName}:diff`, and eleven lexicons write the
    // prefix by hand — this is the case that shipped as `gitlab:gitlab:diff`.
    const names = await registeredToolNames(
      createMockPlugin({ name: "gitlab", mcpTools: () => [tool("gitlab:diff")] }),
    );
    expect(names).toContain("gitlab:diff");
    expect(names).not.toContain("gitlab:gitlab:diff");
  });

  test("a prefix that merely looks like the lexicon's is left alone", async () => {
    const names = await registeredToolNames(
      createMockPlugin({ name: "git", mcpTools: () => [tool("gitlab:diff")] }),
    );
    expect(names).toContain("git:gitlab:diff");
  });

  test("a resource declared as a bare path registers under the lexicon", async () => {
    const uris = await registeredResourceUris(
      createMockPlugin({ name: "aws", mcpResources: () => [resource("examples/s3")] }),
    );
    expect(uris).toContain("chant://aws/examples/s3");
  });

  test("a resource carrying the colon form is not doubled", async () => {
    const uris = await registeredResourceUris(
      createMockPlugin({ name: "aws", mcpResources: () => [resource("aws:resource-catalog")] }),
    );
    expect(uris).toContain("chant://aws/resource-catalog");
  });

  test("the chant://lexicon/<name>/ form the authoring docs taught is normalized", async () => {
    // azure followed lsp-mcp.mdx and shipped `chant://azure/chant://lexicon/azure/catalog`.
    const uris = await registeredResourceUris(
      createMockPlugin({ name: "azure", mcpResources: () => [resource("chant://lexicon/azure/catalog")] }),
    );
    expect(uris).toContain("chant://azure/catalog");
    expect(uris.every((u) => u.indexOf("chant://", 1) === -1)).toBe(true);
  });

  test("an already-registered uri passes through unchanged", async () => {
    const uris = await registeredResourceUris(
      createMockPlugin({ name: "aws", mcpResources: () => [resource("chant://aws/catalog")] }),
    );
    expect(uris).toContain("chant://aws/catalog");
  });
});
