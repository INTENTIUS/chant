/**
 * The gate audit reader bundles small (#3764, ruling #3421).
 *
 * terragucci and SQL Yodeler derive their audit trail from the gate ledger in
 * one bundled file, with no TypeScript toolchain. So `@intentius/chant/lifecycle/gate-audit`
 * must not reach `typescript`, esbuild, zod, git, or chant's fold, lint and
 * codegen modules. This bundles it the way a product would and reads
 * esbuild's own list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "../workspace/__fixtures__/contract-repo";

const BUDGET_BYTES = 32 * 1024;

const FORBIDDEN = [/node_modules\//, /\/src\/fold\//, /\/src\/lint\//, /\/src\/codegen\//, /\/src\/workspace\//, /\/lifecycle\/git\.ts$/, /\/lifecycle\/gate-ledger\.ts$/, /\/op\//];

describe("the gate audit bundle", () => {
  test("holds the reader, the digest comparison and nothing heavier", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "lifecycle", "gate-audit.ts")],
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
      "packages/core/src/lifecycle/gate-audit.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
    ]);
    const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });
});
