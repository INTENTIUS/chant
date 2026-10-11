/**
 * The notify modules bundle small (#3761, ruling #3421).
 *
 * terragucci runs its stages in customer CI as one bundled file with no
 * TypeScript toolchain, and a webhook receiver imports the verifier alone.
 * So `@intentius/chant/notify` must reach nothing but `node:crypto` and the
 * verifier, and `@intentius/chant/notify-verify` nothing but `node:crypto`.
 * This bundles both the way a product and a receiver would and reads
 * esbuild's own list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

async function bundle(entry: string): Promise<{ inputs: string[]; bytes: number; imports: string[] }> {
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
  const imports = Object.values(result.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path));
  return {
    inputs: Object.keys(result.metafile.inputs).map((i) => i.replace(/^.*?packages\//, "packages/")).sort(),
    bytes: result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0),
    imports: [...new Set(imports)].sort(),
  };
}

describe("the notify bundle", () => {
  test("the sender holds itself and the verifier, and imports only node:crypto", async () => {
    const { inputs, bytes, imports } = await bundle("notify.ts");
    expect(inputs).toEqual(["packages/core/src/notify-verify.ts", "packages/core/src/notify.ts"]);
    expect(imports).toEqual(["node:crypto"]);
    expect(bytes).toBeLessThan(16 * 1024);
  });

  test("the verifier holds itself alone, and imports only node:crypto", async () => {
    const { inputs, bytes, imports } = await bundle("notify-verify.ts");
    expect(inputs).toEqual(["packages/core/src/notify-verify.ts"]);
    expect(imports).toEqual(["node:crypto"]);
    expect(bytes).toBeLessThan(4 * 1024);
  });
});
