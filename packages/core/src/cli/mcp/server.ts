import { createInterface } from "readline";
import { resolve } from "node:path";
import { buildTool, handleBuild } from "./tools/build";
import { lintTool, handleLint } from "./tools/lint";
import { importTool, handleImport } from "./tools/import";
import { explainTool, handleExplain } from "./tools/explain";
import { scaffoldTool, createScaffoldHandler } from "./tools/scaffold";
import { searchTool, createSearchHandler } from "./tools/search";
import { compositesTool, createCompositesHandler } from "./tools/composites";
import { capabilitiesTool, createCapabilitiesHandler } from "./tools/capabilities";
import type { LexiconPlugin } from "../../lexicon";
import type { McpClientInfo, McpRequest, McpResponse, McpRequestMeta, ToolDefinition, ToolHandler, ResourceDefinition } from "./types";
import { findWorkspaceRoot } from "../../project-root";
import { createWorkspaceTools, type WorkspaceToolsOptions } from "./workspace-tools";
import { createSnapshotTool, createDiffTool } from "./lifecycle-tools";
import { setGateOrigin } from "../../lifecycle/gate-origin";
import { createOpListTool, createOpRunTool, createOpStatusTool, createOpApproveTool, createOpReportTool } from "./op-tools";
import { buildResourcesList, handleResourcesRead } from "./resource-handlers";
import { createLedgerTools } from "./ledger-tools";
import { createReportTools } from "./report-tools";
import { activeProductMcpHook, productMcpContext, productToolsServed, type ProductMcpHook } from "./product-tools";
import { MUTATING_CORE_TOOLS, READ_ONLY_CORE_TOOLS, ReadOnlyRegistrationError, servesContributedTool } from "./read-only";
import { CHANT_VERSION } from "../version";

/**
 * Protocol versions this server understands, newest first. `initialize` and
 * `server/discover` both negotiate against this list rather than assuming
 * the client's revision (#1194).
 *
 * Exported because `docs-parity.test.ts` reads it: `cli/mcp.mdx` states these
 * revisions in prose, and stating them twice is how the page came to claim
 * 2024-11-05 for two releases after this list moved past it (#2385).
 *
 * The 2025 revisions are here because Claude Code 2.1.274 asks for
 * 2025-11-25 and rejects any answer outside 2025-11-25, 2025-06-18,
 * 2025-03-26, 2024-11-05 and 2024-10-07. A 2025 client sends
 * `protocolVersion`/`clientInfo` at the top level of `initialize`, which
 * {@link parseMeta} already falls back to, so it needs no other branch.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * Pick the protocol version to answer with: the client's requested version
 * when we support it, otherwise our latest. A 2024-11-05 or 2025 client that
 * asks for its own version gets it back unchanged; a 2026-07-28 client, or one
 * that never says, gets the latest revision (#1194).
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
export function parseMeta(params: Record<string, unknown>): { protocolVersion?: string; clientInfo?: McpClientInfo } {
  const meta = (params._meta ?? {}) as McpRequestMeta;
  const protocolVersion =
    (typeof meta.protocolVersion === "string" ? meta.protocolVersion : undefined) ??
    (typeof params.protocolVersion === "string" ? params.protocolVersion : undefined);
  const clientInfo =
    meta["io.modelcontextprotocol/clientInfo"] ??
    (params.clientInfo as McpClientInfo | undefined);
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

/** What a read-only server says about itself in `initialize`'s `instructions` (chant#4543). */
export const READ_ONLY_INSTRUCTIONS =
  "This chant server is read-only: it serves the ledger, the workspace graph, runs, gates and snapshots, and no tool here runs an Op, resolves a gate or writes anything.";

/** The `lint` a read-only server serves: the same tool with no `fix` (chant#4543). */
const readOnlyLintTool: ToolDefinition = {
  ...lintTool,
  description: `${lintTool.description}. This server is read-only: it reports issues and fixes none.`,
  inputSchema: { ...lintTool.inputSchema, properties: { path: lintTool.inputSchema.properties.path } },
};

async function handleReadOnlyLint(params: Record<string, unknown>): Promise<unknown> {
  if (params.fix === true) throw new Error("fix is not available on a read-only server: run chant lint --fix at a shell");
  return handleLint({ ...params, fix: false });
}

/**
 * MCP Server implementation
 */
export class McpServer {
  private tools: Map<string, ToolDefinition> = new Map();
  private toolHandlers: Map<string, ToolHandler> = new Map();
  private pluginResources: Map<string, { definition: ResourceDefinition; handler: () => Promise<string> }> = new Map();
  private plugins: LexiconPlugin[];
  private instructions: string | undefined;
  /** The `clientInfo` the client gave on `initialize`, for a request that carries none in `_meta` (#2707). */
  private clientInfo: McpClientInfo | undefined;
  /** `chant serve mcp --read-only` (chant#4543): only tools that change nothing are registered. */
  readonly readOnly: boolean;

  /**
   * `options.instructions` is sent as the `initialize` result's
   * `instructions`, the text a client may give its model about this server.
   * Only a workspace root with no lexicon of its own sets it (#2700), to say
   * which members' lexicons were loaded.
   *
   * `options.workspace` names the directory the server serves (#2707). When
   * it is at or inside a declared workspace, the workspace read-contract and
   * record-write tools are served too.
   *
   * `options.readOnly` (`chant serve mcp --read-only`, chant#4543) serves
   * only the tools that change nothing: the core tools in
   * `READ_ONLY_CORE_TOOLS` (./read-only.ts), `lint` without `fix`, the
   * workspace reads without the writes, and the plugin tools that declare
   * `readOnly: true`.
   *
   * `options.product` (chant#4555) is a CI product's tool hook
   * (./product-tools.ts): its tools are registered as `<product>:<name>`,
   * under the same read-only rule as a plugin's, and a read-only server
   * refuses to start with one named as a write. With a hook and no
   * `readOnly`, the server is read-only unless the hook says otherwise.
   */
  constructor(plugins?: LexiconPlugin[], options: { instructions?: string; workspace?: WorkspaceToolsOptions; readOnly?: boolean; product?: ProductMcpHook } = {}) {
    this.plugins = plugins ?? [];
    const product = options.product;
    this.readOnly = options.readOnly ?? (product ? product.readOnly !== false : false);
    const said = [options.instructions, product?.instructions].filter((s): s is string => s !== undefined);
    this.instructions = this.readOnly
      ? [...said, READ_ONLY_INSTRUCTIONS].join("\n\n")
      : said.length > 0 ? said.join("\n\n") : undefined;
    const cwd = options.workspace?.cwd ?? process.cwd();
    // Register core tools
    this.registerCoreTool(buildTool, handleBuild);
    if (this.readOnly) this.registerCoreTool(readOnlyLintTool, handleReadOnlyLint);
    else this.registerCoreTool(lintTool, handleLint);
    this.registerCoreTool(importTool, handleImport);
    this.registerCoreTool(explainTool, handleExplain);
    this.registerCoreTool(scaffoldTool, createScaffoldHandler(plugins ?? []));
    this.registerCoreTool(searchTool, createSearchHandler(plugins ?? []));
    this.registerCoreTool(compositesTool, createCompositesHandler(plugins ?? []));
    // The capability catalog (#4375), the read contract's capabilities document.
    this.registerCoreTool(capabilitiesTool, createCapabilitiesHandler(cwd, options.workspace?.chantCommand));

    // Register state tools
    const snapshot = createSnapshotTool(plugins ?? []);
    this.registerCoreTool(snapshot.definition, snapshot.handler);

    const diff = createDiffTool(plugins ?? []);
    this.registerCoreTool(diff.definition, diff.handler);

    // Register Op tools
    for (const factory of [createOpListTool, createOpRunTool, createOpStatusTool, createOpApproveTool, createOpReportTool]) {
      const t = factory();
      this.registerCoreTool(t.definition, t.handler);
    }

    // The ledger read contract and chant query (chant#4543), in both modes.
    for (const t of createLedgerTools({ cwd, chantCommand: options.workspace?.chantCommand })) this.registerCoreTool(t.definition, t.handler);

    // The report store (chant#4555), in both modes: the product hook's store, else ci.reportUrl.
    for (const t of createReportTools({ cwd, ...(product?.reportUrl ? { reportUrl: product.reportUrl } : {}) })) this.registerCoreTool(t.definition, t.handler);

    // Workspace reads and record writes (#2707), inside a declared workspace only.
    if (options.workspace && findWorkspaceRoot(options.workspace.cwd)) {
      for (const t of createWorkspaceTools(options.workspace)) this.registerCoreTool(t.definition, t.handler);
    }

    // Register plugin contributions
    if (plugins) {
      for (const plugin of plugins) {
        this.registerPluginTools(plugin);
        this.registerPluginResources(plugin);
      }
    }

    // A CI product's tools (chant#4555), read-only by default as chant#4543 rules for contributed tools.
    if (product) {
      for (const tool of productToolsServed(product, productMcpContext(product, cwd, this.readOnly))) {
        this.registerTool({ name: namespacedToolName(product.product, tool.name), description: tool.description, inputSchema: tool.inputSchema }, tool.handler);
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
      // A read-only server serves a plugin tool only when it says it changes nothing (chant#4543).
      if (!servesContributedTool(tool, this.readOnly)) continue;
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
   * Register a core tool. On a read-only server a mutating core tool is
   * left out, and a core tool on neither list of ./read-only.ts is refused
   * with an error, so a new tool cannot reach a read-only server unsorted.
   */
  private registerCoreTool(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.readOnly && !READ_ONLY_CORE_TOOLS.has(definition.name)) {
      if (MUTATING_CORE_TOOLS.has(definition.name)) return;
      throw new ReadOnlyRegistrationError(definition.name);
    }
    this.registerTool(definition, handler);
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
      // The installed chant's version, so a client can tell which chant it talks to (#2689).
      serverInfo: { name: "chant", version: CHANT_VERSION },
      ...(this.instructions ? { instructions: this.instructions } : {}),
    };
  }

  /**
   * Dispatch request to appropriate handler
   */
  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        // Kept for a write's source block (#2707): a prior-revision client names itself only here.
        this.clientInfo = parseMeta(params).clientInfo ?? this.clientInfo;
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
        return handleResourcesRead(params, this.pluginResources, this.plugins);

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
      // The client, from this request's _meta (2026-07-28) or else from initialize.
      const clientInfo = parseMeta(params).clientInfo ?? this.clientInfo;
      const result = await handler(toolParams, clientInfo ? { clientInfo } : {});
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
    // chant#2384 — declared here rather than in the constructor, because this
    // is where the PROCESS becomes an MCP server. Constructing the object does
    // not change what the process is, and a test that builds one should not
    // silently make every later gate fact in that worker read as model-authored.
    //
    // From here on a person's only act was launching this; every call is the
    // model's. So every gate fact written records the channel it came through,
    // and a gate reached here cannot also be resolved here.
    setGateOrigin("mcp");

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
export async function startMcpServer(options: { readOnly?: boolean } = {}): Promise<void> {
  let plugins: LexiconPlugin[] = [];
  try {
    const { resolveProjectLexicons, loadPlugins } = await import("../plugins");
    const lexiconNames = await resolveProjectLexicons(resolve("."));
    plugins = await loadPlugins(lexiconNames);
  } catch {
    // Start without plugins if resolution fails
  }

  const product = activeProductMcpHook();
  const server = new McpServer(plugins, {
    workspace: { cwd: process.cwd() },
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(product ? { product } : {}),
  });
  server.start();
}
