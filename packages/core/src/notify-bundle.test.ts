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

import { spawnSync } from "node:child_process";
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
    // 17 KiB since ci.stale (#4678): the ci. events' names and headlines took it to 16.0 KiB, and the cap
    // is there to catch a dependency pulled in, which would add far more than an event name.
    expect(bytes).toBeLessThan(17 * 1024);
  });

  test("the verifier holds itself alone, and imports only node:crypto", async () => {
    const { inputs, bytes, imports } = await bundle("notify-verify.ts");
    expect(inputs).toEqual(["packages/core/src/notify-verify.ts"]);
    expect(imports).toEqual(["node:crypto"]);
    expect(bytes).toBeLessThan(4 * 1024);
  });
});

describe("the compiled notify entries inside this repository (#3803)", () => {
  // `./notify` and `./notify-verify` resolve their `import` condition to
  // dist/*.js so plain Node can load an installed package. A checkout has no
  // dist JS (the package build keeps it only for `npm pack`), so a lexicon or
  // package here that imports either entry fails to load under `chant build`.
  // The github lexicon's wave pipeline did, and the release suites' delivery
  // project could not build. Source here imports from `src` paths instead.
  test("no source outside packages/core imports @intentius/chant/notify or notify-verify", () => {
    const found = spawnSync(
      "git",
      ["grep", "-l", "-E", "from [\"']@intentius/chant/notify(-verify)?[\"']", "--", "*.ts", "*.mts", "*.mjs", ":!packages/core/**"],
      { cwd: REPO, encoding: "utf-8" },
    );
    // git grep exits 1 when nothing matches.
    expect(found.status, found.stderr).toBe(1);
    expect(found.stdout).toBe("");
  });
});
