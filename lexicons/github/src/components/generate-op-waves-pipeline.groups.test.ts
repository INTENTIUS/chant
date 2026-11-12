/**
 * #5053: the control job takes a product's concurrency group, with `{commit}`
 * standing for the commit it tells the control repo about, so a push's run
 * and a resume's run send one dispatch per commit. The resume workflow keeps
 * its own group, so `resumeGroup` is refused here. Without them the jobs
 * render as before (the `op-waves-defaults-*` goldens).
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { buildGithubOpWavesDoc } from "./generate-op-waves-pipeline";

const control = { repo: "github.com/org/control", op: "tf-apply", member: "net", tokenSecret: "CONTROL_TOKEN" };
const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  resume: { schedule: "*/10 * * * *" },
  control,
  waves: [{ name: "canary", runs: [], discover: true }],
} as unknown as OpWavesSpec;
const restSpec = { ...spec, waves: [...spec.waves, { name: "rest", runs: [], discover: true, rest: true }] } as unknown as OpWavesSpec;

const TG_GROUP = "terragucci-control-${{ github.repository }}-{commit}";
const base: OpWavesPipelineOptions = { specFile: "w.json", bin: "terragucci" };
type Job = { concurrency?: unknown; if?: string };
const jobsOf = (s: OpWavesSpec, o: OpWavesPipelineOptions) => buildGithubOpWavesDoc(s, o).doc.jobsDoc as Record<string, Job>;

describe("the control job's group on GitHub (#5053)", () => {
  test("a push: terragucci's group, the pushed commit, queued", () => {
    expect(jobsOf(spec, { ...base, controlGroup: TG_GROUP })["control-dispatch"]!.concurrency).toEqual({
      group: "terragucci-control-${{ github.repository }}-${{ github.sha }}",
      "cancel-in-progress": false,
    });
  });

  test("before merge with a rest wave: the commit the follow-on goes on with", () => {
    const jobs = jobsOf(restSpec, { ...base, controlGroup: TG_GROUP, beforeMerge: { merge: "manual" }, dispatchInputs: { commit: "apply_commit" } });
    expect(jobs["control-dispatch"]!.concurrency).toEqual({
      group: "terragucci-control-${{ github.repository }}-${{ github.event.inputs.apply_commit || github.sha }}",
      "cancel-in-progress": false,
    });
    expect(jobs["control-dispatch"]!.if).toContain("!cancelled()");
  });

  test("a group without {commit} is taken as it is", () => {
    expect(jobsOf(spec, { ...base, controlGroup: "one-control" })["control-dispatch"]!.concurrency).toEqual({ group: "one-control", "cancel-in-progress": false });
  });

  test("without it the control job has no group, and the resume workflow keeps its own", () => {
    const built = buildGithubOpWavesDoc(spec, base);
    for (const job of Object.values(built.doc.jobsDoc as Record<string, Job>)) expect(job.concurrency).toBeUndefined();
    expect(built.resumeDoc!.concurrency).toEqual({ group: "tf-apply-resume", "cancel-in-progress": true });
  });

  test("refused: a spec without control, an empty or two-line group, and resumeGroup", () => {
    const noControl = { ...spec, control: undefined } as unknown as OpWavesSpec;
    expect(() => jobsOf(noControl, { ...base, controlGroup: TG_GROUP })).toThrow(/the spec has no control/);
    expect(() => jobsOf(spec, { ...base, controlGroup: " " })).toThrow(/one line/);
    expect(() => jobsOf(spec, { ...base, controlGroup: "a\nb" })).toThrow(/one line/);
    expect(() => jobsOf(spec, { ...base, resumeGroup: "terragucci-resume" })).toThrow(/own concurrency group/);
  });
});
