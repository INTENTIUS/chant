import { createInterface } from "readline";
import { resolve } from "node:path";
import { buildTool, handleBuild } from "./tools/build";
import { lintTool, handleLint } from "./tools/lint";
import { importTool, handleImport } from "./tools/import";
import { explainTool, handleExplain } from "./tools/explain";
import { scaffoldTool, createScaffoldHandler } from "./tools/scaffold";
import { searchTool, createSearchHandler } from "./tools/search";
import { getContext } from "./resources/context";
import type { LexiconPlugin } from "../../lexicon";
import type { McpToolContribution, McpResourceContribution } from "../../mcp/types";

/**
 * MCP message types
 */
interface McpRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Tool definition for MCP
 */
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Resource definition for MCP
 */
interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}

/**
 * MCP Server implementation
 */
export class McpServer {
  private tools: Map<string, ToolDefinition> = new Map();
  private toolHandlers: Map<string, (params: Record<string, unknown>) => Promise<unknown>> = new Map();
  private pluginResources: Map<string, { definition: ResourceDefinition; handler: () => Promise<string> }> = new Map();

  constructor(plugins?: LexiconPlugin[]) {
    // Register core tools
    this.registerTool(buildTool, handleBuild);
    this.registerTool(lintTool, handleLint);
    this.registerTool(importTool, handleImport);
    this.registerTool(explainTool, handleExplain);
    this.registerTool(scaffoldTool, createScaffoldHandler(plugins ?? []));
    this.registerTool(searchTool, createSearchHandler(plugins ?? []));

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
    handler: (params: Record<string, unknown>) => Promise<unknown>
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
        return this.handleInitialize(params);

      case "tools/list":
        return this.handleToolsList();

      case "tools/call":
        return this.handleToolsCall(params);

      case "resources/list":
        return this.handleResourcesList();

      case "resources/read":
        return this.handleResourcesRead(params);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Handle initialize request
   */
  private handleInitialize(params: Record<string, unknown>): unknown {
    return {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        resources: {},
      },
      serverInfo: {
        name: "chant",
        version: "0.1.0",
      },
    };
  }

  /**
   * Handle tools/list request
   */
  private handleToolsList(): unknown {
    return {
      tools: Array.from(this.tools.values()),
    };
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
        content: [
          {
            type: "text",
            text: `Error: Unknown tool: ${name}`,
          },
        ],
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
   * Handle resources/list request — merges core + plugin resources
   */
  private handleResourcesList(): unknown {
    const resources: ResourceDefinition[] = [
      {
        uri: "chant://context",
        name: "chant Context",
        description: "Lexicon-specific instructions and patterns for chant development",
        mimeType: "text/markdown",
      },
      {
        uri: "chant://examples/list",
        name: "Examples List",
        description: "List of available chant examples",
        mimeType: "application/json",
      },
    ];

    // Merge plugin resources
    for (const { definition } of this.pluginResources.values()) {
      resources.push(definition);
    }

    return { resources };
  }

  /**
   * Collect example resources from plugins whose URI contains "examples/"
   */
  private collectExamples(): Array<{ name: string; description: string }> {
    const examples: Array<{ name: string; description: string }> = [];
    for (const [uri, { definition }] of this.pluginResources.entries()) {
      if (uri.includes("/examples/")) {
        const name = uri.replace(/^chant:\/\/[^/]+\/examples\//, "");
        examples.push({ name, description: definition.description });
      }
    }
    return examples;
  }

  /**
   * Handle resources/read request — checks plugin resources after core
   */
  private async handleResourcesRead(params: Record<string, unknown>): Promise<unknown> {
    const uri = params.uri as string;

    if (uri === "chant://context") {
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: getContext(),
          },
        ],
      };
    }

    if (uri === "chant://examples/list") {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(this.collectExamples()),
          },
        ],
      };
    }

    if (uri.startsWith("chant://examples/")) {
      // Look up example in plugin resources
      const name = uri.replace("chant://examples/", "");
      for (const [pluginUri, pluginResource] of this.pluginResources.entries()) {
        if (pluginUri.endsWith(`/examples/${name}`)) {
          const text = await pluginResource.handler();
          return {
            contents: [
              {
                uri,
                mimeType: pluginResource.definition.mimeType ?? "text/typescript",
                text,
              },
            ],
          };
        }
      }
      throw new Error(`Example not found: ${name}`);
    }

    // Check plugin resources
    const pluginResource = this.pluginResources.get(uri);
    if (pluginResource) {
      const text = await pluginResource.handler();
      return {
        contents: [
          {
            uri,
            mimeType: pluginResource.definition.mimeType ?? "text/plain",
            text,
          },
        ],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
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
