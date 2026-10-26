/**
 * The change-set modules bundle small (#3181, ruling #3421).
 *
 * terragucci runs its stages in customer CI as one bundled file with no
 * TypeScript toolchain. So `@intentius/chant/change-set`, the grouped plan
 * summary at `@intentius/chant/plan-summary` (#3188) and the terraform
 * lexicon's `change-set` subpath must not reach `typescript`, esbuild, zod or
 * chant's fold, lint and codegen modules. This bundles the three entry points
 * the way terragucci would and reads esbuild's own list of what went in.
 *
 * The drift record (#4451) ships under the same rule: `@intentius/chant/
 * drift-record` and the terraform lexicon's `drift-record` subpath bundle to
 * the plan hashing code, the observation contract, the change-set graph's
 * node rule, the instance rollup, the sensitive-key list and the plan projection, and nothing
 * heavier.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { REPO } from "./workspace/__fixtures__/contract-repo";

/** What the three bundles may hold together at most. They are about 40 KB today (9 KB change-set, 21 KB plan-summary, 10 KB terraform). */
const BUDGET_BYTES = 64 * 1024;

const FORBIDDEN = [/node_modules\/typescript\//, /node_modules\/esbuild\//, /node_modules\/zod\//, /\/src\/fold\//, /\/src\/lint\//, /\/src\/codegen\//];

describe("the change-set bundle", () => {
  test("holds the document, the adapters, the summary and the digest, and nothing heavier", async () => {
    const result = await build({
      entryPoints: [
        join(REPO, "packages", "core", "src", "change-set.ts"),
        join(REPO, "packages", "core", "src", "plan-summary.ts"),
        join(REPO, "lexicons", "terraform", "src", "change-set.ts"),
      ],
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
    // The whole graph: the three entry points, the terraform plan digest, and core's digest code.
    expect(inputs.map((i) => i.replace(/^.*?(packages|lexicons)\//, "$1/")).sort()).toEqual([
      "lexicons/terraform/src/change-set.ts",
      "lexicons/terraform/src/plan-digest.ts",
      "packages/core/src/change-set.ts",
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/effect-receipt.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
      "packages/core/src/plan-summary.ts",
      // The next-release floor constant (#4480): no imports.
      "packages/core/src/release-floors.ts",
    ]);
    const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });

  test("the drift-record bundle holds the record, its adapters and the digest, and nothing heavier", async () => {
    const result = await build({
      entryPoints: [
        join(REPO, "packages", "core", "src", "drift-record.ts"),
        join(REPO, "lexicons", "terraform", "src", "drift-record.ts"),
      ],
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
    expect(inputs.map((i) => i.replace(/^.*?(packages|lexicons)\//, "$1/")).sort()).toEqual([
      "lexicons/terraform/src/drift-record.ts",
      "lexicons/terraform/src/live-plan-reasons.ts",
      "lexicons/terraform/src/plan-observation.ts",
      "packages/core/src/change-set-graph.ts",
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/drift-record.ts",
      "packages/core/src/effect-receipt.ts",
      "packages/core/src/instance-nodes.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
      "packages/core/src/observation.ts",
      "packages/core/src/pulumi-urn.ts",
      "packages/core/src/sensitive-key.ts",
    ]);
    // About 66 KB today: each entry point carries its own copy of the shared modules.
    const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
    expect(bytes).toBeLessThan(96 * 1024);
  });

  test("the pulumi lexicon's change-set and drift-record adapters (#4453) bundle the same way", async () => {
    const result = await build({
      entryPoints: [
        join(REPO, "lexicons", "pulumi", "src", "change-set.ts"),
        join(REPO, "lexicons", "pulumi", "src", "drift-record.ts"),
      ],
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
    expect(inputs.map((i) => i.replace(/^.*?(packages|lexicons)\//, "$1/")).sort()).toEqual([
      "lexicons/pulumi/src/change-set.ts",
      "lexicons/pulumi/src/drift-record.ts",
      "lexicons/pulumi/src/values.ts",
      "packages/core/src/change-set-graph.ts",
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/drift-record.ts",
      "packages/core/src/effect-receipt.ts",
      "packages/core/src/instance-nodes.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
      "packages/core/src/observation.ts",
      "packages/core/src/pulumi-urn.ts",
      "packages/core/src/sensitive-key.ts",
    ]);
  });
});
