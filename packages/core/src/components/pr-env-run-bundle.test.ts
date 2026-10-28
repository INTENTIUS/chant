/**
 * The pull request environment runs bundle alone (#4330 follow-up): a
 * product that brings its own adapter and ports imports
 * `@intentius/chant/components/pr-env-run` into one bundled file, without the
 * gate, Ajv, js-yaml or the config loader. The ports chant uses live in
 * ./pr-env-ports.ts. This bundles the module and reads esbuild's list of what
 * went in.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "../workspace/__fixtures__/contract-repo";

describe("the pr-env-run bundle", () => {
  test("holds the runs and the records, and no gate, schema checks, YAML or config loader", async () => {
    const result = await build({
      entryPoints: [join(REPO, "packages", "core", "src", "components", "pr-env-run.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      outdir: "out",
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs).map((i) => i.replace(/^.*?packages\//, "packages/")).sort();
    expect(inputs).toEqual([
      "packages/core/src/change-set.ts",
      "packages/core/src/ci-handover.ts",
      "packages/core/src/ci-jobs.ts",
      // The product's words (#4550): gate and status names, no imports.
      "packages/core/src/ci-product-words.ts",
      "packages/core/src/components/changed-files.ts",
      "packages/core/src/components/pr-env-run.ts",
      "packages/core/src/components/pr-environment.ts",
      "packages/core/src/components/pr-pipeline.ts",
      "packages/core/src/config-environments.ts",
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/effect-receipt.ts",
      // The exit-code table (#4553): no imports.
      "packages/core/src/exit-codes.ts",
      "packages/core/src/gated-waves.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
      "packages/core/src/lifecycle/teardown.ts",
      "packages/core/src/live-endpoint.ts",
      "packages/core/src/observation.ts",
      "packages/core/src/op/activity-runtime.ts",
      "packages/core/src/op/emulator-lifecycle.ts",
      "packages/core/src/plan-summary.ts",
      "packages/core/src/pr-loop.ts",
      "packages/core/src/pr-migrations.ts",
      // The pull request's requires checks (#4607): type imports only.
      "packages/core/src/pr-requires.ts",
      // The Pulumi URN rule (#4548, the may-appear rows): no imports.
      "packages/core/src/pulumi-urn.ts",
      // The next-release floor constant (#4480): no imports.
      "packages/core/src/release-floors.ts",
    ]);
    expect(inputs.some((i) => /node_modules\/(ajv|js-yaml)\//.test(i) || i.endsWith("/op/gate.ts") || i.endsWith("/src/config.ts") || i.endsWith("/ts-loader.ts"))).toBe(false);
    expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(40 * 1024);
  });
});
