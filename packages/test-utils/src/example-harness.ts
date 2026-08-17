import { describe, test, expect } from "vitest";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { loadChantConfigUpward } from "@intentius/chant/config";
import { resolveBuildParams } from "@intentius/chant/build-params";
import { resolve } from "path";
import { readdirSync, statSync } from "fs";
import type { Serializer } from "@intentius/chant/serializer";
import type { BuildParamProvenance } from "@intentius/chant/provenance";

/**
 * Resolve the example project's declared `buildParams` (chant.config.ts) the
 * same way the CLI does, so a source file reading `params.<name>` sees the
 * declared defaults/env mapping rather than an empty object.
 *
 * `build()` deliberately does no declaration or validation — the CLI layer
 * owns that (see `cli/build-params-cli.ts`) — so a harness that calls
 * `build()` directly has to reproduce the step, exactly as it already
 * reproduces the plugin and intrinsic wiring. Without it, an example that
 * migrated off `process.env` onto build parameters silently builds with every
 * parameter `undefined`: the assertions see `undefined.svc.id.goog`, and the
 * fold path declines to substitute a `params` import at all (fold-import.ts
 * gates that on the build supplying parameters), so the very files the
 * migration was meant to make foldable drop back to the run path.
 *
 * A resolution error is left to the build to surface rather than thrown here.
 */
async function declaredBuildParams(srcDir: string): Promise<BuildParamProvenance[]> {
  const { config } = await loadChantConfigUpward(srcDir);
  if (!config.buildParams) return [];
  return resolveBuildParams(config.buildParams, { env: process.env }).provenance;
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
        const result = await build(srcDir, serializers, undefined, {
          buildParams: await declaredBuildParams(srcDir),
        });

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
