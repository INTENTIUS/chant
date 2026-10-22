/**
 * The forge clients bundle small (#3759, ruling #3421).
 *
 * terragucci posts its plan note, its statuses and its drift issue from one
 * bundled file with no TypeScript toolchain, and SQL Yodeler posts its
 * comment and tracking issue the same way. `@intentius/chant/pr-forge` holds
 * the comment by marker, the commit status, the tracking issue with its
 * close-on-clear, and the reading of a CI job's environment, over an
 * injected `fetch`. This bundles it alone, the way a product would, and reads
 * esbuild's own list of what went in: one file, and nothing from a package.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

const FORBIDDEN = [/node_modules\//, /typescript/, /\/src\/fold\//, /\/src\/lint\//, /\/src\/codegen\//, /\/src\/workspace\//, /\/src\/op\//];

describe("the pr-forge bundle", () => {
  test("holds the forge clients and nothing else", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "pr-forge.ts")],
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
    expect(inputs.map((i) => i.replace(/^.*?packages\//, "packages/")).sort()).toEqual(["packages/core/src/pr-forge.ts"]);
    // About 37 KB today, after the pull request authors (#4000) and pullRequestOpen for target locks (#4293).
    expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(40 * 1024);
  });
});
