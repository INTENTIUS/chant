/**
 * `@intentius/chant/runner-start` bundles small (#4147): a stage that runs
 * as one bundled file checks its runner before it trades for credentials,
 * so the verifier reaches nothing but itself, the DSSE helpers and
 * `node:crypto` and `node:fs`.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

test("the runner-start verifier holds itself and the DSSE helpers, and imports only node:crypto and node:fs", async () => {
  const result = await build({
    entryPoints: [join(REPO, "packages", "core", "src", "runner-start.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    outdir: "out",
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs).map((i) => i.replace(/^.*?packages\//, "packages/")).sort();
  const imports = [...new Set(Object.values(result.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path)))].sort();
  expect(inputs).toEqual(["packages/core/src/runner-start.ts", "packages/core/src/workspace/trust/dsse.ts"]);
  expect(imports).toEqual(["node:crypto", "node:fs"]);
  expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(24 * 1024);
});
