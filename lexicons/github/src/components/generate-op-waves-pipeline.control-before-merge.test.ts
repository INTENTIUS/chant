/**
 * #5060: in a product's workflow before merge the waves apply before the
 * merge, so the control job runs on the default branch's push run (the
 * merge commit's), outside the product's push `runIf`, after its
 * `firstWaveNeeds` jobs, and tells the control repo the waves applied at
 * `github.sha` without adding up outcomes. Without `beforeMerge` the job
 * renders as before (the `op-waves-defaults-*` goldens).
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { buildGithubOpWavesDoc, GITHUB_CONTROL_BEFORE_MERGE_IF } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  defaultBranch: true,
  control: { repo: "github.com/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

// terragucci's shape: a push after a merge applied before merge runs no wave.
const terragucci: OpWavesPipelineOptions = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", runIf: "false", firstWaveNeeds: ["check"], beforeMerge: { merge: "manual" } };

type Step = { name?: string; run?: string; env?: Record<string, string>; uses?: string };
type Job = { needs?: string[]; if?: string; permissions?: Record<string, string>; concurrency?: { group: string }; steps: Step[] };
const jobsOf = (s: OpWavesSpec, o: OpWavesPipelineOptions) => buildGithubOpWavesDoc(s, o).doc.jobsDoc as Record<string, Job>;
const dispatchStep = (job: Job) => job.steps.find((st) => st.env?.CHANT_CONTROL_SHA !== undefined)!;

describe("the control job before merge on GitHub (#5060)", () => {
  test("terragucci's runIf of false: the job runs on the default branch's push, after check, outside the runIf", () => {
    const job = jobsOf(spec, terragucci)["control-dispatch"]!;
    expect(job.if).toBe(`\${{ ${GITHUB_CONTROL_BEFORE_MERGE_IF} }}`);
    expect(job.if).toBe("${{ github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}");
    expect(job.if).not.toContain("false");
    expect(job.needs).toEqual(["check"]);
    expect(job.permissions).toEqual({ contents: "write" });
  });

  test("it tells the control repo the waves applied at the pushed commit, adding up no outcomes", () => {
    const job = jobsOf(spec, terragucci)["control-dispatch"]!;
    expect(job.steps.map((s) => s.name ?? s.uses)).not.toContain("Add up the waves' outcomes");
    expect(job.steps.some((s) => s.name === "Download the waves' outcomes")).toBe(false);
    const step = dispatchStep(job);
    expect(step.name).toBe("Tell the control repo github.com/acme/control that network's waves applied");
    expect(step.env).toMatchObject({ CHANT_CONTROL_OUTCOME: "applied", CHANT_CONTROL_SHA: "${{ github.sha }}", CHANT_CONTROL_TOKEN: "${{ secrets.TG_CONTROL_TOKEN }}" });
    expect(step.run).not.toContain("started a follow-on");
  });

  test("without firstWaveNeeds the job needs nothing", () => {
    const { firstWaveNeeds: _drop, ...noNeeds } = terragucci;
    expect(jobsOf(spec, noNeeds)["control-dispatch"]!.needs).toBeUndefined();
  });

  test("sentCheck, markSent and controlGroup work as on a push", () => {
    const marked = { ...spec, control: { ...spec.control!, sentCheck: "terragucci post sent control", markSent: "terragucci post status control success" } } as OpWavesSpec;
    const job = jobsOf(marked, { ...terragucci, controlGroup: "control-{commit}" })["control-dispatch"]!;
    expect(job.permissions).toEqual({ contents: "write", statuses: "write" });
    expect(job.concurrency).toMatchObject({ group: "control-${{ github.sha }}" });
    const step = dispatchStep(job);
    expect(step.env).toMatchObject({ GITHUB_TOKEN: "${{ github.token }}" });
    expect(step.run).toContain("terragucci post sent control");
    expect(step.run).toContain("terragucci post status control success");
  });

  test("without runIf the before-merge workflow keeps its control job after the last record job", () => {
    const { runIf: _r, firstWaveNeeds: _f, ...plain } = terragucci;
    const job = jobsOf(spec, plain)["control-dispatch"]!;
    expect(job.needs).toEqual(["wave-2-rest-record"]);
    expect(job.if).toContain("(!cancelled() && github.event.inputs.head == '') }}");
  });
});
