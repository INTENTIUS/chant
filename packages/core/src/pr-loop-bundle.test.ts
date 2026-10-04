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
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/effect-receipt.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
      "packages/core/src/plan-summary.ts",
      "packages/core/src/pr-forge.ts",
      "packages/core/src/pr-loop.ts",
    ]);
    expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(64 * 1024);
  });
});
