/**
 * The pin subpath bundles small (#3189, ruling #3421).
 *
 * terragucci's `tf-rollout` stage runs this code from one bundled file with
 * no TypeScript toolchain. So `@intentius/chant-lexicon-terraform/pin` must
 * not reach `typescript`, esbuild, zod, the HCL parser's wasm package, or
 * chant's fold, lint and codegen modules. The TypeScript editor for generated
 * roots (`./edit-ts.ts`) stays out of it. This bundles the entry point the way
 * terragucci would and reads esbuild's own list of what went in, the same
 * check `packages/core/src/change-set-bundle.test.ts` makes.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";

const REPO = join(new URL(".", import.meta.url).pathname, "..", "..", "..", "..");

/** About 35 KB today, unminified. */
const BUDGET_BYTES = 60 * 1024;

const FORBIDDEN = [/node_modules\/typescript\//, /node_modules\/esbuild\//, /node_modules\/zod\//, /node_modules\/@cdktn\//, /\/src\/fold\//, /\/src\/lint\//, /\/src\/codegen\//, /edit-ts\.ts$/];

describe("the pin bundle", () => {
  test("holds the edit, the wave plan and the rollout, and nothing heavier", async () => {
    const result = await build({
      entryPoints: [join(REPO, "lexicons", "terraform", "src", "pin", "index.ts")],
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
    expect(inputs.map((i) => i.replace(/^.*?(packages|lexicons)\//, "$1/")).sort()).toEqual([
      "lexicons/terraform/src/pin/edit.ts",
      "lexicons/terraform/src/pin/forge.ts",
      "lexicons/terraform/src/pin/index.ts",
      "lexicons/terraform/src/pin/rollout.ts",
      "lexicons/terraform/src/pin/scan.ts",
      "lexicons/terraform/src/pin/source.ts",
      "lexicons/terraform/src/pin/waves.ts",
      "packages/core/src/components/layers.ts",
    ]);
    const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });
});
