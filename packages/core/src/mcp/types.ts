/**
 * MCP contribution types for lexicon plugins.
 */

export interface McpToolContribution {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface McpResourceContribution {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
  handler: () => Promise<string>;
}
