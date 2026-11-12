/**
 * #5037: the job after a before-merge run's last wave runs in the forge
 * environment a merge token is scoped to. Without it the job renders as
 * before (the `op-waves-defaults-*` goldens).
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { productPipelineJobs } from "@intentius/chant/components/product-pipeline";
import { buildGithubOpWavesDoc } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  apply: ["terragucci", "apply", "{target}"],
  plan: ["terragucci", "plan", "{target}", "{plan}"],
  waves: [{ name: "wave-1", runs: [{ target: "network" }] }],
} as unknown as OpWavesSpec;

type Job = { environment?: unknown };
const jobs = (environment?: string) => buildGithubOpWavesDoc(spec, { specFile: "w.json", beforeMerge: { merge: "auto", mergeTokenSecret: "MERGE_TOKEN", ...(environment !== undefined ? { environment } : {}) } }).doc.jobsDoc as Record<string, Job>;

describe("the merge job's environment on GitHub (#5037)", () => {
  test("the done job runs in it, and no other job does", () => {
    const named = jobs("terragucci-merge");
    expect(named["before-merge-done"]!.environment).toBe("terragucci-merge");
    for (const [name, job] of Object.entries(named)) if (name !== "before-merge-done") expect(job.environment, name).toBeUndefined();
    expect(jobs()["before-merge-done"]!.environment).toBeUndefined();
  });

  test("a name that is no environment's is refused", () => {
    expect(() => jobs("has space")).toThrow(/is not an environment name/);
  });

  test("the product pipeline hands it on to the generator", () => {
    const out = productPipelineJobs("github", "default", {
      words: { product: "terragucci", noun: ["root", "roots"], commands: { plan: "plan", apply: "apply" }, approval: "per-wave", op: "tf-apply", bin: "terragucci" },
      waves: { name: "tf-apply", op: "tf-apply", step: { kind: "terraform-apply", root: "{target}" }, waves: [{ name: "wave-1", runs: [{ target: "network" }] }] },
      productPlan: { command: "terragucci plan --out {output}" },
      commentJob: true,
      wavesBeforeMerge: { merge: "auto", mergeTokenSecret: "MERGE_TOKEN", environment: "terragucci-merge" },
    } as never);
    expect(out.waves!.pipeline.beforeMerge).toMatchObject({ environment: "terragucci-merge" });
  });
});
