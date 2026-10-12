/**
 * The gate decision bundles small (#3763, ruling #3421).
 *
 * terragucci decides its wave gates from one bundled file with no TypeScript
 * toolchain, and checked sealed approvals with its own copy of chant's seal
 * rule because `@intentius/chant/op/gate` pulls in zod and the git ledger
 * code. `@intentius/chant/gate-decision` holds the decision for a plan digest
 * under `ledger`, `pr-review` and `sealed`, and the seal check over
 * node:crypto. This bundles it the way terragucci would and reads esbuild's
 * own list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

const FORBIDDEN = [/node_modules\//, /\/src\/fold\//, /\/src\/lint\//, /\/src\/codegen\//, /\/src\/lifecycle\/git\.ts$/, /\/src\/lifecycle\/gate-ledger\.ts$/];

describe("the gate-decision bundle", () => {
  test("holds the decision, the seal check and the plan digest, and no package or git code", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "gate-decision.ts")],
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
      "packages/core/src/gate-decision.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/gate-applied.ts",
      "packages/core/src/lifecycle/gate-ledger-select.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
      "packages/core/src/notify-verify.ts",
      "packages/core/src/notify.ts",
      "packages/core/src/op/gate-point.ts",
      "packages/core/src/op/op-waves.ts",
      "packages/core/src/workspace/jsonc.ts",
      "packages/core/src/workspace/trust/gate-seal.ts",
      "packages/core/src/workspace/trust/trust-files.ts",
    ]);
    // About 27 KB today.
    const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
    expect(bytes).toBeLessThan(40 * 1024);
  });
});
