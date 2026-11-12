/**
 * #5032: the first wave's jobs can need jobs of the product's own workflow,
 * such as terragucci's `check`, so a push that fails the check applies
 * nothing. Without `firstWaveNeeds` the jobs render as before (the
 * `op-waves-defaults-*` goldens).
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { buildGithubOpWavesDoc } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "canary", runs: [], discover: true, shares: 2 },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

const RUN_IF = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
const CHECK_IF = "!cancelled() && (needs.check.result == 'success' || (github.event_name == 'workflow_dispatch' && needs.check.result == 'skipped'))";
const push: OpWavesPipelineOptions = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", runIf: RUN_IF, firstWaveNeeds: ["check"], applyStatus: { context: "terragucci/apply" } };

type Job = { needs?: string[]; if?: string };
const jobsOf = (o: OpWavesPipelineOptions) => buildGithubOpWavesDoc(spec, o).doc.jobsDoc as Record<string, Job>;

describe("the first wave needs the product's jobs on GitHub (#5032)", () => {
  test("a push: wave 1's deciding job needs check and runs only when it passed; its shares and the later waves wait on wave 1", () => {
    const jobs = jobsOf(push);
    expect(jobs["wave-1-canary-decide"]!.needs).toEqual(["check"]);
    expect(jobs["wave-1-canary-decide"]!.if).toMatch(/^\$\{\{ \(\(github\.event_name == 'push' && /);
    expect(jobs["wave-1-canary-decide"]!.if).toContain(`) && (${CHECK_IF}) }}`);
    expect(jobs["wave-1-canary-share-1"]!.needs).toEqual(["wave-1-canary-decide"]);
    expect(jobs["wave-2-rest"]!.needs).not.toContain("check");
    for (const [name, job] of Object.entries(jobs)) if (name !== "wave-1-canary-decide") expect(job.needs ?? [], name).not.toContain("check");
  });

  test("before merge: wave 1's plan job needs check; a dispatched run, where the check does not run, still plans", () => {
    const jobs = jobsOf({ ...push, beforeMerge: { merge: "manual" } });
    expect(jobs["wave-1-canary-plan"]!.needs).toEqual(["check"]);
    expect(jobs["wave-1-canary-plan"]!.if).toContain(CHECK_IF);
    expect(jobs["wave-1-canary-plan"]!.if).toContain("github.event.inputs.wave == ''");
    expect(jobs["wave-1-canary-gate"]!.needs).toEqual(["wave-1-canary-plan"]);
  });

  test("several jobs, each to pass", () => {
    const jobs = jobsOf({ ...push, firstWaveNeeds: ["check", "fmt"] });
    expect(jobs["wave-1-canary-decide"]!.needs).toEqual(["check", "fmt"]);
    expect(jobs["wave-1-canary-decide"]!.if).toContain("needs.fmt.result == 'success'");
  });

  test("refused: without runIf, a name the forge cannot take, a job of the waves, a job named twice", () => {
    expect(() => jobsOf({ ...push, runIf: undefined })).toThrow(/goes with runIf/);
    expect(() => jobsOf({ ...push, firstWaveNeeds: ["has space"] })).toThrow(/not a job name/);
    expect(() => jobsOf({ ...push, firstWaveNeeds: ["wave-2-rest"] })).toThrow(/a job of the waves themselves/);
    expect(() => jobsOf({ ...push, firstWaveNeeds: ["check", "check"] })).toThrow(/names a job twice/);
  });

  test("an empty list is none", () => {
    expect(jobsOf({ ...push, firstWaveNeeds: [] })).toEqual(jobsOf({ ...push, firstWaveNeeds: undefined }));
  });
});
