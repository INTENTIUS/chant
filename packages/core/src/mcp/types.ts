/**
 * MCP contribution types for lexicon plugins.
 */

/**
 * MCP's tool annotations (schema 2025-06-18 on), hints a client reads off
 * `tools/list`. A client that gets none treats a tool as one that may change
 * things and may destroy them.
 */
export interface ToolAnnotations {
  /** A human-readable title. */
  title?: string;
  /** The tool changes nothing. */
  readOnlyHint?: boolean;
  /** The tool may destroy what it changes, when not read-only. MCP's default is true. */
  destructiveHint?: boolean;
  /** Calling the tool again with the same arguments changes nothing more. */
  idempotentHint?: boolean;
  /** The tool reaches entities outside a closed domain, such as the web. */
  openWorldHint?: boolean;
}

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
  /**
   * A CI product's tool that writes to the forge and nowhere else (chant#4655):
   * it opens a pull request or posts a comment, and runs no Op, resolves no
   * gate, approves, merges and applies nothing. `chant serve mcp --read-only
   * --propose` serves a product tool that declares this; the read-only server
   * without `--propose` refuses to start with one, and the ordinary server
   * serves it as any other tool. Lexicon tools do not use it.
   */
  forgeWrite?: true;
  /**
   * The tool's MCP annotations, listed in `tools/list` (chant#4823). chant
   * sets `readOnlyHint` and `destructiveHint` from the declaration above,
   * over what this says: `readOnly: true` lists `readOnlyHint: true,
   * destructiveHint: false`, and `forgeWrite: true` lists `readOnlyHint:
   * false, destructiveHint: false`. The other hints, and both on a tool that
   * declares neither, are listed as given.
   */
  annotations?: ToolAnnotations;
}

export interface McpResourceContribution {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
  handler: () => Promise<string>;
}
