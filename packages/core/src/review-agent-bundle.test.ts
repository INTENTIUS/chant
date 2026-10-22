/**
 * The review agent bundles alone (#4299): a product such as terragucci
 * imports `@intentius/chant/op/activities/review-agent` into one bundled
 * file, so it must not reach predict-behaviour's estate code. This bundles
 * the module and reads esbuild's list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

describe("the review-agent bundle", () => {
  test("holds the review agent, the note it posts through and nothing else", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "op", "activities", "review-agent.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      outdir: "out",
      logLevel: "silent",
    });
    expect(Object.keys(result.metafile.inputs).map((i) => i.replace(/^.*?packages\//, "packages/")).sort()).toEqual([
      "packages/core/src/op/activities/forge-pull-request.ts",
      "packages/core/src/op/activities/gh-host.ts",
      "packages/core/src/op/activities/pr-refs.ts",
      "packages/core/src/op/activities/reconcile.ts",
      "packages/core/src/op/activities/review-agent.ts",
      "packages/core/src/pr-forge.ts",
    ]);
    expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(96 * 1024);
  });
});
