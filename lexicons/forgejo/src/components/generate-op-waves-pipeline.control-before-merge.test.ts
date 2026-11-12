/**
 * #5060: in a product's Forgejo workflow before merge the control job runs
 * on the default branch's push run, outside the product's push `runIf`,
 * after its `firstWaveNeeds` jobs, and tells the control repo the waves
 * applied at `github.sha` without adding up outcomes.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { buildForgejoOpWavesDoc } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  defaultBranch: true,
  control: { repo: "codeberg.org/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

// terragucci's shape: a push after a merge applied before merge runs no wave.
const terragucci: OpWavesPipelineOptions = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", runIf: "false", firstWaveNeeds: ["check"], beforeMerge: { merge: "manual" } };

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { needs?: string[]; if?: string; steps: Step[] };
const jobsOf = (o: OpWavesPipelineOptions) => buildForgejoOpWavesDoc(spec, o).doc.jobsDoc as Record<string, Job>;

describe("the control job before merge on Forgejo (#5060)", () => {
  test("terragucci's runIf of false: the job runs on the default branch's push, after check", () => {
    const job = jobsOf(terragucci)["control-dispatch"]!;
    expect(job.if).toBe("${{ github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}");
    expect(job.needs).toEqual(["check"]);
  });

  test("it tells the control repo the waves applied at the pushed commit, adding up no outcomes", () => {
    const job = jobsOf(terragucci)["control-dispatch"]!;
    expect(job.steps.some((s) => s.name === "Add up the waves' outcomes" || s.name === "Download the waves' outcomes")).toBe(false);
    const step = job.steps.find((s) => s.env?.CHANT_CONTROL_SHA !== undefined)!;
    expect(step.env).toMatchObject({ CHANT_CONTROL_OUTCOME: "applied", CHANT_CONTROL_SHA: "${{ github.sha }}" });
  });

  test("the waves' jobs still run under the product's runIf", () => {
    const jobs = jobsOf(terragucci);
    expect(jobs["wave-1-canary-plan"]!.if).toContain("(github.event_name == 'push' && (false))");
  });
});
