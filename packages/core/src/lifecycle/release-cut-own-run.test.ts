/**
 * `chant release cut --own-run-jobs <name,...>` (terragucci#1531): under
 * `release.green: forge-checks` the pipeline's merge cut counts the jobs of
 * its own run that its wave depended on, beside the other workflows'
 * checks. Each named job must have passed, a pending one is waited on, the
 * run's other entries stay left out, and a run in which the forge reports
 * none of the named jobs is refused. A cut without the flag judges as before.
 */

import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { cutRelease, ReleaseCutError, type CutRequest } from "./release-cut";
import { forgeChecksReader, forgejoContextJob, judgeChecks } from "./release-green";
import { readCuts, type ReleasePublish } from "./release-store";
import type { TargetCompiler } from "../components/release-compile";
import type { ForgeFetch, ForgeTarget } from "../pr-forge";
import { CI_VERDICT_INTERVAL_MS } from "../workspace/ci-green-forge";
import { releaseCutHook, releaseCutOwnRunJobs, stageWavesSpec } from "../pipeline/stages";
import { generatePipeline, pipelineSpecCommand } from "../pipeline/generate";
import { pipelineFromConfig } from "../pipeline/product";
import { asPipelineSpec } from "../pipeline/spec";
import { renderedInFollowOn } from "../cli/handlers/pipeline";
import { describeGreen } from "../cli/handlers/release";
import { parseArgs } from "../cli/parse-args";
import { TestRepo } from "../workspace/trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const noCompile: TargetCompiler = {
  async compile(env) {
    throw new Error(`compiled ${env}`);
  },
  async buildArtifacts() {
    throw new Error("built");
  },
};
const NPM: ReleasePublish = { target: "npm:0123456789abcdef", kind: "npm", destination: "registry.npmjs.org" };

function project(): TestRepo {
  const r = new TestRepo("release-cut-own-run");
  repos.push(r);
  r.write("package.json", JSON.stringify({ name: "acme-cli", version: "0.0.0" }, null, 2));
  r.write("chant.config.ts", `export default { release: { publish: [{ type: "npm", packages: ["."] }] } };\n`);
  r.commit("init");
  return r;
}

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

/** A fetch that answers each path from the answers under the first route it contains, one per read, the last repeating. */
function sequencedFetch(routes: Record<string, unknown[]>): ForgeFetch & { urls: string[] } {
  const reads: Record<string, number> = {};
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    const hit = Object.entries(routes).find(([p]) => url.includes(p));
    if (!hit) return { ok: false, status: 404, text: async () => "{}" };
    const n = reads[hit[0]] ?? 0;
    reads[hit[0]] = n + 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(hit[1][Math.min(n, hit[1].length - 1)]) };
  }) as unknown as ForgeFetch & { urls: string[] };
  f.urls = urls;
  return f;
}

const target = (kind: ForgeTarget["kind"], apiBase: string): ForgeTarget => ({ kind, apiBase, repo: "acme/cli", host: "h", token: "t", tokenSource: "GH_TOKEN" });
const GH = "https://api.github.com";
const GH_ENV = { GITHUB_RUN_ID: "99", GITHUB_JOB: "wave-2-prod" };
const ghRun = (name: string, status: string, conclusion: string | null, run: number, id = 1) => ({ id, name, status, conclusion, details_url: `https://github.com/acme/cli/actions/runs/${run}/job/${id}` });

function request(r: TestRepo, forgeChecks: CutRequest["forgeChecks"], extra: Partial<CutRequest> = {}): CutRequest {
  return { cwd: r.dir, compiler: noCompile, label: "1.0.0", actor: "alice", env: {}, now: () => new Date("2026-11-21T10:00:00.000Z"), publishes: [NPM], forgeChecks, ...extra };
}

const refusal = async (p: Promise<unknown>): Promise<ReleaseCutError> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseCutError);
  return err as ReleaseCutError;
};

/** The pipeline's run on a merge commit nothing else checks: the product's check, wave 1, and wave 2, which runs the cut. */
const ownRun = (check: [string, string | null], wave1: [string, string | null] = ["completed", "success"]) => ({
  check_runs: [ghRun("check", check[0], check[1], 99, 1), ghRun("wave-1-dev", wave1[0], wave1[1], 99, 2), ghRun("wave-2-prod", "in_progress", null, 99, 3)],
});

describe("a hook cut with --own-run-jobs", () => {
  test("cuts when the named jobs of its run passed, and the cut line records them", async () => {
    const r = project();
    const f = sequencedFetch({ "/check-runs": [ownRun(["completed", "success"])], "/status": [{ statuses: [] }] });
    const read = forgeChecksReader(target("github", GH), GH_ENV, f);
    const result = await cutRelease(request(r, read, { ownRunJobs: ["check", "wave-1-dev"], waitForChecks: { sleep: async () => {}, now: () => 0 } }));
    const green = { source: "forge-checks", forge: "github", checks: [], ownRun: ["check", "wave-1-dev"] };
    expect(result.cut?.green).toEqual(green);
    expect((await readCuts({ cwd: r.dir })).cuts.at(-1)?.green).toEqual(green);
    // `release verify` shows the evidence through this line.
    expect(describeGreen(green as never)).toBe("green by 2 job(s) of the cut's own run: check, wave-1-dev");
  });

  test("counts the other workflows' checks beside them", async () => {
    const r = project();
    const f = sequencedFetch({ "/check-runs": [{ check_runs: [...ownRun(["completed", "success"]).check_runs, ghRun("lint", "completed", "success", 50)] }], "/status": [{ statuses: [] }] });
    const result = await cutRelease(request(r, forgeChecksReader(target("github", GH), GH_ENV, f), { ownRunJobs: ["check", "wave-1-dev"] }));
    expect(result.cut?.green).toEqual({ source: "forge-checks", forge: "github", checks: ["lint"], ownRun: ["check", "wave-1-dev"] });
    expect(describeGreen(result.cut!.green!)).toBe("green by 1 github check(s): lint; and 2 job(s) of the cut's own run: check, wave-1-dev");
  });

  test("refuses when a named job failed", async () => {
    const r = project();
    const c = clock();
    const f = sequencedFetch({ "/check-runs": [ownRun(["completed", "failure"])], "/status": [{ statuses: [] }] });
    const err = await refusal(cutRelease(request(r, forgeChecksReader(target("github", GH), GH_ENV, f), { ownRunJobs: ["check", "wave-1-dev"], waitForChecks: { sleep: c.sleep, now: c.now } })));
    expect(err.code).toBe("release-commit-not-green");
    expect(err.message).toContain("a check did not pass on github: check (failure)");
    expect(c.sleeps).toEqual([]);
  });

  test("a failed other check refuses too, whatever the named jobs say", async () => {
    const r = project();
    const f = sequencedFetch({ "/check-runs": [{ check_runs: [...ownRun(["completed", "success"]).check_runs, ghRun("lint", "completed", "failure", 50)] }], "/status": [{ statuses: [] }] });
    const err = await refusal(cutRelease(request(r, forgeChecksReader(target("github", GH), GH_ENV, f), { ownRunJobs: ["check", "wave-1-dev"] })));
    expect(err.message).toContain("lint (failure)");
  });

  test("waits on a named job still running, then cuts", async () => {
    const r = project();
    const c = clock();
    const notes: string[] = [];
    const f = sequencedFetch({ "/check-runs": [ownRun(["in_progress", null]), ownRun(["completed", "success"])], "/status": [{ statuses: [] }] });
    const read = forgeChecksReader(target("github", GH), GH_ENV, f);
    const result = await cutRelease(request(r, read, { ownRunJobs: ["check", "wave-1-dev"], waitForChecks: { sleep: c.sleep, now: c.now, onNote: (l) => notes.push(l) } }));
    expect(result.cut?.green).toMatchObject({ ownRun: ["check", "wave-1-dev"] });
    expect(c.sleeps).toEqual([CI_VERDICT_INTERVAL_MS]);
    expect(notes[0]).toBe("waiting on github: check (in_progress)");
  });

  test("refuses when the forge reports none of the named jobs", async () => {
    const r = project();
    const f = sequencedFetch({ "/check-runs": [ownRun(["completed", "success"])], "/status": [{ statuses: [] }] });
    const err = await refusal(cutRelease(request(r, forgeChecksReader(target("github", GH), GH_ENV, f), { ownRunJobs: ["Check the change", "deploy"] })));
    expect(err.code).toBe("release-commit-not-green");
    expect(err.message).toContain("the cut counts the jobs Check the change, deploy of its own run, and github reports none of them on it");
    expect(err.fix).toContain("the check run's name on GitHub");
  });

  test("the cut's own job, and jobs of an earlier run of the workflow, never count", async () => {
    // Run 98 is an earlier run of the same workflow file on the commit; wave-2-prod is the job the cut runs in.
    const f = sequencedFetch({ "/actions/runs?": [{ workflow_runs: [{ id: 98, path: ".github/workflows/shop.yml" }] }], "/check-runs": [{ check_runs: [ghRun("check", "completed", "success", 98), ghRun("wave-2-prod", "in_progress", null, 99)] }], "/status": [{ statuses: [] }] });
    const read = forgeChecksReader(target("github", GH), { ...GH_ENV, GITHUB_WORKFLOW_REF: "acme/cli/.github/workflows/shop.yml@refs/heads/main" }, f);
    expect(await read("abc", null, ["check", "wave-2-prod"])).toMatchObject({ green: false, ownRunMissing: true });
  });
});

describe("a cut without --own-run-jobs", () => {
  test("still refuses a commit whose only checks are its own run's", async () => {
    const r = project();
    const f = sequencedFetch({ "/check-runs": [ownRun(["completed", "success"])], "/status": [{ statuses: [] }] });
    const err = await refusal(cutRelease(request(r, forgeChecksReader(target("github", GH), GH_ENV, f))));
    expect(err.message).toContain("belong to the cut's own run, which the cut leaves out");
    expect(err.fix).toContain("--own-run-jobs");
  });

  test("an empty list is no list", async () => {
    const r = project();
    const f = sequencedFetch({ "/check-runs": [ownRun(["completed", "success"])], "/status": [{ statuses: [] }] });
    const err = await refusal(cutRelease(request(r, forgeChecksReader(target("github", GH), GH_ENV, f), { ownRunJobs: [] })));
    expect(err.message).toContain("belong to the cut's own run");
  });

  test("judgeChecks with no names judges as before", () => {
    expect(judgeChecks("github", [], [], 2)).toMatchObject({ green: false, ownRunOnly: true });
    expect(judgeChecks("github", [{ name: "t", state: "success", status: "success" }], [], 1)).toEqual({ green: true, forge: "github", checks: ["t"] });
  });
});

describe("matching a named job per forge", () => {
  test("GitHub: by the check run's name, in the cut's run only", async () => {
    const f = sequencedFetch({ "/check-runs": [{ check_runs: [ghRun("check", "completed", "success", 99), ghRun("wave-1-dev", "completed", "success", 99, 2), ghRun("check", "completed", "failure", 7, 9)] }], "/status": [{ statuses: [] }] });
    const read = forgeChecksReader(target("github", GH), GH_ENV, f);
    // Run 7 is another workflow's job named check; it is judged as the other workflows' checks are.
    expect(await read("abc", null, ["check"])).toMatchObject({ green: false, why: expect.stringContaining("check (failure)") });
    const ok = sequencedFetch({ "/check-runs": [{ check_runs: [ghRun("check", "completed", "success", 99), ghRun("wave-1-dev", "completed", "failure", 99, 2)] }], "/status": [{ statuses: [] }] });
    // wave-1-dev is not named, so it is left out with the rest of the run.
    expect(await forgeChecksReader(target("github", GH), GH_ENV, ok)("abc", null, ["check"])).toEqual({ green: true, forge: "github", checks: [], ownRun: ["check"] });
  });

  test("Forgejo: by the job of the <workflow> / <job> (<event>) status context", async () => {
    expect(forgejoContextJob("pipeline / check (push)")).toBe("check");
    expect(forgejoContextJob("a / b / wave-1-dev (push)")).toBe("wave-1-dev");
    expect(forgejoContextJob("ci/lint")).toBe("ci/lint");
    const url = (n: number) => `https://code.example/acme/cli/actions/runs/${n}/jobs/0`;
    const statuses = (check: string) => ({
      statuses: [
        { id: 1, context: "pipeline / check (push)", status: check, target_url: url(12) },
        { id: 2, context: "pipeline / wave-1-dev (push)", status: "success", target_url: url(12) },
        { id: 3, context: "pipeline / wave-2-prod (push)", status: "pending", target_url: url(12) },
      ],
    });
    const env = { FORGEJO_RUN_NUMBER: "12", GITHUB_JOB: "wave-2-prod" };
    const pass = forgeChecksReader(target("forgejo", "https://code.example/api/v1"), env, sequencedFetch({ "/status": [statuses("success")] }));
    expect(await pass("abc", null, ["check", "wave-1-dev"])).toEqual({ green: true, forge: "forgejo", checks: [], ownRun: ["check", "wave-1-dev"] });
    const fail = forgeChecksReader(target("forgejo", "https://code.example/api/v1"), env, sequencedFetch({ "/status": [statuses("failure")] }));
    expect(await fail("abc", null, ["check", "wave-1-dev"])).toMatchObject({ green: false, why: expect.stringContaining("check (failure)") });
    const none = forgeChecksReader(target("forgejo", "https://code.example/api/v1"), env, sequencedFetch({ "/status": [statuses("success")] }));
    expect(await none("abc", null, ["pipeline / check (push)"])).toMatchObject({ green: false, ownRunMissing: true });
  });

  test("GitLab: by the job's name in the cut's own pipeline, the cut's own job left out", async () => {
    const jobs = (check: string) => [
      { id: 1, name: "check", status: check, web_url: "https://gitlab.example/acme/cli/-/jobs/1" },
      { id: 2, name: "wave-1-dev", status: "success" },
      { id: 3, name: "wave-2-prod", status: "running" },
    ];
    const env = { CI_PIPELINE_ID: "7", CI_JOB_ID: "3", CI_JOB_NAME: "wave-2-prod" };
    const routes = (check: string) => ({ "/pipelines/7/jobs": [jobs(check)], "/pipelines?sha=": [[{ id: 7, status: "running", source: "push" }]] });
    const f = sequencedFetch(routes("success"));
    const read = forgeChecksReader(target("gitlab", "https://gitlab.example/api/v4"), env, f);
    expect(await read("abc", null, ["check", "wave-1-dev", "wave-2-prod"])).toEqual({ green: true, forge: "gitlab", checks: [], ownRun: ["check", "wave-1-dev"] });
    expect(f.urls.some((u) => u.includes("/projects/acme%2Fcli/pipelines/7/jobs?per_page=100&page=1"))).toBe(true);
    const failed = forgeChecksReader(target("gitlab", "https://gitlab.example/api/v4"), env, sequencedFetch(routes("failed")));
    expect(await failed("abc", null, ["check", "wave-1-dev"])).toMatchObject({ green: false, why: expect.stringContaining("check (failed)") });
    const canceled = forgeChecksReader(target("gitlab", "https://gitlab.example/api/v4"), env, sequencedFetch(routes("canceled")));
    expect(await canceled("abc", null, ["check"])).toMatchObject({ green: false });
    const pending = forgeChecksReader(target("gitlab", "https://gitlab.example/api/v4"), env, sequencedFetch(routes("pending")));
    expect(await pending("abc", null, ["check"])).toMatchObject({ green: false, why: expect.stringContaining("not finished") });
    const absent = forgeChecksReader(target("gitlab", "https://gitlab.example/api/v4"), env, sequencedFetch(routes("success")));
    expect(await absent("abc", null, ["test"])).toMatchObject({ green: false, ownRunMissing: true });
    // Without names the jobs are not read at all.
    const plain = sequencedFetch(routes("success"));
    expect(await forgeChecksReader(target("gitlab", "https://gitlab.example/api/v4"), env, plain)("abc", null)).toMatchObject({ green: false, ownRunOnly: true });
    expect(plain.urls.some((u) => u.includes("/jobs"))).toBe(false);
  });
});

describe("the pipeline's release-cut hook names the jobs", () => {
  test("releaseCutHook passes --own-run-jobs when given names, and leaves it out when not", () => {
    expect(releaseCutHook({}, ["check", "wave-1-dev"])?.command).toEqual(["chant", "release", "cut", "auto", "--first", "0.1.0", "--yes", "--wait-checks", "--own-run-jobs", "check,wave-1-dev"]);
    expect(releaseCutHook({})?.command).not.toContain("--own-run-jobs");
  });

  test("the jobs are the product's firstWaveNeeds and every job each last-wave job depends on", () => {
    const jobs = [
      { jobName: "wave-1-dev", wave: 1, needs: [] },
      { jobName: "wave-2-prod-decide", wave: 2, needs: ["wave-1-dev"] },
      { jobName: "wave-2-prod-share-1", wave: 2, needs: ["wave-2-prod-decide"] },
      { jobName: "wave-2-prod-share-2", wave: 2, needs: ["wave-2-prod-decide"] },
    ];
    // The deciding job is no need of itself, so of the wave's jobs it is not common to them all.
    expect(releaseCutOwnRunJobs(jobs, ["check"])).toEqual(["check", "wave-1-dev"]);
    expect(releaseCutOwnRunJobs([{ jobName: "wave-1-dev", wave: 1, needs: [] }], [])).toEqual([]);
    expect(releaseCutOwnRunJobs([{ jobName: "wave-1-dev", wave: 1, needs: [] }], ["check"])).toEqual(["check"]);
  });

  test("pipeline generate renders them into the render command and the hook, as the generator named the jobs", async () => {
    const spec = asPipelineSpec(pipelineFromConfig({ name: "shop", promotion: ["dev"], defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } }, waves: { dev: [{ name: "a", runs: [{ target: "a" }] }, { name: "b", runs: [{ target: "b" }] }] } }));
    const calls: Array<{ spec: ReturnType<typeof stageWavesSpec>; options: { renderSpec: { command: string[] } } }> = [];
    const plugin = {
      generateOpWavesPipeline: (s: never, o: never) => {
        calls.push({ spec: s, options: o });
        return { files: [], jobs: [{ jobName: "tg-apply-1", wave: 1, needs: [] }, { jobName: "tg-apply-2", wave: 2, needs: ["tg-apply-1"] }] };
      },
      generatePipelinePromote: () => [],
    } as never;
    const got = await generatePipeline(spec, "github", { firstWaveNeeds: ["check"] }, plugin);
    expect(got.error).toBeUndefined();
    const last = calls.at(-1)!;
    expect(last.options.renderSpec.command).toEqual([...pipelineSpecCommand("dev"), "--own-run-jobs", "check,tg-apply-1"]);
    expect(last.spec.waves[1]!.hooks?.after?.apply?.[0]!.command.slice(-2)).toEqual(["--own-run-jobs", "check,tg-apply-1"]);
    // What chant pipeline spec prints for that command is the same hook.
    const { ownRunJobs } = parseArgs(["pipeline", "spec", "--stage", "dev", "--own-run-jobs", "check,tg-apply-1"]);
    expect(stageWavesSpec(spec, "dev", { ownRunJobs })).toEqual(last.spec);
  });

  test("a pipeline whose cut finds no job renders as before", async () => {
    const one = asPipelineSpec(pipelineFromConfig({ name: "shop", promotion: ["dev"], defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } }, waves: { dev: [{ name: "a", runs: [{ target: "a" }] }] } }));
    const commands: string[][] = [];
    const plugin = {
      generateOpWavesPipeline: (_s: never, o: { renderSpec: { command: string[] } }) => (commands.push(o.renderSpec.command), { files: [], jobs: [{ jobName: "wave-1-a", wave: 1, needs: [] }] }),
      generatePipelinePromote: () => [],
    } as never;
    await generatePipeline(one, "github", {}, plugin);
    expect(commands).toEqual([pipelineSpecCommand("dev")]);
  });

  test("the apply run's render command carries --own-run-jobs, and a follow-on or resumed run's render drops it", async () => {
    // Run at the first run: the wave is the rest wave's own, no commit.
    expect(renderedInFollowOn(2, {})).toBe(false);
    expect(renderedInFollowOn(2, { CHANT_WAVES_WAVE: "2" })).toBe(false);
    // A follow-on of a decided head names a later wave; a push's names the commit it goes on with.
    expect(renderedInFollowOn(2, { CHANT_WAVES_WAVE: "3" })).toBe(true);
    expect(renderedInFollowOn(2, { CHANT_WAVES_WAVE: "2", CHANT_WAVES_COMMIT: "a".repeat(40) })).toBe(true);
    const spec = asPipelineSpec(pipelineFromConfig({ name: "shop", promotion: ["dev"], defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } }, waves: { dev: [{ name: "a", runs: [{ target: "a" }] }, { name: "b", runs: [{ target: "b" }] }] } }));
    // Without the flag the cut hook counts no own-run jobs, so it needs a check from another workflow.
    expect(stageWavesSpec(spec, "dev").waves[1]!.hooks?.after?.apply?.[0]!.command).not.toContain("--own-run-jobs");
  });

  test("--own-run-jobs takes names joined by commas", () => {
    expect(parseArgs(["release", "cut", "auto", "--own-run-jobs", "check,wave-1-dev,check"]).ownRunJobs).toEqual(["check", "wave-1-dev"]);
    expect(() => parseArgs(["release", "cut", "auto", "--own-run-jobs", "check,,x"])).toThrow(/job names joined by commas/);
    expect(() => parseArgs(["release", "cut", "auto", "--own-run-jobs"])).toThrow(/job names joined by commas/);
  });
});
