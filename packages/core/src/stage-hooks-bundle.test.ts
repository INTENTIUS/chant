/**
 * The stage-hook runner bundles alone (#4288): a product that runs
 * `ci.hooks` around its own stages imports
 * `@intentius/chant/op/stage-hooks` into one bundled file, without the wave
 * loop, the gate or the ledger. This bundles the module and reads esbuild's
 * list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

describe("the stage-hooks bundle", () => {
  test("holds the hook runner and the Op waves spec, and no wave loop, gate or ledger", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "op", "stage-hooks.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      outdir: "out",
      logLevel: "silent",
    });
    expect(Object.keys(result.metafile.inputs).map((i) => i.replace(/^.*?packages\//, "packages/")).sort()).toEqual([
      // The product's words (#4550): gate and status names, no imports.
      "packages/core/src/ci-product-words.ts",
      // The control repo's settings check (#4568, #4617), which the spec checks.
      "packages/core/src/control/dispatch.ts",
      "packages/core/src/lifecycle/gate-seal.ts",
      "packages/core/src/notify-verify.ts",
      "packages/core/src/notify.ts",
      "packages/core/src/op/gate-point.ts",
      "packages/core/src/op/gate-quorum.ts",
      "packages/core/src/op/op-waves-capability-spec.ts",
      "packages/core/src/op/op-waves-release.ts",
      "packages/core/src/op/op-waves.ts",
      "packages/core/src/op/stage-hooks.ts",
      "packages/core/src/wave-blocked.ts",
      "packages/core/src/wave-layout.ts",
    ]);
    expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(48 * 1024);
  });
});
