/**
 * #5034: the resume workflow keeps a product's file and job names, as
 * terragucci's `terragucci-resume.yml` and its job `resume`. Without the
 * options the files render as before (the `op-waves-defaults-*` goldens).
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  apply: ["terragucci", "apply", "{target}"],
  plan: ["terragucci", "plan", "{target}", "{plan}"],
  resume: { schedule: "*/10 * * * *" },
  waves: [{ name: "wave-1", runs: [{ target: "network" }] }],
} as unknown as OpWavesSpec;

const names = { workflowFile: "terragucci.yml", resumeWorkflowFile: "terragucci-resume.yml", jobNames: (j: { role: string; wave?: number }) => (j.role === "resume" ? "resume" : j.role === "wave" ? `apply-wave-${j.wave}` : undefined) };
const jobsOf = (yaml: string) => Object.keys((parseYAML(yaml) as { jobs: Record<string, unknown> }).jobs);

describe("the resume workflow's names on GitHub (#5034)", () => {
  test("the product's file, beside its waves' file", () => {
    const files = generateGithubOpWavesPipeline(spec, { specFile: "w.json", ...names }).files;
    expect(files.map((f) => f.name)).toEqual(["terragucci.yml", "terragucci-resume.yml"]);
    expect(jobsOf(files[1]!.yaml)).toEqual(["resume"]);
    expect(generateGithubOpWavesPipeline(spec, { specFile: "w.json" }).files.map((f) => f.name)).toEqual(["tf-apply.yml", "tf-apply-resume.yml"]);
  });

  test("a job name of the product's for the resume job, and refusals", () => {
    const files = generateGithubOpWavesPipeline(spec, { specFile: "w.json", jobNames: (j) => (j.role === "resume" ? "tg-resume" : undefined) }).files;
    expect(jobsOf(files[1]!.yaml)).toEqual(["tg-resume"]);
    expect(() => generateGithubOpWavesPipeline(spec, { specFile: "w.json", resumeWorkflowFile: "../x.yml" })).toThrow(/is a workflow file's name/);
    expect(() => generateGithubOpWavesPipeline(spec, { specFile: "w.json", workflowFile: "terragucci.yml", resumeWorkflowFile: "terragucci.yml" })).toThrow(/the waves' own workflow/);
  });
});
