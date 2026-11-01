/**
 * The override gate bundles small (#3760, ruling #3421), as the gate decision
 * does: terragucci and SQL Yodeler decide overrides from one bundled file
 * with no TypeScript toolchain. This bundles `@intentius/chant/override-gate`
 * the way they would and reads esbuild's own list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

const FORBIDDEN = [/node_modules\//, /\/src\/fold\//, /\/src\/lint\//, /\/src\/codegen\//, /\/src\/lifecycle\/git\.ts$/, /\/src\/lifecycle\/gate-ledger\.ts$/];

describe("the override-gate bundle", () => {
  test("holds the decision, the seal check and the digest, and no package or git ledger code", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "override-gate.ts")],
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
      // The product's override line (#4550): no imports.
      "packages/core/src/ci-product-words.ts",
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/effect-receipt.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/gate-ledger-select.ts",
      "packages/core/src/lifecycle/gate-seal.ts",
      // A passkey's seal (#4646), checked with node:crypto.
      "packages/core/src/lifecycle/gate-webauthn.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
      "packages/core/src/op/gate-name.ts",
      "packages/core/src/override-gate.ts",
      "packages/core/src/workspace/trust/trust-files.ts",
    ]);
    // About 16 KB today.
    const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
    expect(bytes).toBeLessThan(40 * 1024);
  });
});
