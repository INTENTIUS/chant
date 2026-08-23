/**
 * "Every shipped example builds" (chant #1067) and "every shipped example
 * passes its own lexicon's post-synth checks" (chant #1400).
 *
 * `check-lexicon.ts`'s existing example checks only count directories
 * ("At least 1 example", "At least 3 examples", "At least 5 examples with
 * tests") — nothing ever tries to build one. `lexicons/aws/examples/core-concepts`
 * shipped with a discovery-time error (two files independently exporting a
 * top-level `dataBucket`) and `chant dev check-lexicon lexicons/aws` still
 * reported "All tier-1 checks passed," because none of its 29 checks touch
 * build output. This module closes that gap directly: for every non-empty
 * `examples/<name>/src/` directory, run the same discover-and-serialize
 * pipeline `chant build` runs and report whether it produced output with no
 * structural error.
 *
 * #1067 scoped "builds" to discovery + serialization on purpose, and said
 * so here: three aws examples (lambda-api, lambda-s3, shared-alb) failed
 * WAW042/WAW054 at error severity at the time, for defects that issue never
 * set out to fix. #1400 fixed those three and added the second axis: after
 * serialization, the post-synth checks each loaded plugin ships run against
 * that plugin's own output, exactly as `chant build` runs them (scoped per
 * plugin, `lint.rules` from the example's chant.config applied), and any
 * diagnostic left at `error` severity fails the example. Warnings do not.
 * An example is what a user copies wholesale; it must not teach a pattern
 * the lexicon it demonstrates flags as an error.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { build, type BuildResult } from "../../build";
import { findInfraFiles } from "../../discovery/files";
import { detectLexicons } from "../../detectLexicon";
import { loadChantConfig } from "../../config";
import { loadPlugins } from "../plugins";
import { runPostSynthChecks, type PostSynthDiagnostic } from "../../lint/post-synth";
import { applyConfiguredSeverity } from "../../lint/config";
import type { LexiconPlugin } from "../../lexicon";
import type { SerializerResult } from "../../serializer";

export interface ExampleBuildResult {
  example: string;
  ok: boolean;
  detail?: string;
}

/**
 * Run each plugin's own post-synth checks against that plugin's output —
 * the same per-plugin scoping and `lint.rules` severity resolution
 * `cli/commands/build.ts` applies — and return what is left at `error`
 * severity. Project `lint.policies` are not run here: those are the
 * example author's organizational policy, not the lexicon's contract.
 */
export function postSynthErrors(
  plugins: LexiconPlugin[],
  result: BuildResult,
  lintRules: Parameters<typeof applyConfiguredSeverity>[1],
): PostSynthDiagnostic[] {
  const errors: PostSynthDiagnostic[] = [];
  for (const plugin of plugins) {
    if (!plugin.postSynthChecks) continue;
    const checks = plugin.postSynthChecks();
    if (checks.length === 0) continue;

    const outputKey = plugin.serializer.name;
    const scopedOutputs = new Map<string, string | SerializerResult>();
    const pluginOutput = result.outputs.get(outputKey);
    if (pluginOutput !== undefined) scopedOutputs.set(outputKey, pluginOutput);

    const diags = runPostSynthChecks(checks, { ...result, outputs: scopedOutputs });
    const { diagnostics } = applyConfiguredSeverity(diags, lintRules);
    for (const diag of diagnostics) {
      if (diag.severity === "error") errors.push(diag);
    }
  }
  return errors;
}

function formatPostSynthError(diag: PostSynthDiagnostic): string {
  const prefix = diag.entity ? `[${diag.entity}] ` : "";
  return `${diag.checkId}: ${prefix}${diag.message}`;
}

/**
 * Build every non-empty example under `<lexiconDir>/examples/*\/src` and
 * report per-example pass/fail. Returns `[]` when the lexicon has no
 * `examples/` directory at all (a separate tier-1 check already covers
 * that).
 */
export async function checkExamplesBuild(lexiconDir: string): Promise<ExampleBuildResult[]> {
  const examplesDir = join(lexiconDir, "examples");
  if (!existsSync(examplesDir)) return [];

  const results: ExampleBuildResult[] = [];
  const entries = readdirSync(examplesDir, { withFileTypes: true }).filter((e) => e.isDirectory());

  for (const entry of entries) {
    const srcDir = join(examplesDir, entry.name, "src");
    if (!existsSync(srcDir)) continue;

    const contents = readdirSync(srcDir);
    if (contents.length === 0 || (contents.length === 1 && contents[0] === ".gitkeep")) continue;

    try {
      const files = await findInfraFiles(srcDir);
      if (files.length === 0) continue;

      // An example's own chant.config.{ts,json} (living beside src/, not in
      // it) can declare `lexicons` explicitly — the same precedence real
      // `chant build` gives it via resolveProjectLexicons() in ../plugins.ts.
      // Needed for examples like helm's HelmRender ones, whose composite
      // legitimately produces entities tagged with a lexicon (e.g. "k8s")
      // that no source-file import mentions — detection from imports alone
      // can never see it, so the example built with only its "own" lexicon's
      // plugin and silently dropped every entity of the other, undetectable
      // one. Detection from source-file imports (unchanged) remains the
      // fallback for the many examples with no declared `lexicons` list.
      const { config: exampleConfig } = await loadChantConfig(join(examplesDir, entry.name));
      const lexiconNames =
        exampleConfig.lexicons && exampleConfig.lexicons.length > 0
          ? exampleConfig.lexicons
          : await detectLexicons(files);
      if (lexiconNames.length === 0) {
        results.push({
          example: entry.name,
          ok: false,
          detail: "no lexicon imports detected in src/ — cannot determine which plugin(s) to build with",
        });
        continue;
      }

      const plugins = await loadPlugins(lexiconNames);
      const result = await build(srcDir, plugins.map((p) => p.serializer));

      const structuralErrors = result.errors.map((e) => e.message);
      const producedOutput = result.outputs.size > 0;
      const structurallyOk = structuralErrors.length === 0 && producedOutput;

      // #1400 — only once the build is structurally sound. A discovery error
      // already explains the failure, and partial output is not the output
      // the checks are meant to see.
      const postSynth = structurallyOk
        ? postSynthErrors(plugins, result, exampleConfig.lint?.rules)
        : [];
      const ok = structurallyOk && postSynth.length === 0;

      results.push({
        example: entry.name,
        ok,
        detail: ok
          ? undefined
          : structuralErrors.length > 0
            ? structuralErrors.join("; ")
            : !producedOutput
              ? "discovered source but produced no output"
              : `post-synth error(s) from the lexicon's own checks: ${postSynth.map(formatPostSynthError).join("; ")}`,
      });
    } catch (err) {
      results.push({
        example: entry.name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
