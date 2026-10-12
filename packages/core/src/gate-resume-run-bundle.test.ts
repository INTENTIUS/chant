/**
 * The gate resume bundles small (#3854).
 *
 * terragucci ships one bundled file, and importing `resumeGateRun` from
 * `@intentius/chant/op/gate-resume` brought Ajv along, through `./op/gate`
 * and the workspace's identity rules. `@intentius/chant/gate-resume-run` holds
 * the forge calls, the token lookup and the run locator alone. This bundles it
 * the way terragucci would and reads esbuild's own list of what went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

const FORBIDDEN = [/node_modules\//, /\/src\/workspace\//, /\/src\/lifecycle\//, /\/src\/cli\//, /\/src\/op\/gate\.ts$/];

describe("the gate-resume-run bundle", () => {
  test("holds the forge calls and the locator, and no package, workspace, ledger or git code", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "gate-resume-run.ts")],
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
    expect(inputs.map((i) => i.replace(/^.*?packages\//, "packages/")).sort()).toEqual([
      "packages/core/src/gate-resume-run.ts",
      "packages/core/src/op/gate-run-locator.ts",
      "packages/core/src/pr-forge.ts",
    ]);
    const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
    expect(bytes).toBeLessThan(40 * 1024);
  });

  test("@intentius/chant/op/gate-resume still exports what it did", async () => {
    const mod = await import("./op/gate-resume");
    for (const name of ["resumeGateRun", "resumeTokenFromEnv", "resolutionAnswering", "isGateRunLocator", "resolveGateRunLocator"]) {
      expect(typeof (mod as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
