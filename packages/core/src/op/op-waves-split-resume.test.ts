/**
 * #5052: a killed split apply is resumed on GitLab and Forgejo too. The
 * gate job's applied line names, on GitLab, the wave's applying and record
 * jobs by name, which `resumeGateRun` retries; on Forgejo, the run's own
 * dispatch inputs, which it dispatches with.
 */
import { describe, expect, test } from "vitest";
import type { ForgeFetch } from "../pr-forge";
import { resumeGateRun, type GateRunLocator } from "../gate-resume-run";
import { NEXT_RELEASE } from "../release-floors";
import { OP_WAVES_RESUME_ENV, OP_WAVES_SPLIT_RESUME_FLOOR, opWaveSplitResumeEnv, opWaveSplitResumeLocator, parseOpWaveSplitResume } from "./op-waves-split-resume";

function fakeForge(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetch: ForgeFetch = async (url, init) => {
    calls.push({ method: init.method, url, ...(init.body ? { body: init.body } : {}) });
    const key = `${init.method} ${new URL(url).pathname}`;
    if (!(key in routes)) return { ok: false, status: 404, text: async () => `no route for ${key}` };
    const body = routes[key];
    return { ok: true, status: 200, text: async () => (body === null ? "" : JSON.stringify(body)) };
  };
  return { fetch, calls, posts: () => calls.filter((c) => c.method === "POST").map((c) => new URL(c.url).pathname) };
}

const split = [
  { jobName: "apply-wave-2-plan", phase: "plan" as const, wave: 2 },
  { jobName: "apply-wave-2-gate", phase: "gate" as const, wave: 2 },
  { jobName: "apply-wave-2", phase: "apply" as const, wave: 2 },
  { jobName: "apply-wave-2-record", phase: "record" as const, wave: 2 },
  { jobName: "apply-wave-3", phase: "apply" as const, wave: 3 },
];

const GITLAB_ENV = { GITLAB_CI: "true", CI_API_V4_URL: "https://gl/api/v4", CI_PROJECT_ID: "7", CI_PIPELINE_ID: "100", CI_JOB_ID: "555", CI_JOB_NAME: "apply-wave-2-gate" };
const FORGEJO_ENV = {
  GITHUB_ACTIONS: "true",
  FORGEJO_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/infra",
  GITHUB_RUN_ID: "9",
  GITHUB_SERVER_URL: "https://fj",
  GITHUB_WORKFLOW_REF: "acme/infra/.forgejo/workflows/terragucci.yml@refs/heads/main",
  GITHUB_REF_NAME: "main",
};

describe("the gate job's resume target (#5052)", () => {
  test("the floor is NEXT_RELEASE", () => {
    expect(OP_WAVES_SPLIT_RESUME_FLOOR).toBe(NEXT_RELEASE);
  });

  test("GitLab: the wave's applying and record jobs; Forgejo: the product's input names; GitHub and other jobs: nothing", () => {
    expect(opWaveSplitResumeEnv(split, split[1]!, "gitlab")).toEqual({ [OP_WAVES_RESUME_ENV]: '{"apply":["apply-wave-2"],"record":"apply-wave-2-record"}' });
    expect(opWaveSplitResumeEnv(split, split[1]!, "forgejo", { pr: "apply_pr", head: "apply_head" })).toEqual({ [OP_WAVES_RESUME_ENV]: '{"inputs":{"pr":"apply_pr","head":"apply_head"}}' });
    expect(opWaveSplitResumeEnv(split, split[1]!, "forgejo")).toEqual({ [OP_WAVES_RESUME_ENV]: "{}" });
    expect(opWaveSplitResumeEnv(split, split[1]!, "github")).toEqual({});
    expect(opWaveSplitResumeEnv(split, split[2]!, "gitlab")).toEqual({});
    expect(parseOpWaveSplitResume("not json")).toBeUndefined();
    expect(parseOpWaveSplitResume('{"inputs":{"pr":"no spaces allowed"}}')).toEqual({});
  });

  test("GitLab: the locator carries the job names", () => {
    expect(opWaveSplitResumeLocator(undefined, GITLAB_ENV)).toBeUndefined();
    const loc = opWaveSplitResumeLocator({ forge: "gitlab", api: "https://gl/api/v4", repo: "7", run: "100", job: "555" }, { ...GITLAB_ENV, ...opWaveSplitResumeEnv(split, split[1]!, "gitlab") });
    expect(loc).toMatchObject({ forge: "gitlab", run: "100", job: "555", retry: { apply: ["apply-wave-2"], record: "apply-wave-2-record" } });
    // Told nothing, the gate job names no run, as before.
    expect(opWaveSplitResumeLocator({ forge: "gitlab", api: "https://gl/api/v4", repo: "7", run: "100", job: "555" }, GITLAB_ENV)).toBeUndefined();
  });

  test("Forgejo: the locator carries the run's decided head, pull request and digest, under the product's names", () => {
    const loc = { forge: "forgejo" as const, api: "https://fj/api/v1", repo: "acme/infra", run: "9", workflow: "terragucci.yml", ref: "main" };
    const env = { ...FORGEJO_ENV, ...opWaveSplitResumeEnv(split, split[1]!, "forgejo", { pr: "apply_pr", head: "apply_head", digest: "apply_digest" }), CHANT_BEFORE_MERGE_PR: "12", CHANT_BEFORE_MERGE_HEAD: "a".repeat(40), CHANT_BEFORE_MERGE_DIGEST: "sha256:d", CHANT_WAVES_COMMIT: "" };
    expect(opWaveSplitResumeLocator(loc, env)).toEqual({ ...loc, inputs: { apply_pr: "12", apply_head: "a".repeat(40), apply_digest: "sha256:d" } });
    // A push's follow-on: the wave and the commit it goes on with, under chant's names.
    const follow = { ...FORGEJO_ENV, [OP_WAVES_RESUME_ENV]: "{}", CHANT_WAVES_WAVE: "4", CHANT_WAVES_COMMIT: "c".repeat(40) };
    expect(opWaveSplitResumeLocator(loc, follow)).toEqual({ ...loc, inputs: { wave: "4", commit: "c".repeat(40) } });
    expect(opWaveSplitResumeLocator(loc, FORGEJO_ENV)).toBeUndefined();
  });

  test("GitHub: the gate job's run, as before", () => {
    const loc: GateRunLocator = { forge: "github", api: "https://api.github.com", repo: "acme/infra", run: "42", attempt: 1 };
    expect(opWaveSplitResumeLocator(loc, {})).toEqual(loc);
  });
});

describe("resumeGateRun of a killed split apply (#5052)", () => {
  const gitlab: GateRunLocator = { forge: "gitlab", api: "https://gl/api/v4", repo: "7", run: "100", job: "555", jobName: "apply-wave-2-gate", retry: { apply: ["apply-wave-2"], record: "apply-wave-2-record" } };

  test("GitLab: retries the applying job that was killed, then the record job that ran after it", async () => {
    const forge = fakeForge({
      "GET /api/v4/projects/7/pipelines/100/jobs": [
        { id: 555, name: "apply-wave-2-gate", status: "success" },
        { id: 556, name: "apply-wave-2", status: "failed" },
        { id: 557, name: "apply-wave-2-record", status: "failed" },
      ],
      "POST /api/v4/projects/7/jobs/556/retry": { id: 600 },
      "POST /api/v4/projects/7/jobs/557/retry": { id: 601 },
    });
    expect(await resumeGateRun(gitlab, { token: "t", fetch: forge.fetch })).toMatchObject({ status: "resumed", how: "retried job 556 (apply-wave-2) and its record job 557" });
    expect(forge.posts()).toEqual(["/api/v4/projects/7/jobs/556/retry", "/api/v4/projects/7/jobs/557/retry"]);
  });

  test("GitLab: a record job GitLab skipped is left to GitLab; a dry run starts nothing", async () => {
    const jobs = [
      { id: 556, name: "apply-wave-2", status: "canceled" },
      { id: 557, name: "apply-wave-2-record", status: "skipped" },
    ];
    const forge = fakeForge({ "GET /api/v4/projects/7/pipelines/100/jobs": jobs, "POST /api/v4/projects/7/jobs/556/retry": { id: 600 } });
    expect(await resumeGateRun(gitlab, { token: "t", fetch: forge.fetch })).toMatchObject({ status: "resumed", how: "retried job 556 (apply-wave-2)" });
    const dry = fakeForge({ "GET /api/v4/projects/7/pipelines/100/jobs": jobs });
    expect(await resumeGateRun(gitlab, { token: "t", fetch: dry.fetch, dryRun: true })).toMatchObject({ status: "would-resume", how: "would retry job 556 (apply-wave-2)" });
    expect(dry.posts()).toEqual([]);
  });

  test("GitLab: an applying job going again is left alone; one that applied falls to the gate job, which succeeded", async () => {
    const going = fakeForge({ "GET /api/v4/projects/7/pipelines/100/jobs": [{ id: 600, name: "apply-wave-2", status: "running" }] });
    expect(await resumeGateRun(gitlab, { token: "t", fetch: going.fetch })).toMatchObject({ status: "skipped", reason: "job 600 (apply-wave-2) is running, not finished" });
    const done = fakeForge({
      "GET /api/v4/projects/7/pipelines/100/jobs": [{ id: 555, name: "apply-wave-2-gate", status: "success" }, { id: 600, name: "apply-wave-2", status: "success" }],
      "GET /api/v4/projects/7/jobs/555": { status: "success", name: "apply-wave-2-gate" },
    });
    expect(await resumeGateRun(gitlab, { token: "t", fetch: done.fetch })).toMatchObject({ status: "skipped", reason: "job 555 succeeded" });
    expect(done.posts()).toEqual([]);
  });

  test("GitLab: the gate job killed before its applying jobs started is retried itself", async () => {
    const forge = fakeForge({
      "GET /api/v4/projects/7/pipelines/100/jobs": [{ id: 555, name: "apply-wave-2-gate", status: "failed" }, { id: 556, name: "apply-wave-2", status: "skipped" }],
      "GET /api/v4/projects/7/jobs/555": { status: "failed", name: "apply-wave-2-gate" },
      "POST /api/v4/projects/7/jobs/555/retry": { id: 700 },
    });
    expect(await resumeGateRun(gitlab, { token: "t", fetch: forge.fetch })).toMatchObject({ status: "resumed", how: "retried job 555 as job 700" });
  });

  test("Forgejo: dispatches with the run's inputs; a later push of the branch does not count as the resume, a later dispatch does", async () => {
    const forgejo: GateRunLocator = { forge: "forgejo", api: "https://fj/api/v1", repo: "acme/infra", run: "9", workflow: "terragucci.yml", ref: "main", inputs: { apply_pr: "12", apply_head: "a".repeat(40), apply_digest: "sha256:d" } };
    const forge = fakeForge({
      "GET /api/v1/repos/acme/infra/actions/runs/9": { status: "failure" },
      "GET /api/v1/repos/acme/infra/actions/runs": { workflow_runs: [{ id: 10, prettyref: "main", event: "push", created: "2026-10-02T00:01:00Z" }] },
      "POST /api/v1/repos/acme/infra/actions/workflows/terragucci.yml/dispatches": null,
    });
    const out = await resumeGateRun(forgejo, { token: "t", since: "2026-10-02T00:00:00Z", fetch: forge.fetch });
    expect(out).toMatchObject({ status: "resumed", how: `dispatched terragucci.yml on main with apply_pr=12, apply_head=${"a".repeat(40)}, apply_digest=sha256:d` });
    expect(JSON.parse(forge.calls.at(-1)!.body!)).toEqual({ ref: "main", inputs: forgejo.inputs });

    const resumed = fakeForge({
      "GET /api/v1/repos/acme/infra/actions/runs/9": { status: "failure" },
      "GET /api/v1/repos/acme/infra/actions/runs": { workflow_runs: [{ id: 11, prettyref: "main", event: "workflow_dispatch", created: "2026-10-02T00:02:00Z" }] },
    });
    expect(await resumeGateRun(forgejo, { token: "t", since: "2026-10-02T00:00:00Z", fetch: resumed.fetch })).toMatchObject({ status: "skipped", reason: expect.stringContaining("run 11") });
  });
});
