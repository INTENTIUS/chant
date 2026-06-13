import { buildCommand, buildCommandWatch, printErrors, printWarnings, resolveBuildFormat } from "../commands/build";
import { formatError, formatInfo } from "../format";
import type { CommandContext } from "../registry";

export async function runBuild(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;
  let { serializers } = ctx;

  // Filter to a single lexicon when --lexicon is specified
  if (args.lexicon) {
    serializers = serializers.filter((s) => s.name === args.lexicon);
    if (serializers.length === 0) {
      console.error(formatError({ message: `No serializer found for lexicon "${args.lexicon}". Available: ${ctx.serializers.map((s) => s.name).join(", ")}` }));
      return 1;
    }
  }

  if (args.format && args.format !== "json" && args.format !== "yaml") {
    console.error(formatError({ message: `Invalid format for build: ${args.format}. Expected 'json' or 'yaml'.` }));
    return 1;
  }
  // Infer format from the -o extension when --format is not given; an explicit
  // --format wins but a mismatch warns (#284 bug 1).
  const { format: buildFormat, warning: formatWarningMsg } = resolveBuildFormat(args.format, args.output);
  if (formatWarningMsg) {
    console.error(formatInfo(formatWarningMsg));
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
    env: args.env,
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
