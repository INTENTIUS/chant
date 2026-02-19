import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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
      expect(result.protocolVersion).toBe("2024-11-05");
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
      const result = response.result as Record<string, unknown>;
      const caps = result.capabilities as Record<string, unknown>;
      expect(caps.tools).toBeDefined();
      expect(caps.resources).toBeDefined();
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
    test("returns core tools (build, lint, import)", async () => {
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
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name).sort()).toEqual(["build", "import", "lint"]);

      const resourcesRes = await s.handleRequest({ jsonrpc: "2.0", id: 3, method: "resources/list" });
      const resources = (resourcesRes.result as { resources: Array<{ uri: string }> }).resources;
      expect(resources).toHaveLength(2);
    });

    test("server with empty plugins array works", async () => {
      const s = new McpServer([]);
      const toolsRes = await s.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const tools = (toolsRes.result as { tools: Array<{ name: string }> }).tools;
      expect(tools).toHaveLength(3);
    });
  });
});
