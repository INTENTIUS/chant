import { createInterface } from "readline";
import { resolve } from "node:path";
import { buildTool, handleBuild } from "./tools/build";
import { lintTool, handleLint } from "./tools/lint";
import { importTool, handleImport } from "./tools/import";
import { explainTool, handleExplain } from "./tools/explain";
import { scaffoldTool, createScaffoldHandler } from "./tools/scaffold";
import { searchTool, createSearchHandler } from "./tools/search";
import type { LexiconPlugin } from "../../lexicon";
import type { McpRequest, McpResponse, McpRequestMeta, ToolDefinition, ToolHandler, ResourceDefinition } from "./types";
import { createSnapshotTool, createDiffTool } from "./lifecycle-tools";
import { createOpListTool, createOpRunTool, createOpStatusTool, createOpSignalTool, createOpReportTool } from "./op-tools";
import { buildResourcesList, handleResourcesRead } from "./resource-handlers";

/**
 * Protocol versions this server understands, newest first. `initialize` and
 * `server/discover` both negotiate against this list rather than assuming
 * the client's revision (#1194).
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2024-11-05"] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * Pick the protocol version to answer with: the client's requested version
 * when we support it, otherwise our latest. A 2024-11-05 client that asks
 * for `2024-11-05` gets it back unchanged; a 2026-07-28 client — or one
 * that never says — gets the latest revision (#1194).
 */
export function negotiateProtocolVersion(requested: string | undefined): string {
  if (requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

/**
 * Parse the `_meta` envelope the 2026-07-28 revision puts on every request
 * (client identity, requested protocol version), falling back to the
 * top-level `protocolVersion`/`clientInfo` fields a prior-revision client
 * sends on `initialize`. Read-side only — the server holds no handshake
 * state to update (#1194).
 */
export function parseMeta(params: Record<string, unknown>): { protocolVersion?: string; clientInfo?: { name: string; version?: string } } {
  const meta = (params._meta ?? {}) as McpRequestMeta;
  const protocolVersion =
    (typeof meta.protocolVersion === "string" ? meta.protocolVersion : undefined) ??
    (typeof params.protocolVersion === "string" ? params.protocolVersion : undefined);
  const clientInfo =
    meta["io.modelcontextprotocol/clientInfo"] ??
    (params.clientInfo as { name: string; version?: string } | undefined);
  return { protocolVersion, clientInfo };
}

/**
 * The name a lexicon's MCP tool is registered under: `<lexicon>:<verb>`,
 * whether or not the lexicon already wrote the prefix itself (#1341).
 */
export function namespacedToolName(lexicon: string, name: string): string {
  const prefix = `${lexicon}:`;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

/**
 * The URI a lexicon's MCP resource is registered under: `chant://<lexicon>/<path>`.
 *
 * Three authored forms reach here (#1341). The bare path is the intended one.
 * `createCatalogResource` emits `<lexicon>:resource-catalog`, and
 * `lexicon-authoring/lsp-mcp.mdx` taught `chant://lexicon/<lexicon>/<path>` —
 * which azure followed, and which produced the unusable
 * `chant://azure/chant://lexicon/azure/catalog`.
 */
export function namespacedResourceUri(lexicon: string, uri: string): string {
  const base = `chant://${lexicon}/`;
  if (uri.startsWith(base)) return uri;
  for (const authored of [`chant://lexicon/${lexicon}/`, `${lexicon}:`]) {
    if (uri.startsWith(authored)) return `${base}${uri.slice(authored.length)}`;
  }
  return `${base}${uri}`;
}

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
   * Register tools contributed by a plugin, namespaced as `lexicon:toolName`.
   *
   * Namespacing is idempotent (#1341). Core is not the only place that applies
   * a prefix: `createDiffTool` in ../../lexicon-plugin-helpers.ts already emits
   * `${lexiconName}:diff`, and eleven lexicons write the prefix into the name by
   * hand. Applying it unconditionally produced `gitlab:gitlab:diff` and
   * `aws:aws:diff` in every `chant serve mcp` session, while every doc named the
   * single-prefixed form. A tool declared either way now registers under exactly
   * one namespace.
   */
  private registerPluginTools(plugin: LexiconPlugin): void {
    const tools = plugin.mcpTools?.() ?? [];
    for (const tool of tools) {
      this.registerTool(
        {
          name: namespacedToolName(plugin.name, tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        tool.handler,
      );
    }
  }

  /**
   * Register resources contributed by a plugin, namespaced as
   * `chant://lexicon/uri`, idempotently — see {@link registerPluginTools}.
   */
  private registerPluginResources(plugin: LexiconPlugin): void {
    const resources = plugin.mcpResources?.() ?? [];
    for (const resource of resources) {
      const namespacedUri = namespacedResourceUri(plugin.name, resource.uri);
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
   * Handle incoming MCP request.
   *
   * A message with no `id` is a notification — `notifications/initialized`
   * being the one every client sends — and gets no response in any
   * protocol revision (#1194). Returns `null` for those; callers (see
   * {@link start}) simply skip writing anything back.
   */
  async handleRequest(request: McpRequest & { id: string | number }): Promise<McpResponse>;
  async handleRequest(request: McpRequest): Promise<McpResponse | null>;
  async handleRequest(request: McpRequest): Promise<McpResponse | null> {
    if (request.id === undefined) {
      return null;
    }
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
   * The `initialize` result — also the basis of `server/discover` below.
   */
  private buildInitializeResult(params: Record<string, unknown>): Record<string, unknown> {
    const { protocolVersion } = parseMeta(params);
    return {
      protocolVersion: negotiateProtocolVersion(protocolVersion),
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "chant", version: "0.1.0" },
    };
  }

  /**
   * Dispatch request to appropriate handler
   */
  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        // Answered for prior-revision clients too — negotiated, not hard-coded (#1194).
        return this.buildInitializeResult(params);

      case "server/discover":
        // On-demand capability discovery (#1194): the initialize result
        // merged with the tools/resources listings, so a 2026-07-28 client
        // never has to call `initialize` at all.
        return {
          ...this.buildInitializeResult(params),
          tools: Array.from(this.tools.values()),
          resources: buildResourcesList(this.pluginResources).resources,
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
      const isStructured = typeof result === "object" && result !== null;
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
        // Structured output (2025-06-18+): handlers already return plain
        // objects that get stringified above, so agents that want the
        // parsed shape directly get it here too, alongside the text block
        // kept for backward compatibility (#1194).
        ...(isStructured ? { structuredContent: result } : {}),
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
        // Notifications (#1194) get no response at all — not even an empty one.
        if (response !== null) {
          console.log(JSON.stringify(response));
        }
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
