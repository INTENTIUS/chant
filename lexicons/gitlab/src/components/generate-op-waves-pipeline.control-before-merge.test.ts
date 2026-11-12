/**
 * #5060: in a product's GitLab pipeline before merge the control job runs in
 * the default branch's push pipeline, outside the product's `runIf`, after
 * its `firstWaveNeeds` jobs alone, and tells the control repo the waves
 * applied at `$CI_COMMIT_SHA` without adding up outcomes.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline, GITLAB_CONTROL_BEFORE_MERGE_RULE } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  defaultBranch: true,
  control: { repo: "gitlab.com/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
  waves: [
    { name: "canary", runs: [], discover: true, setup: [{ run: "npm ci" }] },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

// terragucci's shape: before merge a push pipeline runs no wave.
const terragucci: OpWavesPipelineOptions = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", runIf: '$CI_PIPELINE_SOURCE != "push"', firstWaveNeeds: ["check"], beforeMerge: { merge: "manual" } };

type Job = { rules?: Array<{ if?: string; when?: string }>; needs?: unknown[]; script: string[]; resource_group?: string };
const jobsOf = (o: OpWavesPipelineOptions) => parseYAML(generateGitlabOpWavesPipeline(spec, o).files[0]!.yaml) as Record<string, Job>;

describe("the control job before merge on GitLab (#5060)", () => {
  test("terragucci's runIf: the job runs in the default branch's push pipeline, after check", () => {
    const job = jobsOf(terragucci)["control-dispatch"]!;
    expect(job.rules).toEqual([{ if: GITLAB_CONTROL_BEFORE_MERGE_RULE }]);
    expect(GITLAB_CONTROL_BEFORE_MERGE_RULE).toBe('$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    expect(job.needs).toEqual([{ job: "check", optional: true }]);
  });

  test("it tells the control repo the waves applied at the pushed commit, adding up no outcomes", () => {
    const script = jobsOf(terragucci)["control-dispatch"]!.script.join("\n");
    expect(script).not.toContain("--waves-outcome");
    expect(script).toContain('export CHANT_CONTROL_OUTCOME="applied"');
    expect(script).toContain('export CHANT_CONTROL_SHA="$CI_COMMIT_SHA"');
    expect(script).toContain("npm ci");
    expect(script).toContain("unset CHANT_CONTROL_TOKEN CHANT_CONTROL_READ_TOKEN TG_CONTROL_TOKEN");
    expect(script).not.toContain("started a follow-on");
  });

  test("without firstWaveNeeds it starts at once; controlGroup names the pushed commit", () => {
    const { firstWaveNeeds: _drop, ...noNeeds } = terragucci;
    const job = jobsOf({ ...noNeeds, controlGroup: "control-{commit}" })["control-dispatch"]!;
    expect(job.needs).toEqual([]);
    expect(job.resource_group).toBe("control-$CI_COMMIT_SHA");
  });

  test("the waves' jobs still carry the product's runIf", () => {
    const jobs = jobsOf(terragucci);
    expect(jobs["wave-1-canary-plan"]!.rules!.every((r) => r.when === "never" || r.if!.startsWith('($CI_PIPELINE_SOURCE != "push") && '))).toBe(true);
  });
});
