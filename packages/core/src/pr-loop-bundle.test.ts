/**
 * The pull-request loop's report, note and forge clients bundle small
 * (#3183, ruling #3421).
 *
 * terragucci's plan stage reads the report and renders the note, and talks
 * to the forge, from one bundled file with no TypeScript toolchain. This
 * bundles `pr-loop.ts` and `pr-forge.ts` the way terragucci would and reads
 * esbuild's own list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

const FORBIDDEN = [/node_modules\//, /\/src\/fold\//, /\/src\/lint\//, /\/src\/codegen\//, /\/src\/workspace\//];

describe("the pull-request loop bundle", () => {
  test("holds the report, the note, the grouped summary and the forge clients, and nothing heavier", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "pr-loop.ts"), join(REPO, "packages", "core", "src", "pr-forge.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      outdir: "out",
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    for (const pattern of FORBIDDEN) {
      expect(inputs.filter((i) => pattern.test(i)), String(pattern)).toEqual([]);
    }
    expect(inputs.map((i) => i.replace(/^.*?packages\//, "packages/")).sort()).toEqual([
      // The product's words (#4550): no imports.
      "packages/core/src/ci-product-words.ts",
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/effect-receipt.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
      "packages/core/src/plan-summary.ts",
      "packages/core/src/pr-forge.ts",
      "packages/core/src/pr-loop.ts",
      "packages/core/src/pr-migrations.ts",
      // The Pulumi URN rule (#4548, the may-appear rows): no imports.
      "packages/core/src/pulumi-urn.ts",
      // The next-release floor constant (#4480): no imports.
    ]);
    // About 89 KB today, after the hooks line (#4288), the blocked set (#4291), the scheduled-run reads (#4289) the requires checks (#4301) and the migration notes (#4407), about 97 KB; with the group lines (#4446), about 100 KB.
    // 110 KB is the ruled ceiling (#4481, ruling 12, 2026-10-25), not a figure to lower by trimming note text.
    expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(110 * 1024);
  });
});
