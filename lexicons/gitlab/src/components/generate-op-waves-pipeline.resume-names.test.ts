/**
 * #5034: on GitLab the resume job takes a product's name through
 * `jobNames` (role `resume`), as terragucci's `resume`; a resume workflow
 * file is GitHub's and Forgejo's.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  apply: ["terragucci", "apply", "{target}"],
  plan: ["terragucci", "plan", "{target}", "{plan}"],
  resume: { schedule: "*/10 * * * *" },
  waves: [{ name: "wave-1", runs: [{ target: "network" }] }],
} as unknown as OpWavesSpec;

describe("the resume job's name on GitLab (#5034)", () => {
  test("the product's name, in the resume stage; chant's without it; the workflow file refused", () => {
    const yaml = generateGitlabOpWavesPipeline(spec, { specFile: "w.json", jobNames: (j) => (j.role === "resume" ? "resume" : undefined) }).files[0]!.yaml;
    const doc = parseYAML(yaml) as Record<string, { stage?: string }>;
    expect(doc.resume?.stage).toBe("resume");
    expect(doc["tf-apply-resume"]).toBeUndefined();
    expect(yaml).toContain("# The resume job retries it for you");
    expect(parseYAML(generateGitlabOpWavesPipeline(spec, { specFile: "w.json" }).files[0]!.yaml)).toHaveProperty("tf-apply-resume");
    expect(() => generateGitlabOpWavesPipeline(spec, { specFile: "w.json", resumeWorkflowFile: "x.yml" })).toThrow(/resumeWorkflowFile names a GitHub or Forgejo workflow/);
    expect(() => generateGitlabOpWavesPipeline(spec, { specFile: "w.json", jobNames: (j) => (j.role === "resume" ? "wave-1-wave-1" : undefined) })).toThrow(/names two jobs/);
  });
});
