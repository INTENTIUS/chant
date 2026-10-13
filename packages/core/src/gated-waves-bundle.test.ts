/**
 * The gated-wave primitives bundle small (#3049, ruling #3421).
 *
 * terragucci runs a wave per CI job from one bundled file with no TypeScript
 * toolchain. It calls wave planning, the set digest and the gate names from
 * `@intentius/chant/gated-waves`, and decides a wave's gate with
 * `evaluateGate` from `@intentius/chant/op/gate` against the
 * `chant/lifecycle` ledger. This bundles both the way terragucci would and
 * reads esbuild's own list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

const HEAVY = [/node_modules\/typescript\//, /node_modules\/esbuild\//, /\/src\/fold\//, /\/src\/lint\//, /\/src\/codegen\//];

async function inputsOf(entry: string): Promise<{ inputs: string[]; bytes: number }> {
  const result = await build({
    entryPoints: [join(REPO, "packages", "core", "src", entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    outdir: "out",
    logLevel: "silent",
  });
  return {
    inputs: Object.keys(result.metafile.inputs),
    bytes: result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0),
  };
}

describe("the gated-wave bundle", () => {
  test("wave planning, the set digest and the records hold the change-set digest code and nothing heavier", async () => {
    const { inputs, bytes } = await inputsOf("gated-waves.ts");
    for (const pattern of [...HEAVY, /node_modules\/zod\//]) {
      expect(inputs.filter((i) => pattern.test(i)), String(pattern)).toEqual([]);
    }
    expect(inputs.map((i) => i.replace(/^.*?packages\//, "packages/")).sort()).toEqual([
      "packages/core/src/change-set.ts",
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/effect-receipt.ts",
      "packages/core/src/gated-waves.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
    ]);
    expect(bytes).toBeLessThan(24 * 1024);
  });

  test("the gate decision reaches no TypeScript, esbuild, fold, lint or codegen module", async () => {
    // It does reach zod, through the workspace identity rules a gate reads
    // (#3163). That is weight, not a toolchain, and #3421 forbids the toolchain.
    const { inputs } = await inputsOf("op/gate.ts");
    for (const pattern of HEAVY) {
      expect(inputs.filter((i) => pattern.test(i)), String(pattern)).toEqual([]);
    }
  });
});
