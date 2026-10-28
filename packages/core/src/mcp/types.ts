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
  /**
   * The tool reads and changes nothing (chant#4543): it runs no Op, resolves
   * no gate, writes no file or record, and captures nothing to a store. Only a
   * tool that declares this is served by `chant serve mcp --read-only`; a tool
   * that leaves it out is served only by the ordinary server.
   */
  readOnly?: boolean;
}

export interface McpResourceContribution {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
  handler: () => Promise<string>;
}
