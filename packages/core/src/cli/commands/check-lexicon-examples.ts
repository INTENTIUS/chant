/**
 * "Every shipped example builds" (chant #1067).
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
 * Scope, deliberately: "builds" here means discovery + serialization
 * succeed (no `DiscoveryError`/`BuildError`, real output produced) — the
 * same thing a `Duplicate export name` failure blocks. It does not
 * additionally require the output to pass every post-synth/lint check
 * (WAW0xx and friends). Those are a separate, already-gated contract
 * (`chant lint`, the post-synth pipeline) with their own severity model and
 * their own CI step; several existing AWS examples (docs-snippets,
 * lambda-api, lambda-s3, shared-alb) currently fail one or more post-synth
 * checks for reasons unrelated to this issue (e.g. WAW042, a TLS-only
 * bucket policy check added after those examples were written). Folding
 * that axis into "does it build" would fail this new check for all of them
 * on its very first run, for defects this issue never set out to fix.
 * Tracked separately; not silently absorbed here.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { build } from "../../build";
import { findInfraFiles } from "../../discovery/files";
import { detectLexicons } from "../../detectLexicon";
import { loadPlugins } from "../plugins";

export interface ExampleBuildResult {
  example: string;
  ok: boolean;
  detail?: string;
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

      const lexiconNames = await detectLexicons(files);
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
      const ok = structuralErrors.length === 0 && producedOutput;

      results.push({
        example: entry.name,
        ok,
        detail: ok
          ? undefined
          : structuralErrors.length > 0
            ? structuralErrors.join("; ")
            : "discovered source but produced no output",
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
