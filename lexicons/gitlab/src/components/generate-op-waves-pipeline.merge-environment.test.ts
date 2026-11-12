/**
 * #5037: on GitLab the job after a before-merge pipeline's last wave runs
 * in the environment a merge token's CI/CD variable is scoped to, as
 * terragucci's `pr-merge` runs in `terragucci-merge`, with `action:
 * access`, so it deploys nothing.
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
  waves: [{ name: "wave-1", runs: [{ target: "network" }] }],
} as unknown as OpWavesSpec;

const jobs = (environment?: string) =>
  parseYAML(generateGitlabOpWavesPipeline(spec, { specFile: "w.json", jobNames: (j) => (j.role === "before-merge-done" ? "pr-merge" : undefined), beforeMerge: { merge: "auto", mergeTokenSecret: "MERGE_TOKEN", ...(environment !== undefined ? { environment } : {}) } }).files[0]!.yaml) as Record<string, { environment?: unknown; variables?: Record<string, string> }>;

describe("the merge job's environment on GitLab (#5037)", () => {
  test("pr-merge runs in it with action access, beside the merge token's variable", () => {
    const named = jobs("terragucci-merge");
    expect(named["pr-merge"]!.environment).toEqual({ name: "terragucci-merge", action: "access" });
    expect(named["pr-merge"]!.variables).toMatchObject({ CHANT_MERGE_TOKEN: "$MERGE_TOKEN" });
    for (const [name, job] of Object.entries(named)) if (name !== "pr-merge" && typeof job === "object" && !Array.isArray(job)) expect(job.environment, name).toBeUndefined();
    expect(jobs()["pr-merge"]!.environment).toBeUndefined();
  });
});
