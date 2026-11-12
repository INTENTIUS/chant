/**
 * #5034: on Forgejo the resume workflow keeps a product's file and job
 * names, as on GitHub.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  apply: ["terragucci", "apply", "{target}"],
  plan: ["terragucci", "plan", "{target}", "{plan}"],
  resume: { schedule: "*/10 * * * *" },
  waves: [{ name: "wave-1", runs: [{ target: "network" }] }],
} as unknown as OpWavesSpec;

describe("the resume workflow's names on Forgejo (#5034)", () => {
  test("the product's file and job", () => {
    const files = generateForgejoOpWavesPipeline(spec, { specFile: "w.json", workflowFile: "terragucci.yml", resumeWorkflowFile: "terragucci-resume.yml", jobNames: (j) => (j.role === "resume" ? "resume" : undefined) }).files;
    expect(files.map((f) => f.name)).toEqual(["terragucci.yml", "terragucci-resume.yml"]);
    expect(Object.keys((parseYAML(files[1]!.yaml) as { jobs: Record<string, unknown> }).jobs)).toEqual(["resume"]);
    expect(generateForgejoOpWavesPipeline(spec, { specFile: "w.json" }).files.map((f) => f.name)).toEqual(["tf-apply.yml", "tf-apply-resume.yml"]);
    expect(() => generateForgejoOpWavesPipeline(spec, { specFile: "w.json", resumeWorkflowFile: "tf-apply.yml" })).toThrow(/the waves' own workflow/);
  });
});
