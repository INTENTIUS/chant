/**
 * The gate-point decision bundles small (#3816).
 *
 * terragucci's wave gate asks a decision point, and terragucci ships as one
 * bundled file with no TypeScript compiler, chant CLI, lint or codegen code
 * in it. `@intentius/chant/op/gate-point-run` reached all of those through
 * the workspace asker and the decide activity. `@intentius/chant/point-decision`
 * holds the decision with the asker and the ledger port injected. This
 * bundles it the way terragucci would and reads esbuild's own list of what
 * went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

const FORBIDDEN = [
  /node_modules\//,
  /\/src\/cli\//,
  /\/src\/workspace\//,
  /\/src\/fold\//,
  /\/src\/lint\//,
  /\/src\/codegen\//,
  /\/src\/op\/activities\//,
  /\/src\/lifecycle\/git\.ts$/,
  /\/src\/lifecycle\/gate-ledger\.ts$/,
];

describe("the point-decision bundle", () => {
  test("holds the gate-point decision and its pure helpers, and no workspace, CLI, package or git code", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "point-decision.ts")],
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
    // The plan digest is the one chant computes, which brings its canonical JSON with it, as in gate-decision.
    expect(inputs.map((i) => i.replace(/^.*?packages\//, "packages/")).sort()).toEqual([
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/effect-receipt.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/gate-ledger-select.ts",
      "packages/core/src/lifecycle/gate-pending.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
      "packages/core/src/op/duration.ts",
      "packages/core/src/op/gate-point.ts",
      "packages/core/src/point-decision.ts",
    ]);
    const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
    expect(bytes).toBeLessThan(24 * 1024);
  });
});
