/**
 * #5053: on Forgejo a resume dispatches a new run, so two runs of one commit
 * can reach the control job at once; `controlGroup` queues the second, as
 * terragucci's own control job does. `resumeGroup` is refused here.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  resume: { schedule: "*/10 * * * *" },
  control: { repo: "github.com/org/control", op: "tf-apply", member: "net", tokenSecret: "CONTROL_TOKEN" },
  waves: [{ name: "canary", runs: [], discover: true }],
} as unknown as OpWavesSpec;

const jobsOf = (o: Record<string, unknown>) =>
  (parseYAML(generateForgejoOpWavesPipeline(spec, { specFile: "w.json", ...o }).files[0]!.yaml) as { jobs: Record<string, { concurrency?: unknown }> }).jobs;

describe("the control job's group on Forgejo (#5053)", () => {
  test("terragucci's group, the pushed commit, queued", () => {
    expect(jobsOf({ controlGroup: "terragucci-control-${{ github.repository }}-{commit}" })["control-dispatch"]!.concurrency).toEqual({
      group: "terragucci-control-${{ github.repository }}-${{ github.sha }}",
      "cancel-in-progress": false,
    });
  });

  test("without it no job has a group", () => {
    for (const job of Object.values(jobsOf({}))) expect(job.concurrency).toBeUndefined();
  });

  test("resumeGroup is refused", () => {
    expect(() => jobsOf({ resumeGroup: "terragucci-resume" })).toThrow(/own concurrency group/);
  });
});
