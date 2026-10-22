/**
 * The blocked-member rules bundle on their own (#4291): terragucci calls them
 * from its CI stages as one bundled file with no TypeScript toolchain, as it
 * calls `./gated-waves` (#3421).
 */

import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

test("wave-blocked bundles with nothing but itself", async () => {
  const result = await build({
    entryPoints: [join(REPO, "packages", "core", "src", "wave-blocked.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    outdir: "out",
    logLevel: "silent",
  });
  expect(Object.keys(result.metafile.inputs).map((i) => i.replace(/^.*?packages\//, "packages/"))).toEqual(["packages/core/src/wave-blocked.ts"]);
  expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(12 * 1024);
});
