import { lintCommand, lintCommandWatch, printLintResult } from "../commands/lint";
import { formatInfo } from "../format";
import type { CommandContext } from "../registry";

export async function runLint(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  const lintFormat = (args.format || "stylish") as "stylish" | "json" | "sarif";
  if (lintFormat !== "stylish" && lintFormat !== "json" && lintFormat !== "sarif") {
    console.error(`Invalid format for lint: ${lintFormat}. Expected 'stylish', 'json', or 'sarif'.`);
    return 1;
  }

  if (args.watch) {
    const cleanup = lintCommandWatch({
      path: args.path,
      fix: args.fix,
      format: lintFormat,
    });
    process.on("SIGINT", () => {
      cleanup();
      console.error(formatInfo("\nWatch mode stopped."));
      process.exit(0);
    });
    await new Promise(() => {});
  }

  const result = await lintCommand({
    path: args.path,
    fix: args.fix,
    format: lintFormat,
  });

  printLintResult(result);
  return result.success ? 0 : 1;
}
