/**
 * The resume plan bundles small (#3858).
 *
 * A product that resumes in its own job, such as terragucci's, decides what
 * to resume with `@intentius/chant/op/gate-resume-plan` and ships as one
 * bundled file. This bundles it the way such a product would and reads
 * esbuild's own list of what went in: no git ledger, no gate evaluation, no
 * workspace, CLI or Ajv code.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "../workspace/__fixtures__/contract-repo";

const FORBIDDEN = [
  /node_modules\//,
  /\/src\/cli\//,
  /\/src\/workspace\//,
  /\/src\/fold\//,
  /\/src\/lint\//,
  /\/src\/codegen\//,
  /\/src\/op\/activities\//,
  /\/src\/op\/gate\.ts$/,
  /\/src\/op\/gate-resume\.ts$/,
  /\/src\/lifecycle\/git\.ts$/,
  /\/src\/lifecycle\/gate-ledger\.ts$/,
];

describe("the gate-resume-plan bundle", () => {
  test("holds the resume decision and its pure helpers only", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "op", "gate-resume-plan.ts")],
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
    expect(bytes).toBeLessThan(32 * 1024);
  });
});
