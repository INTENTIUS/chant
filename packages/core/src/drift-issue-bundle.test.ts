/**
 * The drift issue bundles small (#4790, ruling #3421).
 *
 * plywood, SQL Yodeler and terragucci keep their drift issue from a bundled
 * file beside the forge clients, so `@intentius/chant/drift-issue` imports
 * types only from the clients and the drift record. This bundles it alone,
 * the way a product would, and reads esbuild's list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

describe("the drift-issue bundle", () => {
  test("holds the drift issue and nothing else", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "drift-issue.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      outdir: "out",
      logLevel: "silent",
    });
    expect(Object.keys(result.metafile.inputs).map((i) => i.replace(/^.*?packages\//, "packages/"))).toEqual(["packages/core/src/drift-issue.ts"]);
    // About 5.5 KB today.
    expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(12 * 1024);
  });
});
