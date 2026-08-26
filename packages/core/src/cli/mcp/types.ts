/**
 * MCP message types
 *
 * `id` is optional per JSON-RPC 2.0: a message with no `id` is a
 * notification (e.g. `notifications/initialized`) and gets no response,
 * in every protocol revision (#1194).
 */
export interface McpRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
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
 * The `_meta` envelope the 2026-07-28 revision puts on every request so it
 * is self-contained: client identity and the client's requested protocol
 * version travel here instead of living in handshake state (#1194). A
 * prior-revision client instead sends `protocolVersion`/`clientInfo` as
 * top-level `initialize` params — both forms are read by {@link parseMeta}.
 */
export interface McpRequestMeta {
  protocolVersion?: string;
  "io.modelcontextprotocol/clientInfo"?: { name: string; version?: string };
}

/**
 * Tool definition for MCP
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * JSON schema for `structuredContent` (2025-06-18+), when a tool's result
   * shape is obvious and stable enough to declare. Optional and additive —
   * most tools omit it (#1194).
   */
  outputSchema?: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Resource definition for MCP
 */
export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}

export type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;
