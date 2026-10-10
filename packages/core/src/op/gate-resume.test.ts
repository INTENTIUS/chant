import { describe, expect, test } from "vitest";
import type { ForgeFetch } from "../pr-forge";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { evaluateGate, memoryGateLedgerPort } from "./gate";
import {
  isGateRunLocator,
  resolutionAnswering,
  resolveGateRunLocator,
  resumeGateRun,
  resumeTokenFromEnv,
  type GateRunLocator,
} from "./gate-resume";

/** A fake forge: answers by "METHOD path" and records every call. */
function fakeForge(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  const fetch: ForgeFetch = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, ...(init.body ? { body: init.body } : {}) });
    const key = `${init.method} ${new URL(url).pathname}${new URL(url).search}`;
    const hit = Object.keys(routes).find((k) => key === k || key.startsWith(`${k}?`) || key.startsWith(k));
    if (!hit) return { ok: false, status: 404, text: async () => `no route for ${key}` };
    const body = routes[hit];
    return { ok: true, status: 200, text: async () => (body === null ? "" : JSON.stringify(body)) };
  };
  return { fetch, calls };
}

const GITHUB_ENV = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/db",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
};

describe("resolveGateRunLocator", () => {
  test("GitHub Actions: the run and the attempt that waited", () => {
    expect(resolveGateRunLocator(GITHUB_ENV)).toEqual({
      forge: "github",
      api: "https://api.github.com",
      repo: "acme/db",
      run: "42",
      attempt: 1,
      url: "https://github.com/acme/db/actions/runs/42",
    });
  });

  test("Forgejo Actions: the workflow file and branch a dispatch names", () => {
    const loc = resolveGateRunLocator({
      ...GITHUB_ENV,
      FORGEJO_ACTIONS: "true",
      GITHUB_SERVER_URL: "https://code.example.org",
      GITHUB_API_URL: "https://code.example.org/api/v1",
      GITHUB_WORKFLOW: "migrations.yml",
      GITHUB_REF_NAME: "main",
    });
    expect(loc).toMatchObject({ forge: "forgejo", api: "https://code.example.org/api/v1", workflow: "migrations.yml", ref: "main", run: "42" });
    expect(isGateRunLocator(loc)).toBe(true);
  });

  test("GitLab CI: the pipeline, the job and its name", () => {
    expect(
      resolveGateRunLocator({
        GITLAB_CI: "true",
        CI_API_V4_URL: "https://gitlab.example.com/api/v4/",
        CI_PROJECT_ID: "7",
        CI_PIPELINE_ID: "100",
        CI_JOB_ID: "555",
        CI_JOB_NAME: "wave-2-staging",
      }),
    ).toEqual({ forge: "gitlab", api: "https://gitlab.example.com/api/v4", repo: "7", run: "100", job: "555", jobName: "wave-2-staging" });
  });

  test("outside CI, or missing a part a resume needs, there is none", () => {
    expect(resolveGateRunLocator({})).toBeUndefined();
    expect(resolveGateRunLocator({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "a/b" })).toBeUndefined();
    expect(resolveGateRunLocator({ ...GITHUB_ENV, GITEA_ACTIONS: "true", GITHUB_WORKFLOW: "Deploy" })).toBeUndefined();
  });
});

describe("resumeGateRun", () => {
  const github: GateRunLocator = { forge: "github", api: "https://api.github.com", repo: "acme/db", run: "42", attempt: 1 };

  test("GitHub: re-runs the failed jobs of a finished run, with a bearer token", async () => {
    const forge = fakeForge({
      "GET /repos/acme/db/actions/runs/42": { status: "completed", conclusion: "failure", run_attempt: 1 },
      "POST /repos/acme/db/actions/runs/42/rerun-failed-jobs": null,
    });
    const out = await resumeGateRun(github, { token: "t", fetch: forge.fetch });
    expect(out).toMatchObject({ status: "resumed", how: "re-ran the failed jobs of run 42" });
    expect(forge.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(forge.calls[1]!.headers.Authorization).toBe("Bearer t");
  });

  test("GitHub: a run still going, or already re-run, is left alone", async () => {
    const running = fakeForge({ "GET /repos/acme/db/actions/runs/42": { status: "in_progress", run_attempt: 1 } });
    expect(await resumeGateRun(github, { token: "t", fetch: running.fetch })).toMatchObject({ status: "skipped" });
    const rerun = fakeForge({ "GET /repos/acme/db/actions/runs/42": { status: "completed", conclusion: "failure", run_attempt: 2 } });
    const out = await resumeGateRun(github, { token: "t", fetch: rerun.fetch });
    expect(out).toMatchObject({ status: "skipped", reason: expect.stringContaining("already re-run") });
    expect(rerun.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("GitLab: retries the waiting job, unless a newer job of its name exists", async () => {
    const gitlab: GateRunLocator = { forge: "gitlab", api: "https://gl/api/v4", repo: "7", run: "100", job: "555", jobName: "wave-2-staging" };
    const forge = fakeForge({
      "GET /api/v4/projects/7/jobs/555": { status: "failed", name: "wave-2-staging" },
      "GET /api/v4/projects/7/pipelines/100/jobs": [{ id: 555, name: "wave-2-staging" }],
      "POST /api/v4/projects/7/jobs/555/retry": { id: 556 },
    });
    expect(await resumeGateRun(gitlab, { token: "t", fetch: forge.fetch })).toMatchObject({ status: "resumed", how: "retried job 555 as job 556" });
    expect(forge.calls[2]!.headers["PRIVATE-TOKEN"]).toBe("t");

    const retried = fakeForge({
      "GET /api/v4/projects/7/jobs/555": { status: "failed", name: "wave-2-staging" },
      "GET /api/v4/projects/7/pipelines/100/jobs": [{ id: 556, name: "wave-2-staging" }],
    });
    expect(await resumeGateRun(gitlab, { token: "t", fetch: retried.fetch })).toMatchObject({ status: "skipped", reason: expect.stringContaining("job 556") });
  });

  test("Forgejo: dispatches the workflow on its branch, unless a run of it started after the approval", async () => {
    const forgejo: GateRunLocator = { forge: "forgejo", api: "https://fj/api/v1", repo: "acme/db", run: "9", workflow: "migrations.yml", ref: "main" };
    const forge = fakeForge({
      "GET /api/v1/repos/acme/db/actions/runs/9": { status: "failure" },
      "GET /api/v1/repos/acme/db/actions/runs": { workflow_runs: [{ id: 9, prettyref: "main", created: "2026-10-01T00:00:00Z" }] },
      "POST /api/v1/repos/acme/db/actions/workflows/migrations.yml/dispatches": null,
    });
    const out = await resumeGateRun(forgejo, { token: "t", since: "2026-10-02T00:00:00Z", fetch: forge.fetch });
    expect(out).toMatchObject({ status: "resumed", how: "dispatched migrations.yml on main" });
    expect(JSON.parse(forge.calls[2]!.body!)).toEqual({ ref: "main" });
    expect(forge.calls[2]!.headers.Authorization).toBe("token t");

    const again = fakeForge({
      "GET /api/v1/repos/acme/db/actions/runs/9": { status: "failure" },
      "GET /api/v1/repos/acme/db/actions/runs": { workflow_runs: [{ id: 10, prettyref: "main", created: "2026-10-02T00:01:00Z" }] },
    });
    expect(await resumeGateRun(forgejo, { token: "t", since: "2026-10-02T00:00:00Z", fetch: again.fetch })).toMatchObject({ status: "skipped" });
  });

  test("a refusal from the forge is thrown with its status", async () => {
    const fetch: ForgeFetch = async () => ({ ok: false, status: 403, text: async () => "Resource not accessible by integration" });
    await expect(resumeGateRun(github, { token: "t", fetch })).rejects.toThrow(/403/);
  });
});

describe("the pending fact and its answer", () => {
  test("a gate reached in CI records where its job runs", async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, GITHUB_ENV);
      const port = memoryGateLedgerPort();
      await evaluateGate(port, { op: "migrations", gate: "migrations-wave-2", planDigest: `sha256:${"a".repeat(64)}`, now: "2026-10-01T00:00:00Z" });
      expect(port.appended[0]!.resume).toMatchObject({ forge: "github", run: "42", attempt: 1 });
    } finally {
      for (const key of Object.keys(GITHUB_ENV)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  test("an approval answers the standing fact only for its plan", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const standing: PendingGateRecord = {
      version: 1, kind: "pending", op: "m", gate: "g", timestamp: "2026-10-01T00:00:00Z", expiresAt: "2026-10-03T00:00:00Z", planDigest: digest,
    };
    const approve = (planDigest: string, timestamp = "2026-10-01T01:00:00Z"): GateResolutionRecord => ({ version: 1, op: "m", gate: "g", resolvedBy: "alice", timestamp, planDigest });
    expect(resolutionAnswering([approve(`sha256:${"b".repeat(64)}`)], standing)).toBeUndefined();
    expect(resolutionAnswering([approve(digest, "2026-09-30T00:00:00Z")], standing)).toBeUndefined();
    expect(resolutionAnswering([approve(digest)], standing)?.resolvedBy).toBe("alice");
  });

  test("the token: CHANT_FORGE_TOKEN first, then the forge's own", () => {
    expect(resumeTokenFromEnv("github", { GITHUB_TOKEN: "g", CHANT_FORGE_TOKEN: "c" })).toBe("c");
    expect(resumeTokenFromEnv("forgejo", { GITHUB_TOKEN: "g" })).toBe("g");
    expect(resumeTokenFromEnv("gitlab", { GITHUB_TOKEN: "g" })).toBeUndefined();
  });
});
