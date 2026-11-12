/**
 * #5032: Op waves that run from the repository's default branch, by the
 * name the push event gives it (`github.event.repository.default_branch`),
 * with or without named branches beside it. The default branch here is
 * `trunk`; a spec that names its branches renders as before (the
 * `op-waves-defaults-*` goldens).
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { JOB_DEFAULT_BRANCH_ENV, JOB_GUARD_DEFAULT_BRANCH_JS, JOB_GUARD_ENV } from "@intentius/chant/ci-job-guard";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { buildGithubOpWavesDoc, generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  defaultBranch: true,
  standDown: true,
  holds: { policy: true },
  control: { repo: "github.com/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "wide", runs: [], discover: true, shares: 2 },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

const push: OpWavesPipelineOptions = {
  specFile: ".chant/op-waves/tf-apply.spec.json",
  bin: "terragucci",
  renderSpec: { command: ["terragucci", "waves-spec"] },
  evidence: { identity: "oidc" },
  applyStatus: { context: "terragucci/apply" },
  staleNotes: { command: "terragucci chant components pr-post --stale", env: {} },
};
const beforeMerge: OpWavesPipelineOptions = { ...push, beforeMerge: { merge: "auto" } };
const DEFAULT_IF = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";

type Step = { name?: string; env?: Record<string, string>; run?: string };
type Job = { if?: string; env?: Record<string, string>; steps: Step[] };
const jobsOf = (s: OpWavesSpec, o: OpWavesPipelineOptions) => buildGithubOpWavesDoc(s, o).doc.jobsDoc as Record<string, Job>;
const guardOf = (job: Job) => job.steps.find((s) => s.env?.[JOB_GUARD_ENV]);

/** The guard step of `job` run as the forge runs it, with the job's variables and the push's ref. */
const runGuard = (job: Job, ref: string, defaultBranch: string) => {
  const step = guardOf(job)!;
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", GITHUB_REF: ref, [JOB_GUARD_ENV]: step.env![JOB_GUARD_ENV]! };
  if (job.env?.[JOB_DEFAULT_BRANCH_ENV] === "${{ github.event.repository.default_branch }}") env[JOB_DEFAULT_BRANCH_ENV] = defaultBranch;
  return spawnSync("sh", ["-c", step.run!], { env, encoding: "utf-8" });
};

describe("Op waves from the default branch on GitHub (#5032)", () => {
  for (const [mode, options] of [["a push pipeline", push], ["before merge", beforeMerge]] as const) {
    test(`${mode}: every guard admits the default branch by its run-time name, and only it`, () => {
      const jobs = jobsOf(spec, options);
      const guarded = Object.entries(jobs).filter(([, job]) => guardOf(job));
      expect(guarded.length).toBeGreaterThan(3);
      for (const [name, job] of guarded) {
        const guard = JSON.parse(guardOf(job)!.env![JOB_GUARD_ENV]!);
        expect(guard, name).toMatchObject({ branches: [], defaultBranch: true });
        expect(guardOf(job)!.run, name).toContain(JOB_GUARD_DEFAULT_BRANCH_JS.slice(-200));
        expect(job.env?.[JOB_DEFAULT_BRANCH_ENV], name).toBe("${{ github.event.repository.default_branch }}");
        expect(runGuard(job, "refs/heads/trunk", "trunk").status, name).toBe(0);
        const refused = runGuard(job, "refs/heads/main", "trunk");
        expect(refused.status, name).toBe(CHANT_EXIT.misplaced);
        expect(refused.stderr, name).toContain("ref: expected refs/heads/trunk, found refs/heads/main");
      }
    });

    test(`${mode}: the push filter cannot name it, so every job's if: does, the evidence, status and control jobs among them`, () => {
      const { doc } = buildGithubOpWavesDoc(spec, options);
      expect((doc.on as { push: unknown }).push).toEqual({ branches: ["**"] });
      for (const [name, job] of Object.entries(doc.jobsDoc as Record<string, Job>)) {
        expect(job.if, name).toContain(`(github.event_name == 'push' && (${DEFAULT_IF}))`);
      }
    });
  }

  test("named branches beside the default branch: the guard and the jobs' if: admit both", () => {
    const named = { ...spec, branches: ["release"] } as OpWavesSpec;
    const jobs = jobsOf(named, push);
    const wave = jobs["wave-1-canary"]!;
    expect(JSON.parse(guardOf(wave)!.env![JOB_GUARD_ENV]!)).toMatchObject({ branches: ["release"], defaultBranch: true });
    expect(wave.if).toContain(`${DEFAULT_IF} || github.ref == 'refs/heads/release'`);
    expect(runGuard(wave, "refs/heads/release", "trunk").status).toBe(0);
    expect(runGuard(wave, "refs/heads/trunk", "trunk").status).toBe(0);
    expect(runGuard(wave, "refs/heads/dev", "trunk").status).toBe(CHANT_EXIT.misplaced);
  });

  test("in a product's workflow, the product's runIf decides the push, and the guards still admit the default branch", () => {
    const jobs = jobsOf(spec, { ...beforeMerge, runIf: "github.ref_name == 'never'" });
    for (const [name, job] of Object.entries(jobs)) expect(job.if, name).toContain("(github.event_name == 'push' && (github.ref_name == 'never'))");
    expect(JSON.parse(guardOf(jobs["wave-1-canary-plan"]!)!.env![JOB_GUARD_ENV]!)).toMatchObject({ defaultBranch: true });
  });

  test("the stand-down reads the default branch from the job, so the command's step sees it", () => {
    const jobs = jobsOf(spec, push);
    expect(jobs["wave-1-canary"]!.env).toMatchObject({ [JOB_DEFAULT_BRANCH_ENV]: "${{ github.event.repository.default_branch }}" });
  });

  test("a pr-review wave's plans workflow runs on every pull request, since its filter cannot name the default branch", () => {
    const plans = { name: "deploy", op: "deploy", apply: ["./apply.sh", "{target}"], plan: ["./plan.sh", "{target}", "{plan}"], defaultBranch: true, waves: [{ name: "prod", runs: [{ target: "app" }], approval: "pr-review" }] } as unknown as OpWavesSpec;
    const yaml = generateGithubOpWavesPipeline(plans, { specFile: "deploy.json" }).files.find((f) => f.name === "deploy-plans.yml")!.yaml;
    expect(yaml).toContain("pull_request: {}");
  });
});
