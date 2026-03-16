/**
 * MCP message types
 */
export interface McpRequest {
  jsonrpc: "2.0";
  id: string | number;
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
