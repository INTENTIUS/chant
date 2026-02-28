import { describe, test, expect } from "bun:test";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { resolve } from "path";
import { readdirSync, statSync } from "fs";
import type { Serializer } from "@intentius/chant/serializer";

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
  /** Directory containing example subdirectories (typically import.meta.dir) */
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
 * Modeled on Flyway's describeExample pattern but generalized for any lexicon.
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
        const result = await build(srcDir, serializers);

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
