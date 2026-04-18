import { createInterface } from "readline";
import { resolve } from "node:path";
import { buildTool, handleBuild } from "./tools/build";
import { lintTool, handleLint } from "./tools/lint";
import { importTool, handleImport } from "./tools/import";
import { explainTool, handleExplain } from "./tools/explain";
import { scaffoldTool, createScaffoldHandler } from "./tools/scaffold";
import { searchTool, createSearchHandler } from "./tools/search";
import type { LexiconPlugin } from "../../lexicon";
import type { McpRequest, McpResponse, ToolDefinition, ToolHandler, ResourceDefinition } from "./types";
import { createSnapshotTool, createDiffTool } from "./state-tools";
import { createOpListTool, createOpRunTool, createOpStatusTool, createOpSignalTool, createOpReportTool } from "./op-tools";
import { buildResourcesList, handleResourcesRead } from "./resource-handlers";

/**
 * MCP Server implementation
 */
export class McpServer {
  private tools: Map<string, ToolDefinition> = new Map();
  private toolHandlers: Map<string, ToolHandler> = new Map();
  private pluginResources: Map<string, { definition: ResourceDefinition; handler: () => Promise<string> }> = new Map();

  constructor(plugins?: LexiconPlugin[]) {
    // Register core tools
    this.registerTool(buildTool, handleBuild);
    this.registerTool(lintTool, handleLint);
    this.registerTool(importTool, handleImport);
    this.registerTool(explainTool, handleExplain);
    this.registerTool(scaffoldTool, createScaffoldHandler(plugins ?? []));
    this.registerTool(searchTool, createSearchHandler(plugins ?? []));

    // Register state tools
    const snapshot = createSnapshotTool(plugins ?? []);
    this.registerTool(snapshot.definition, snapshot.handler);

    const diff = createDiffTool(plugins ?? []);
    this.registerTool(diff.definition, diff.handler);

    // Register Op tools
    for (const factory of [createOpListTool, createOpRunTool, createOpStatusTool, createOpSignalTool, createOpReportTool]) {
      const t = factory();
      this.registerTool(t.definition, t.handler);
    }

    // Register plugin contributions
    if (plugins) {
      for (const plugin of plugins) {
        this.registerPluginTools(plugin);
        this.registerPluginResources(plugin);
      }
    }
  }

  /**
   * Register tools contributed by a plugin, namespaced as `lexicon:toolName`
   */
  private registerPluginTools(plugin: LexiconPlugin): void {
    const tools = plugin.mcpTools?.() ?? [];
    for (const tool of tools) {
      const namespacedName = `${plugin.name}:${tool.name}`;
      this.registerTool(
        {
          name: namespacedName,
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        tool.handler,
      );
    }
  }

  /**
   * Register resources contributed by a plugin, namespaced as `chant://lexicon/uri`
   */
  private registerPluginResources(plugin: LexiconPlugin): void {
    const resources = plugin.mcpResources?.() ?? [];
    for (const resource of resources) {
      const namespacedUri = `chant://${plugin.name}/${resource.uri}`;
      this.pluginResources.set(namespacedUri, {
        definition: {
          uri: namespacedUri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType,
        },
        handler: resource.handler,
      });
    }
  }

  /**
   * Register a tool with its handler
   */
  private registerTool(
    definition: ToolDefinition,
    handler: ToolHandler,
  ): void {
    this.tools.set(definition.name, definition);
    this.toolHandlers.set(definition.name, handler);
  }

  /**
   * Handle incoming MCP request
   */
  async handleRequest(request: McpRequest): Promise<McpResponse> {
    try {
      const result = await this.dispatch(request.method, request.params ?? {});
      return {
        jsonrpc: "2.0",
        id: request.id,
        result,
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * Dispatch request to appropriate handler
   */
  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "chant", version: "0.1.0" },
        };

      case "tools/list":
        return { tools: Array.from(this.tools.values()) };

      case "tools/call":
        return this.handleToolsCall(params);

      case "resources/list":
        return buildResourcesList(this.pluginResources);

      case "resources/read":
        return handleResourcesRead(params, this.pluginResources);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name as string;
    const toolParams = (params.arguments ?? {}) as Record<string, unknown>;

    const handler = this.toolHandlers.get(name);
    if (!handler) {
      return {
        content: [{ type: "text", text: `Error: Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await handler(toolParams);
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Start the MCP server on stdio
   */
  async start(): Promise<void> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", async (line) => {
      try {
        const request = JSON.parse(line) as McpRequest;
        const response = await this.handleRequest(request);
        console.log(JSON.stringify(response));
      } catch (error) {
        const errorResponse: McpResponse = {
          jsonrpc: "2.0",
          id: 0,
          error: {
            code: -32700,
            message: "Parse error",
          },
        };
        console.log(JSON.stringify(errorResponse));
      }
    });
  }
}

/**
 * Start MCP server, loading plugins from the project
 */
export async function startMcpServer(): Promise<void> {
  let plugins: LexiconPlugin[] = [];
  try {
    const { resolveProjectLexicons, loadPlugins } = await import("../plugins");
    const lexiconNames = await resolveProjectLexicons(resolve("."));
    plugins = await loadPlugins(lexiconNames);
  } catch {
    // Start without plugins if resolution fails
  }

  const server = new McpServer(plugins);
  server.start();
}
