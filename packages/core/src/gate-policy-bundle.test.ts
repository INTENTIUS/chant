/**
 * The gate policy bundles alone (#4294), as the override gate does: a
 * product runs the engine and reads its answer from one bundled file with
 * no TypeScript toolchain. This bundles `@intentius/chant/gate-policy` and
 * reads esbuild's list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

describe("the gate-policy bundle", () => {
  test("holds the policy module and nothing else", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "gate-policy.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      outdir: "out",
      logLevel: "silent",
    });
    expect(Object.keys(result.metafile.inputs).map((i) => i.replace(/^.*?packages\//, "packages/"))).toEqual(["packages/core/src/gate-policy.ts"]);
    expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(16 * 1024);
  });
});
