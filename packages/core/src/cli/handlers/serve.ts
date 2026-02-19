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
  const { McpServer } = await import("../mcp/server");
  const server = new McpServer(ctx.plugins);
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
