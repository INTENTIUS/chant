import { formatError } from "../format";
import type { CommandContext } from "../registry";

export async function runServeLsp(ctx: CommandContext): Promise<number> {
  const { LspServer } = await import("../lsp/server");
  const server = new LspServer(ctx.plugins);
  await server.start();
  await new Promise(() => {});
  return 0; // unreachable
}

export async function runServeMcp(ctx: CommandContext): Promise<number> {
  // chant#4655 — --propose is a tier of the read-only server, never of the ordinary one.
  if (ctx.args.propose === true && ctx.args.readOnly !== true) {
    console.error(formatError({
      message: "chant serve mcp --propose needs --read-only",
      hint: "Usage: chant serve mcp --read-only --propose (serves the read tools and a product's tools that open pull requests)",
    }));
    return 1;
  }
  const { McpServer } = await import("../mcp/server");
  // #2700 — main() hands over no plugins only at a workspace root with no
  // lexicon of its own (anywhere else it refuses first). There the lexicons
  // are the chant members', and the server says which loaded.
  let plugins = ctx.plugins;
  let instructions: string | undefined;
  if (plugins.length === 0) {
    const { loadWorkspacePlugins } = await import("../mcp/workspace-plugins");
    ({ plugins, instructions } = await loadWorkspacePlugins(process.cwd()));
  }
  // #2707 — at or inside a declared workspace, the workspace tools are served too.
  // chant#4543 — --read-only serves only the tools that change nothing.
  // chant#4555 — a product's bin that set its tool hook serves its tools too, read-only unless the hook says otherwise.
  const { activeProductMcpHook } = await import("../mcp/product-tools");
  const product = activeProductMcpHook();
  const server = new McpServer(plugins, {
    instructions,
    workspace: { cwd: process.cwd() },
    ...(ctx.args.readOnly === true ? { readOnly: true } : {}),
    ...(ctx.args.propose === true ? { propose: true } : {}),
    ...(product ? { product } : {}),
  });
  await server.start();
  await new Promise(() => {});
  return 0; // unreachable
}

export async function runServeUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown serve subcommand: ${ctx.args.path}`,
    hint: "Available: chant serve lsp, chant serve mcp",
  }));
  return 1;
}
