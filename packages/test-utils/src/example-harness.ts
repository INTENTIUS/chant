import { describe, test, expect } from "vitest";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { loadChantConfigUpward, resolveOwnershipMarker } from "@intentius/chant/config";
import { resolveBuildParams } from "@intentius/chant/build-params";
import { resolve } from "path";
import { readdirSync, statSync } from "fs";
import type { Serializer } from "@intentius/chant/serializer";
import type { BuildParamProvenance } from "@intentius/chant/provenance";
import type { OwnershipMarker } from "@intentius/chant/ownership";

/**
 * What `chant build` resolves from `chant.config.ts` before it calls `build()`,
 * resolved the same way here.
 *
 * `build()` takes both of these as already-resolved options and reads no
 * config itself — that lives in the CLI layer (`cli/commands/build.ts`,
 * `cli/build-params-cli.ts`). A harness that calls `build()` directly has to
 * reproduce the step, exactly as the differential corpus already reproduces
 * the plugin, intrinsic and lexicon wiring. Both omissions are silent:
 *
 * - Without `buildParams`, a source file reading `params.<name>` gets
 *   `undefined`, so assertions see `undefined.svc.id.goog`. The fold path also
 *   declines to substitute a `params` import at all (fold-import.ts gates that
 *   on the build supplying parameters), so the files a migration off
 *   `process.env` was meant to make foldable drop back to the run path.
 * - Without `ownership`, no resource carries the stack marker, so a test
 *   cannot assert the one thing that makes an owned-only prune possible —
 *   and it would read as the project having no `ownership.stack` at all.
 *
 * A resolution error throws. `build()` does no declaration validation either,
 * so returning the empty provenance would leave the parameter reading
 * `undefined` — the exact silence this function exists to remove, one layer up.
 */
export async function declaredBuildOptions(
  srcDir: string,
): Promise<{ buildParams: BuildParamProvenance[]; ownership?: OwnershipMarker }> {
  const { config } = await loadChantConfigUpward(srcDir);
  let buildParams: BuildParamProvenance[] = [];
  if (config.buildParams) {
    const resolved = resolveBuildParams(config.buildParams, { env: process.env });
    if (resolved.errors.length > 0) {
      throw new Error(
        `${srcDir}: build parameters did not resolve —\n  ${resolved.errors.join("\n  ")}`,
      );
    }
    buildParams = resolved.provenance;
  }
  return { buildParams, ownership: resolveOwnershipMarker(config) };
}

/** Just the parameters half of {@link declaredBuildOptions}. */
export async function declaredBuildParams(srcDir: string): Promise<BuildParamProvenance[]> {
  return (await declaredBuildOptions(srcDir)).buildParams;
}

/**
 * Configuration for the example test harness.
 */
export interface ExampleHarnessConfig {
  /** Lexicon name(s) — used in describe block labels */
  lexicon: string;
  /** One or more serializers to build with */
  serializer: Serializer | Serializer[];
  /** Output key(s) in result.outputs map — must match serializer order if array */
  outputKey: string | string[];
  /** Directory containing example subdirectories (typically import.meta.dirname) */
  examplesDir: string;
}

/**
 * Per-example options that override defaults.
 */
export interface ExampleOpts {
  /** Custom assertions run on the built output(s) */
  checks?: (output: string) => void;
  /** Skip lint test for this example */
  skipLint?: boolean;
  /** Skip build test for this example */
  skipBuild?: boolean;
}

/**
 * Register a describe() block for a single example with lint + build tests.
 *
 * A describeExample harness generalized for any lexicon.
 */
export function describeExample(
  name: string,
  config: ExampleHarnessConfig,
  opts?: ExampleOpts,
): void {
  const serializers = Array.isArray(config.serializer)
    ? config.serializer
    : [config.serializer];
  const outputKeys = Array.isArray(config.outputKey)
    ? config.outputKey
    : [config.outputKey];

  // Skip entirely if both lint and build are skipped (would produce empty describe)
  if (opts?.skipLint && opts?.skipBuild) return;

  describe(`${config.lexicon} ${name} example`, () => {
    const srcDir = resolve(config.examplesDir, name, "src");

    if (!opts?.skipLint) {
      test("passes lint", async () => {
        const result = await lintCommand({
          path: srcDir,
          format: "stylish",
          fix: true,
        });

        if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
          console.log(result.output);
        }

        expect(result.success).toBe(true);
        expect(result.errorCount).toBe(0);
        expect(result.warningCount).toBe(0);
      });
    }

    if (!opts?.skipBuild) {
      test("build succeeds", async () => {
        const result = await build(srcDir, serializers, undefined, await declaredBuildOptions(srcDir));

        expect(result.errors).toHaveLength(0);

        for (const key of outputKeys) {
          const output = result.outputs.get(key);
          expect(output).toBeDefined();
        }

        if (opts?.checks) {
          // Pass the first output key's value for single-serializer convenience
          const primary = result.outputs.get(outputKeys[0]);
          opts.checks(
            typeof primary === "string" ? primary : primary!.primary,
          );
        }
      });
    }
  });
}

/**
 * Auto-discover all example subdirectories and register tests for each.
 *
 * Scans `config.examplesDir` for subdirectories containing a `src/` folder
 * and registers lint + build tests via `describeExample`.
 *
 * @param config  - Harness configuration (examplesDir is the root to scan)
 * @param overrides - Per-example option overrides keyed by directory name
 */
export function describeAllExamples(
  config: ExampleHarnessConfig,
  overrides?: Record<string, ExampleOpts>,
): void {
  const entries = readdirSync(config.examplesDir);

  for (const entry of entries) {
    const fullPath = resolve(config.examplesDir, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Only register examples that have a src/ directory
    const srcPath = resolve(fullPath, "src");
    try {
      if (!statSync(srcPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const opts = overrides?.[entry];
    describeExample(entry, config, opts);
  }
}
