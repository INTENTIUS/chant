/**
 * #5032: on GitLab the first wave's jobs can need jobs of the product's own
 * pipeline, such as terragucci's `check`. A wave job with `needs:` no
 * longer waits for the earlier stages, so stage order alone would not hold
 * once the product's pipeline puts other jobs there; the needs are
 * optional, so a pipeline without the job (a schedule, a before-merge
 * pipeline the product leaves its check out of) still runs the waves.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  holds: { policy: true },
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "wide", runs: [], discover: true, shares: 2 },
  ],
} as unknown as OpWavesSpec;

const push: OpWavesPipelineOptions = { specFile: "w.json", bin: "terragucci", evidence: { identity: "oidc" }, firstWaveNeeds: ["check"] };
type Job = { needs?: Array<string | { job: string; optional?: boolean }> };
const jobsOf = (o: OpWavesPipelineOptions) => parseYAML(generateGitlabOpWavesPipeline(spec, o).files[0]!.yaml) as Record<string, Job>;
const CHECK = { job: "check", optional: true };

describe("the first wave needs the product's jobs on GitLab (#5032)", () => {
  test("a push: wave 1's policy and wave jobs need check, optional; the later waves do not", () => {
    const jobs = jobsOf(push);
    expect(jobs["wave-1-canary-policy"]!.needs).toEqual([CHECK]);
    expect(jobs["wave-1-canary"]!.needs).toEqual([CHECK, "wave-1-canary-policy"]);
    for (const [name, job] of Object.entries(jobs)) {
      if (name.startsWith("wave-1-canary") && !name.endsWith("evidence")) continue;
      expect(JSON.stringify(job.needs ?? []), name).not.toContain('"check"');
    }
  });

  test("before merge: wave 1's plan job, and its policy job, need check", () => {
    const jobs = jobsOf({ ...push, beforeMerge: { merge: "manual" } });
    expect(jobs["wave-1-canary-plan"]!.needs).toEqual([CHECK, "wave-1-canary-plan-policy"]);
    expect(jobs["wave-1-canary-plan-policy"]!.needs).toEqual([CHECK]);
    expect(jobs["wave-1-canary-gate"]!.needs).toEqual(["wave-1-canary-plan"]);
  });

  test("refused: a job of the waves, a name GitLab cannot take", () => {
    expect(() => jobsOf({ ...push, firstWaveNeeds: ["wave-2-wide-decide"] })).toThrow(/a job of the waves themselves/);
    expect(() => jobsOf({ ...push, firstWaveNeeds: ["stages"] })).toThrow(/not a job name/);
  });
});
