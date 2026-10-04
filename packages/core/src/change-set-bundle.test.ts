/**
 * The change-set modules bundle small (#3181, ruling #3421).
 *
 * terragucci runs its stages in customer CI as one bundled file with no
 * TypeScript toolchain. So `@intentius/chant/change-set` and the terraform
 * lexicon's `change-set` subpath must not reach `typescript`, esbuild, zod or
 * chant's fold, lint and codegen modules. This bundles both entry points the
 * way terragucci would and reads esbuild's own list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

/** What the two bundles may hold together at most. They are about 19 KB today (9 KB core, 10 KB terraform). */
const BUDGET_BYTES = 40 * 1024;

const FORBIDDEN = [/node_modules\/typescript\//, /node_modules\/esbuild\//, /node_modules\/zod\//, /\/src\/fold\//, /\/src\/lint\//, /\/src\/codegen\//];

describe("the change-set bundle", () => {
  test("holds the document, the adapters and the digest, and nothing heavier", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "change-set.ts"), join(REPO, "lexicons", "terraform", "src", "change-set.ts")],
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
    // The whole graph: the two entry points, the terraform plan digest, and core's digest code.
    expect(inputs.map((i) => i.replace(/^.*?(packages|lexicons)\//, "$1/")).sort()).toEqual([
      "lexicons/terraform/src/change-set.ts",
      "lexicons/terraform/src/plan-digest.ts",
      "packages/core/src/change-set.ts",
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/effect-receipt.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
    ]);
    const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });
});
