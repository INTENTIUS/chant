import { buildCommand, buildCommandWatch, printErrors, printWarnings } from "../commands/build";
import { formatInfo } from "../format";
import type { CommandContext } from "../registry";

export async function runBuild(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;
  let { serializers } = ctx;

  // Filter to a single lexicon when --lexicon is specified
  if (args.lexicon) {
    serializers = serializers.filter((s) => s.name === args.lexicon);
    if (serializers.length === 0) {
      console.error(`No serializer found for lexicon "${args.lexicon}". Available: ${ctx.serializers.map((s) => s.name).join(", ")}`);
      return 1;
    }
  }

  const buildFormat = (args.format || "json") as "json" | "yaml";
  if (buildFormat !== "json" && buildFormat !== "yaml") {
    console.error(`Invalid format for build: ${buildFormat}. Expected 'json' or 'yaml'.`);
    return 1;
  }

  if (args.watch) {
    const cleanup = buildCommandWatch({
      path: args.path,
      output: args.output,
      format: buildFormat,
      serializers,
      plugins,
    });
    process.on("SIGINT", () => {
      cleanup();
      console.error(formatInfo("\nWatch mode stopped."));
      process.exit(0);
    });
    await new Promise(() => {});
  }

  const result = await buildCommand({
    path: args.path,
    output: args.output,
    format: buildFormat,
    serializers,
    plugins,
    verbose: args.verbose,
  });

  // When --lexicon filters to a subset, suppress "No serializer" warnings for excluded lexicons
  let warnings = result.warnings;
  if (args.lexicon) {
    warnings = warnings.filter((w) => !w.includes('No serializer found for lexicon'));
  }
  printWarnings(warnings);
  printErrors(result.errors);

  return result.success ? 0 : 1;
}
