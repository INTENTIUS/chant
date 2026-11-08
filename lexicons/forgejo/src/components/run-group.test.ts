/**
 * The workflow-level run group a product asks for (#4771): Forgejo cancels
 * the run in progress when a push starts another run of a workflow with no
 * workflow-level `concurrency:`, so the generators write one on request, and
 * nothing without it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGithubPipeline } from "@intentius/chant-lexicon-github/components/generate-pipeline";
import { generateForgejoPipeline } from "./generate-pipeline";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] },
];

const SPEC: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never" },
    { name: "prod", runs: [{ target: "prod" }], approval: "pr-review" },
  ],
  resume: { schedule: "*/10 * * * *" },
};

describe("the pull request workflow's run group", () => {
  test("pull-request: a pull request's runs share a group and cancel each other, other runs never", () => {
    const { yaml } = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true }, runGroup: "pull-request" });
    const doc = parseYAML(yaml) as { name: string; concurrency: Record<string, unknown> };
    expect(doc.concurrency).toEqual({
      group: `${doc.name}-\${{ github.event_name == 'pull_request' && github.ref || github.run_id }}`,
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
    // Before jobs:, after the workflow's own keys.
    expect(yaml.indexOf("\nconcurrency:\n")).toBeLessThan(yaml.indexOf("\njobs:\n"));
  });

  test("without runGroup the file is the golden, byte for byte", () => {
    const { yaml } = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true } });
    expect(yaml).toBe(readFileSync(join(import.meta.dirname, "__fixtures__", "pr-loop.forgejo.golden.yml"), "utf-8"));
    expect(yaml).not.toMatch(/^concurrency:/m);
  });

  test("GitHub writes no group, since it cancels nothing without one", () => {
    const options = { env: "prod", prLoop: { applyOnMerge: true } };
    expect(generateGithubPipeline(ESTATE, { ...options, runGroup: "pull-request" } as never).yaml).toBe(generateGithubPipeline(ESTATE, options).yaml);
  });
});

describe("the op waves workflows' run group", () => {
  test("commit: the waves workflow gets one group per event and commit, never cancelled", () => {
    const { files } = generateForgejoOpWavesPipeline(SPEC, { specFile: "waves.json", runGroup: "commit" });
    expect(files.map((f) => f.name)).toEqual(["migrations.yml", "migrations-resume.yml", "migrations-plans.yml"]);
    const doc = parseYAML(files[0]!.yaml) as { concurrency: Record<string, unknown> };
    expect(doc.concurrency).toEqual({ group: "migrations-${{ github.event_name }}-${{ github.sha }}", "cancel-in-progress": false });
  });

  test("a workflow with a group of its own keeps it: the resume and plans workflows are as before", () => {
    const grouped = generateForgejoOpWavesPipeline(SPEC, { specFile: "waves.json", runGroup: "commit" }).files;
    const plain = generateForgejoOpWavesPipeline(SPEC, { specFile: "waves.json" }).files;
    expect(grouped.slice(1).map((f) => f.yaml)).toEqual(plain.slice(1).map((f) => f.yaml));
    for (const file of plain.slice(1)) expect(file.yaml, file.name).toMatch(/^concurrency:/m);
  });

  test("without runGroup the waves workflow has no group", () => {
    const { files } = generateForgejoOpWavesPipeline(SPEC, { specFile: "waves.json" });
    expect(files[0]!.yaml).not.toMatch(/^concurrency:/m);
  });
});
