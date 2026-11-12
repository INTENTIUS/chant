/**
 * #5032: Op waves that run from the repository's default branch on GitLab,
 * `$CI_DEFAULT_BRANCH`, with or without named branches beside it. Every
 * rule matches it, the before-merge and follow-on pipelines' and the
 * evidence, status, control and stale-notes jobs' among them, and every
 * guard reads it at run time. The default branch here is `trunk`.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { JOB_GUARD_DEFAULT_BRANCH_JS, JOB_GUARD_ENV } from "@intentius/chant/ci-job-guard";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  defaultBranch: true,
  standDown: true,
  holds: { policy: true },
  control: { repo: "gitlab.com/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "wide", runs: [], discover: true, shares: 2 },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

const push: OpWavesPipelineOptions = {
  specFile: ".chant/op-waves/tf-apply.spec.json",
  bin: "terragucci",
  evidence: { identity: "oidc" },
  applyStatus: { context: "terragucci/apply" },
  staleNotes: { command: "terragucci chant components pr-post --stale --forge gitlab", env: {} },
};
const beforeMerge: OpWavesPipelineOptions = { ...push, beforeMerge: { merge: "auto", mergeTokenSecret: "TG_MERGE_TOKEN" } };

type Job = { rules?: Array<{ if?: string; when?: string }>; variables?: Record<string, string>; script?: string[] };
const jobsOf = (s: OpWavesSpec, o: OpWavesPipelineOptions): Record<string, Job> => {
  const doc = parseYAML(generateGitlabOpWavesPipeline(s, o).files[0]!.yaml) as Record<string, Job>;
  return Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "stages" && k !== "variables"));
};

/** The job's guard, its script's first line, run as the runner runs it on `ref`. */
const runGuard = (job: Job, ref: string) =>
  spawnSync("sh", ["-c", job.script![0]!], {
    env: { PATH: process.env.PATH ?? "", CI_COMMIT_REF_NAME: ref, CI_COMMIT_REF_PROTECTED: "true", CI_DEFAULT_BRANCH: "trunk", [JOB_GUARD_ENV]: job.variables![JOB_GUARD_ENV]! },
    encoding: "utf-8",
  });

describe("Op waves from the default branch on GitLab (#5032)", () => {
  for (const [mode, options] of [["a push pipeline", push], ["before merge", beforeMerge]] as const) {
    test(`${mode}: every rule that runs a job matches $CI_DEFAULT_BRANCH, and none names main`, () => {
      for (const [name, job] of Object.entries(jobsOf(spec, options))) {
        const running = (job.rules ?? []).filter((r) => r.when !== "never" && r.if !== undefined);
        expect(running.length, name).toBeGreaterThan(0);
        for (const rule of running) {
          expect(rule.if, name).toMatch(/\$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH$/);
          expect(rule.if, name).not.toContain('"main"');
        }
      }
    });

    test(`${mode}: every guard admits the default branch, and refuses main when it is not that`, () => {
      const guarded = Object.entries(jobsOf(spec, options)).filter(([, job]) => job.variables?.[JOB_GUARD_ENV]);
      expect(guarded.length).toBeGreaterThan(3);
      for (const [name, job] of guarded) {
        expect(JSON.parse(job.variables![JOB_GUARD_ENV]!), name).toMatchObject({ branches: [], defaultBranch: true });
        expect(job.script![0], name).toContain(JOB_GUARD_DEFAULT_BRANCH_JS.slice(-200));
        expect(runGuard(job, "trunk").status, name).toBe(0);
        const refused = runGuard(job, "main");
        expect(refused.status, name).toBe(CHANT_EXIT.misplaced);
        expect(refused.stderr, name).toContain("ref: expected trunk, found main");
      }
    });
  }

  test("before merge: the decided head's and the follow-on's pipelines run on the default branch too", () => {
    const jobs = jobsOf(spec, beforeMerge);
    const ifs = Object.values(jobs).flatMap((j) => (j.rules ?? []).map((r) => r.if ?? ""));
    expect(ifs).toContain('$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $CHANT_BEFORE_MERGE_HEAD =~ /^[0-9a-f]{40,64}$/ && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    expect(ifs).toContain('$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $CHANT_WAVES_COMMIT =~ /^[0-9a-f]{40,64}$/ && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
  });

  test("named branches beside the default branch: a rule each, and the guard admits both", () => {
    const jobs = jobsOf({ ...spec, branches: ["release"] } as OpWavesSpec, push);
    const wave = jobs["wave-1-canary"]!;
    expect(wave.rules!.map((r) => r.if)).toEqual(['$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH', '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "release"']);
    expect(runGuard(wave, "release").status).toBe(0);
    expect(runGuard(wave, "trunk").status).toBe(0);
    expect(runGuard(wave, "dev").status).toBe(CHANT_EXIT.misplaced);
  });

  test("a product's runIf is joined to each of those rules", () => {
    const jobs = jobsOf(spec, { ...push, runIf: '$CI_PIPELINE_SOURCE != "schedule"' });
    expect(jobs["wave-1-canary"]!.rules![0]!.if).toBe('($CI_PIPELINE_SOURCE != "schedule") && ($CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH)');
  });
});
