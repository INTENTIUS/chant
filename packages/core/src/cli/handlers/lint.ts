import { resolve } from "node:path";
import { lintCommand, lintCommandWatch, printLintResult } from "../commands/lint";
import { formatError, formatInfo } from "../format";
import type { CommandContext } from "../registry";
import { commandBuildParams } from "../build-params-cli";
import { loadChantConfigUpward, type ChantConfig } from "../../config";

/**
 * chant #2251 — `chant lint` resolves this invocation's declared build-time
 * parameters (`chant.config.ts`'s `buildParams`) before it lints, the same
 * way `chant build` and the lifecycle family do (`commandBuildParams`,
 * ../build-params-cli.ts).
 *
 * The OPS* checks import every `*.op.ts` file to read the Op it declares
 * (../commands/lint.ts's `runOpCheckDiagnostics`), and an Op that takes a
 * step argument from `params.<name>` (`@intentius/chant/params`) evaluates
 * that read at module load. With no parameters resolved, `params` is the
 * empty object every such argument reads `undefined` out of, and OPS012
 * reports the activity contract violated — `args.env: expected string,
 * received undefined` — for source that builds and runs correctly. The
 * config is loaded by walking up from the lint path, so linting a
 * subdirectory still sees the project root's declarations.
 */
async function lintBuildParams(args: { path: string; param?: string[]; paramsFile?: string }) {
  const { config } = await loadChantConfigUpward(resolve(args.path)).catch(() => ({ config: {} as ChantConfig }));
  if (!config.buildParams) return [];
  return commandBuildParams(config.buildParams, args);
}

export async function runLint(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  const lintFormat = (args.format || "stylish") as "stylish" | "json" | "sarif";
  if (lintFormat !== "stylish" && lintFormat !== "json" && lintFormat !== "sarif") {
    console.error(formatError({ message: `Invalid format for lint: ${lintFormat}. Expected 'stylish', 'json', or 'sarif'.` }));
    return 1;
  }

  const buildParams = await lintBuildParams(args);
  if (buildParams === undefined) return 1;

  if (args.watch) {
    const cleanup = lintCommandWatch({
      path: args.path,
      fix: args.fix,
      format: lintFormat,
      sandbox: args.sandbox,
      buildParams,
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
    sandbox: args.sandbox,
    buildParams,
  });

  printLintResult(result);
  return result.success ? 0 : 1;
}
