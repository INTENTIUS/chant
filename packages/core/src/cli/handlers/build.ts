import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildCommand, buildCommandWatch, printErrors, printWarnings, resolveBuildFormat } from "../commands/build";
import { formatError, formatInfo, formatSuccess, formatBold } from "../format";
import type { CommandContext } from "../registry";
import { generateComponentsPipeline } from "../../components/cli-support";
import { loadChantConfigUpward, type ChantConfig } from "../../config";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";

/**
 * `chant build --components --generate <lexicon>` — generate mode (#563,
 * epic #551 Phase 3). Discovers `Component` declarations under `args.path`
 * and synthesizes a thin CI pipeline for `lexicon` instead of running a
 * normal lexicon build: no entity discovery, no serializers, no post-synth
 * checks — those apply to lexicon resources, which is a different input to
 * a different command path (`chant build` without `--components`).
 *
 * chant #1108 — resolves this invocation's declared build-time parameters
 * (`chant.config.ts`'s `buildParams`, against `--param`/`--params-file`/a
 * declared `env` mapping) the exact same way `chant build` does
 * (`resolveCliBuildParams`, shared with `buildCommand`), BEFORE
 * `generateComponentsPipeline` discovers/imports any `*.component.ts` file.
 * Before this, `params.*` (`@intentius/chant/params`) was always `{}` under
 * this command too — generate mode shares `discoverComponents` with `chant
 * run --components`, so it had the identical gap.
 *
 * chant #1117 — loads config by walking up from `args.path` to the project
 * root (`loadChantConfigUpward`), same as `chant build` proper, instead of
 * `args.path` alone: a components-only project built from a subdirectory
 * otherwise never sees the root `chant.config.ts`'s `buildParams` either.
 */
async function runGenerateComponents(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const lexicon = args.generate as string;

  const { config } = await loadChantConfigUpward(resolve(args.path)).catch(() => ({ config: {} as ChantConfig }));
  const paramsResolution = resolveCliBuildParams(config.buildParams, {
    cli: parseParamFlags(args.param),
    paramsFile: args.paramsFile,
  });
  if (!paramsResolution.success) {
    for (const message of paramsResolution.errors) console.error(message);
    return 1;
  }

  // Which lexicons support generate mode is a property of the loaded lexicon
  // plugins (those implementing `generateComponentPipeline`, #688), not a
  // hard-coded core list — `generateComponentsPipeline` returns a descriptive
  // error when the target lexicon has no generator.
  const result = await generateComponentsPipeline(
    args.path,
    lexicon,
    { env: args.env },
    args.sandbox,
    paramsResolution.provenance,
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
  const params = parseParamFlags(args.param);

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
