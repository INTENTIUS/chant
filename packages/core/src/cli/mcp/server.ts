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
import { readSnapshot, readEnvironmentSnapshots } from "../../state/git";
import { build } from "../../build";
import { computeBuildDigest, diffDigests } from "../../state/digest";
import { takeSnapshot } from "../../state/snapshot";
import type { StateSnapshot } from "../../state/types";
import { discoverSpells } from "../../spell/discovery";
import { generatePrompt } from "../../spell/prompt";
import { getRuntime } from "../../runtime-adapter";

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

    // Register state tools
    this.registerTool(
      {
        name: "state-snapshot",
        description: "Capture deployed state for an environment",
        inputSchema: {
          type: "object",
          properties: {
            environment: { type: "string", description: "Target environment" },
            lexicon: { type: "string", description: "Optional — snapshot all lexicons if omitted" },
          },
          required: ["environment"],
        },
      },
      async (params) => {
        const env = params.environment as string;
        const lexiconFilter = params.lexicon as string | undefined;
        const targetPlugins = lexiconFilter
          ? (plugins ?? []).filter((p) => p.name === lexiconFilter)
          : (plugins ?? []);
        const pluginsWithDescribe = targetPlugins.filter((p) => p.describeResources);
        if (pluginsWithDescribe.length === 0) return "No plugins implement describeResources";
        const serializers = (plugins ?? []).map((p) => p.serializer);
        const buildResult = await build(resolve("."), serializers);
        if (buildResult.errors.length > 0) return "Build failed";
        const result = await takeSnapshot(env, pluginsWithDescribe, buildResult);
        return { snapshots: result.snapshots.length, warnings: result.warnings, errors: result.errors };
      },
    );

    this.registerTool(
      {
        name: "state-diff",
        description: "Compare current build declarations against last snapshot's digest",
        inputSchema: {
          type: "object",
          properties: {
            environment: { type: "string", description: "Target environment" },
            lexicon: { type: "string", description: "Optional — diff all lexicons if omitted" },
          },
          required: ["environment"],
        },
      },
      async (params) => {
        const env = params.environment as string;
        const lexiconFilter = params.lexicon as string | undefined;
        const serializers = (plugins ?? []).map((p) => p.serializer);
        const buildResult = await build(resolve("."), serializers);
        if (buildResult.errors.length > 0) return "Build failed";
        const currentDigest = computeBuildDigest(buildResult);
        const lexicons = lexiconFilter ? [lexiconFilter] : buildResult.manifest.lexicons;
        const results: Record<string, unknown> = {};
        for (const lex of lexicons) {
          const content = await readSnapshot(env, lex);
          let previousDigest = undefined;
          if (content) {
            const snapshot: StateSnapshot = JSON.parse(content);
            previousDigest = snapshot.digest;
          }
          results[lex] = diffDigests(currentDigest, previousDigest);
        }
        return results;
      },
    );

    // Register spell tools
    this.registerTool(
      {
        name: "spell-done",
        description: "Mark a spell task as done",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Spell name" },
            taskNumber: { type: "number", description: "Task number (1-based)" },
          },
          required: ["name", "taskNumber"],
        },
      },
      async (params) => {
        const { readFileSync, writeFileSync } = await import("node:fs");
        const { spells } = await discoverSpells();
        const name = params.name as string;
        const taskNumber = params.taskNumber as number;
        const spell = spells.get(name);
        if (!spell) return `Spell "${name}" not found`;
        if (taskNumber < 1 || taskNumber > spell.definition.tasks.length) {
          return `Invalid task number ${taskNumber}`;
        }
        const task = spell.definition.tasks[taskNumber - 1];
        if (task.done) return `Task ${taskNumber} is already done`;

        const content = readFileSync(spell.filePath, "utf-8");
        let count = 0;
        const rewritten = content.replace(
          /task\(("[^"]*"|'[^']*'|`[^`]*`)((?:\s*,\s*\{[^}]*\})?)\)/g,
          (match, desc, opts) => {
            count++;
            if (count !== taskNumber) return match;
            if (opts && opts.includes("done:")) {
              return match.replace(/done:\s*false/, "done: true");
            }
            return `task(${desc}, { done: true })`;
          },
        );
        if (rewritten === content) return `Could not rewrite task ${taskNumber}`;
        writeFileSync(spell.filePath, rewritten);
        return `Task ${taskNumber} marked done: "${task.description}"`;
      },
    );

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
      {
        uri: "chant://spells",
        name: "Spells",
        description: "List all spells with status, tasks, and lexicon",
        mimeType: "application/json",
      },
      {
        uri: "chant://spell/{name}",
        name: "Spell details",
        description: "Show spell definition and status",
        mimeType: "application/json",
      },
      {
        uri: "chant://spell/{name}/prompt",
        name: "Spell bootstrap prompt",
        description: "Bootstrap prompt for agent consumption",
        mimeType: "text/markdown",
      },
      {
        uri: "chant://state/{environment}",
        name: "State (all lexicons)",
        description: "All lexicon snapshots for an environment",
        mimeType: "application/json",
      },
      {
        uri: "chant://state/{environment}/{lexicon}",
        name: "State (single lexicon)",
        description: "Single lexicon snapshot for an environment",
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

    // Spell resources
    if (uri === "chant://spells") {
      const { spells } = await discoverSpells();
      const list = Array.from(spells.entries()).map(([name, s]) => ({
        name,
        status: s.status,
        tasks: `${s.definition.tasks.filter((t) => t.done).length}/${s.definition.tasks.length}`,
        lexicon: s.definition.lexicon ?? null,
        overview: s.definition.overview,
      }));
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(list, null, 2) }],
      };
    }

    if (uri.startsWith("chant://spell/") && uri.endsWith("/prompt")) {
      const name = uri.replace("chant://spell/", "").replace("/prompt", "");
      const { spells } = await discoverSpells();
      const spell = spells.get(name);
      if (!spell) throw new Error(`Spell "${name}" not found`);
      const rt = getRuntime();
      const gitRootResult = await rt.spawn(["git", "rev-parse", "--show-toplevel"]);
      const gitRoot = gitRootResult.stdout.trim();
      const prompt = await generatePrompt(spell.definition, { gitRoot });
      return {
        contents: [{ uri, mimeType: "text/markdown", text: prompt }],
      };
    }

    if (uri.startsWith("chant://spell/")) {
      const name = uri.replace("chant://spell/", "");
      const { spells } = await discoverSpells();
      const spell = spells.get(name);
      if (!spell) throw new Error(`Spell "${name}" not found`);
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            ...spell.definition,
            status: spell.status,
            filePath: spell.filePath,
          }, null, 2),
        }],
      };
    }

    // State resources: chant://state/{environment} and chant://state/{environment}/{lexicon}
    if (uri.startsWith("chant://state/")) {
      const parts = uri.replace("chant://state/", "").split("/");
      const environment = parts[0];
      const lexicon = parts[1];

      if (lexicon) {
        const content = await readSnapshot(environment, lexicon);
        if (!content) throw new Error(`No snapshot found for ${environment}/${lexicon}`);
        return {
          contents: [{ uri, mimeType: "application/json", text: content }],
        };
      } else {
        const snapshots = await readEnvironmentSnapshots(environment);
        const result: Record<string, unknown> = {};
        for (const [lex, content] of snapshots) {
          result[lex] = JSON.parse(content);
        }
        return {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
        };
      }
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
