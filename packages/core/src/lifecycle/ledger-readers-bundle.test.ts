/**
 * The release and wave-plan readers bundle small (#3865, as #3764 did for the
 * gate audit). A product that shows a workspace member's environments or the
 * recorded wave plans bundles one file with no TypeScript toolchain, so
 * `@intentius/chant/lifecycle/release-read` and
 * `@intentius/chant/lifecycle/wave-plans` must not reach `typescript`, esbuild,
 * zod, git, or chant's fold, lint, codegen, workspace and op modules.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "../workspace/__fixtures__/contract-repo";

const BUDGET_BYTES = 16 * 1024;

const FORBIDDEN = [/node_modules\//, /\/src\/fold\//, /\/src\/lint\//, /\/src\/codegen\//, /\/src\/workspace\//, /\/lifecycle\/git\.ts$/, /\/lifecycle\/member-ledger\.ts$/, /\/lifecycle\/release-ledger\.ts$/, /\/op\//];

async function bundle(entry: string) {
  const result = await build({
    entryPoints: [join(REPO, "packages", "core", "src", "lifecycle", entry)],
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
  const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
  expect(bytes).toBeLessThan(BUDGET_BYTES);
  return inputs.map((i) => i.replace(/^.*?packages\//, "packages/")).sort();
}

describe("the ledger readers bundles", () => {
  test("the wave plans reader holds itself and nothing else", async () => {
    expect(await bundle("wave-plans.ts")).toEqual(["packages/core/src/lifecycle/wave-plans.ts"]);
  });

  test("the release reader holds itself and the legacy digest flag", async () => {
    expect(await bundle("release-read.ts")).toEqual(["packages/core/src/lifecycle/legacy-digest.ts", "packages/core/src/lifecycle/release-read.ts"]);
  });
});
