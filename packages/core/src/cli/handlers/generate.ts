import { relative, resolve, sep } from "node:path";
import { findProjectConfigPastFragments, loadChantConfig } from "../../config";
import { checkProjectCodegen, generateProjectCode } from "../../project-codegen";
import { formatError, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant generate [path] [--check] [--lexicon <name>]` — project-local code
 * generation (../../project-codegen.ts). Each configured lexicon that
 * implements the `projectCodegen` hook renders typed code from the sources
 * the project declares (`k8s.crds`, `helm.charts`) into
 * `<codegen.outDir>/<lexicon>/`.
 *
 * `--check` writes nothing and exits 1 when any lexicon's committed output no
 * longer matches its declared sources: the same check `chant build` makes,
 * for a CI step that wants to say so before building.
 *
 * Not `chant dev generate`, which regenerates a lexicon package's own types
 * from upstream specs and is for lexicon authors.
 */
export async function runGenerate(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const projectRoot = findProjectConfigPastFragments(resolve(args.path)).dir;
  let config: Record<string, unknown>;
  try {
    config = (await loadChantConfig(projectRoot)).config as unknown as Record<string, unknown>;
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }

  const plugins = ctx.plugins.filter(
    (p) => typeof p.projectCodegen === "function" && (!args.lexicon || p.name === args.lexicon),
  );
  if (args.lexicon && plugins.length === 0) {
    console.error(formatError({
      message: `lexicon "${args.lexicon}" is not configured for this project, or generates no project code`,
    }));
    return 1;
  }

  const show = (path: string): string => {
    const rel = relative(projectRoot, path);
    return rel === "" ? "." : rel.split(sep).join("/");
  };

  if (args.check) {
    let failed = 0;
    for (const plugin of plugins) {
      const check = await checkProjectCodegen(plugin, projectRoot, config).catch((err: unknown) => ({
        status: "error" as const,
        message: err instanceof Error ? err.message : String(err),
      }));
      if (check.status === "current") console.error(formatSuccess(`${plugin.name}: generated code is current`));
      if ("message" in check) {
        failed++;
        console.error(formatError({ message: `${plugin.name}: ${check.message}` }));
      }
    }
    return failed > 0 ? 1 : 0;
  }

  let written = 0;
  for (const plugin of plugins) {
    let result;
    try {
      result = await generateProjectCode(plugin, projectRoot, config);
    } catch (err) {
      console.error(formatError({ message: `${plugin.name}: ${err instanceof Error ? err.message : String(err)}` }));
      return 1;
    }
    if (!result || result.status === "none") continue;
    if (result.status === "removed") {
      console.error(formatWarning({
        message: `${plugin.name}: no sources declared, removed ${result.files.length} generated file(s) from ${show(result.outDir)}`,
      }));
      continue;
    }
    written++;
    for (const line of result.summary) console.log(`  ${plugin.name}: ${line}`);
    console.error(formatSuccess(`${plugin.name}: wrote ${result.files.length} file(s) to ${show(result.outDir)}`));
  }

  if (written === 0) {
    console.error(
      "Nothing to generate: no configured lexicon declares project sources (for example k8s.crds or helm.charts in chant.config.ts).",
    );
  }
  return 0;
}
