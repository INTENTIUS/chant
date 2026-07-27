import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildCommand, buildCommandWatch, printErrors, printWarnings, resolveBuildFormat } from "../commands/build";
import { formatError, formatInfo, formatSuccess, formatBold } from "../format";
import type { CommandContext } from "../registry";
import { generateComponentsPipeline } from "../../components/cli-support";

/**
 * `chant build --components --generate <lexicon>` — generate mode (#563,
 * epic #551 Phase 3). Discovers `Component` declarations under `args.path`
 * and synthesizes a thin CI pipeline for `lexicon` instead of running a
 * normal lexicon build: no entity discovery, no serializers, no post-synth
 * checks — those apply to lexicon resources, which is a different input to
 * a different command path (`chant build` without `--components`).
 */
async function runGenerateComponents(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const lexicon = args.generate as string;

  // Which lexicons support generate mode is a property of the loaded lexicon
  // plugins (those implementing `generateComponentPipeline`, #688), not a
  // hard-coded core list — `generateComponentsPipeline` returns a descriptive
  // error when the target lexicon has no generator.
  const result = await generateComponentsPipeline(
    args.path,
    lexicon,
    { env: args.env },
    args.sandbox,
  );

  if (!result.success) {
    console.error(formatError({ message: result.error ?? "Failed to generate CI pipeline from components" }));
    return 1;
  }

  const yaml = result.yaml ?? "";
  if (args.format === "json") {
    console.log(JSON.stringify({ stages: result.stages, jobs: result.jobs, yaml }, null, 2));
  } else if (args.output) {
    const outputPath = resolve(args.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, yaml);
  } else {
    console.log(yaml);
  }

  if (args.verbose || args.output) {
    console.error(
      formatSuccess(
        `Generated ${formatBold(lexicon)} pipeline: ${formatBold(String(result.jobs?.length ?? 0))} job(s) across ${formatBold(String(result.stages?.length ?? 0))} wave(s)`,
      ),
    );
  }

  return 0;
}

export async function runBuild(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;
  let { serializers } = ctx;

  // Generate mode (#563): synthesize CI YAML from components instead of
  // running a normal lexicon build. Checked first since it does not need
  // `serializers`/lexicon resources at all.
  if (args.components && args.generate) {
    return runGenerateComponents(ctx);
  }

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

  // #1064 — `--param name=value`, repeated, into a flat { name: value } record.
  const params = args.param?.length
    ? Object.fromEntries(
        args.param.map((entry) => {
          const eq = entry.indexOf("=");
          return eq === -1 ? [entry, ""] : [entry.slice(0, eq), entry.slice(eq + 1)];
        }),
      )
    : undefined;

  if (args.watch) {
    const cleanup = buildCommandWatch({
      path: args.path,
      output: args.output,
      format: buildFormat,
      serializers,
      plugins,
      fold: args.fold,
      sandbox: args.sandbox,
      params,
      paramsFile: args.paramsFile,
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
    fold: args.fold,
    sandbox: args.sandbox,
    params,
    paramsFile: args.paramsFile,
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
