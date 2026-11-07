/**
 * #4729 — `chant ci verdict --wait` re-runs a failed job's workflow run
 * before it fails a merge group, looks past a forge 5xx, and gives up before
 * the job's own timeout. With retries 0 it fails at the first failed job, as
 * #4644 did.
 */

import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { ForgeApiError, type ForgeFetch } from "../pr-forge";
import { parseArgs } from "../cli/parse-args";
import { parseYAMLDocument } from "../yaml";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { CI_VERDICT_BACKOFF_MS, CI_VERDICT_FORGE_ERRORS, CI_VERDICT_INTERVAL_MS, ciVerdict, CiVerdictGaveUpError } from "./ci-green";
import { runCiVerdict } from "./ci-green-cli";
import { githubCiForge, isTransientForgeError, type CheckRun, type CiForge, type WorkflowRun } from "./ci-green-forge";
import { MERGE_QUEUE_VERDICT_JOB, MERGE_QUEUE_VERDICT_TIMEOUT_MINUTES, renderMergeQueueWorkflow } from "./ci-green-workflow";
import { parseDeclaration } from "./declaration";

afterAll(cleanScratch);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SHA = "a".repeat(40);
const run = (id: number, name: string, conclusion: string | null, status = "completed"): CheckRun => ({ id, name, status, conclusion: status === "completed" ? conclusion : null, completedAt: null, url: null });
const wfRun = (attempt: number, status = "completed", conclusion: string | null = status === "completed" ? "failure" : null): WorkflowRun => ({ id: 70, name: "check", attempt, status, conclusion, url: "https://github.com/acme/app/actions/runs/70" });
const http = (status: number) => new ForgeApiError("GET", `https://api.github.com/repos/acme/app/commits/${SHA}/check-runs`, status, "");

function workspace(mergeQueue: unknown): string {
  const root = scratchDir("chant-verdict-retries-");
  git(root, "init", "-q");
  writeFiles(root, { "chant.workspace.json": declaration([], { ci: { green: { branch: "main", phases: { lint: ["lint"], test: ["test"] }, require: ["lint", "test"], mergeQueue } } }) });
  return root;
}

/** A forge that answers each read from a script (the last answer repeats), and a clock that only `sleep` moves. */
function scripted(checks: (CheckRun[] | Error)[], runs: (WorkflowRun | null | Error)[] = []) {
  let t = 0;
  const log = { reads: 0, runReads: 0, reruns: [] as number[], sleeps: [] as number[], notes: [] as string[] };
  const next = <T>(list: T[], i: number): T => list[Math.min(i, list.length - 1)]!;
  const forge: CiForge = {
    kind: "github",
    async checkRuns() {
      const a = next(checks, log.reads++);
      if (a instanceof Error) throw a;
      return a;
    },
    async workflowRun() {
      const a = next(runs, log.runReads++);
      if (a instanceof Error) throw a;
      return a;
    },
    async rerunFailedJobs(id) {
      log.reruns.push(id);
    },
  };
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      log.sleeps.push(ms);
      t += ms;
    },
    onNote: (line: string) => void log.notes.push(line),
  };
  return { forge, clock, log };
}

const LINT = run(1, "lint", "success");

describe("ci verdict --wait with retries (#4729)", () => {
  test("a flake that passes on its re-run passes, and its run is re-run once", async () => {
    const { forge, clock, log } = scripted(
      [[LINT, run(2, "test", "failure")], [LINT, run(2, "test", "failure")], [LINT, run(2, "test", "failure"), run(3, "test", null, "in_progress")], [LINT, run(2, "test", "failure"), run(3, "test", "success")]],
      [wfRun(1), wfRun(2, "queued")],
    );
    const out = await ciVerdict({ cwd: workspace({ retries: 1 }), sha: SHA, forge, wait: true, ...clock });
    expect(out.verdict.verdict).toBe("pass");
    expect(out.repeated).toBeUndefined();
    expect(log.reruns).toEqual([70]);
    expect(log.notes[0]).toBe("test (phase test) in workflow run check https://github.com/acme/app/actions/runs/70 failed on attempt 1 of 2; re-running its failed jobs");
  });

  test("a failure that repeats fails, naming the phase, the job and the workflow run", async () => {
    const { forge, clock, log } = scripted([[LINT, run(2, "test", "failure")], [LINT, run(2, "test", "failure"), run(3, "test", "failure")]], [wfRun(1), wfRun(2)]);
    const out = await ciVerdict({ cwd: workspace({ retries: 1 }), sha: SHA, forge, wait: true, ...clock });
    expect(out.verdict.verdict).toBe("fail");
    expect(out.repeated).toMatchObject({ phase: "test", run: { id: 3, name: "test" }, workflowRun: { id: 70, name: "check", attempt: 2 } });
    expect(log.reruns).toEqual([70]);
  });

  test("retries 2 re-runs twice and fails on the third attempt", async () => {
    const failed = [LINT, run(2, "test", "failure")];
    const { forge, clock, log } = scripted([failed, failed, failed], [wfRun(1), wfRun(2), wfRun(3)]);
    const out = await ciVerdict({ cwd: workspace({ retries: 2 }), sha: SHA, forge, wait: true, ...clock });
    expect(out.repeated?.workflowRun.attempt).toBe(3);
    expect(log.reruns).toEqual([70, 70]);
  });

  test("a failed job waits for its workflow run to finish before the re-run", async () => {
    const failed = [LINT, run(2, "test", "failure")];
    const { forge, clock, log } = scripted([failed, failed, failed, [LINT, run(3, "test", "success")]], [wfRun(1, "in_progress"), wfRun(1, "in_progress"), wfRun(1)]);
    const out = await ciVerdict({ cwd: workspace({ retries: 1 }), sha: SHA, forge, wait: true, ...clock });
    expect(out.verdict.verdict).toBe("pass");
    expect(log.reruns).toEqual([70]);
    // Said once, however long the run takes.
    expect(log.notes.filter((n) => n.includes("waiting for workflow run check to finish"))).toHaveLength(1);
  });

  test("a re-run GitHub hasn't started yet isn't asked for twice", async () => {
    const failed = [LINT, run(2, "test", "failure")];
    const { forge, clock, log } = scripted([failed, failed, failed, [LINT, run(3, "test", "success")]], [wfRun(1), wfRun(1), wfRun(2, "queued")]);
    expect((await ciVerdict({ cwd: workspace({ retries: 1 }), sha: SHA, forge, wait: true, ...clock })).verdict.verdict).toBe("pass");
    expect(log.reruns).toEqual([70]);
  });

  test("--retries overrides the setting", async () => {
    const { forge, clock, log } = scripted([[LINT, run(2, "test", "failure")], [LINT, run(3, "test", "success")]], [wfRun(1)]);
    expect((await ciVerdict({ cwd: workspace(true), sha: SHA, forge, wait: true, retries: 1, ...clock })).verdict.verdict).toBe("pass");
    expect(log.reruns).toEqual([70]);
  });

  test("retries 0 fails at the first failed job on the first read and asks nothing more, as before", async () => {
    for (const mq of [true, { retries: 0 }]) {
      const { forge, clock, log } = scripted([[LINT, run(2, "test", "failure")]], [wfRun(1)]);
      const out = await ciVerdict({ cwd: workspace(mq), sha: SHA, forge, wait: true, ...clock });
      expect(out.verdict).toMatchObject({ verdict: "fail", failure: { phase: "test", run: { name: "test" } } });
      expect(out.repeated).toBeUndefined();
      expect(log).toMatchObject({ reads: 1, runReads: 0, reruns: [], sleeps: [], notes: [] });
    }
    // And --retries 0 over a setting of 1.
    const { forge, clock, log } = scripted([[LINT, run(2, "test", "failure")]], [wfRun(1)]);
    expect((await ciVerdict({ cwd: workspace({ retries: 1 }), sha: SHA, forge, wait: true, retries: 0, ...clock })).verdict.verdict).toBe("fail");
    expect(log.reruns).toEqual([]);
  });

  test("without --wait it reads once and re-runs nothing", async () => {
    const { forge, log } = scripted([[LINT, run(2, "test", "failure")]], [wfRun(1)]);
    expect((await ciVerdict({ cwd: workspace({ retries: 1 }), sha: SHA, forge })).verdict.verdict).toBe("fail");
    expect(log).toMatchObject({ reads: 1, runReads: 0, reruns: [] });
  });

  test("a check run that is no Actions job fails at once: there is nothing to re-run", async () => {
    const { forge, clock, log } = scripted([[LINT, run(2, "test", "failure")]], [null]);
    const out = await ciVerdict({ cwd: workspace({ retries: 1 }), sha: SHA, forge, wait: true, ...clock });
    expect(out.verdict.verdict).toBe("fail");
    expect(out.repeated).toBeUndefined();
    expect(log.reruns).toEqual([]);
  });

  test("a refused re-run says the job needs actions: write", async () => {
    const { forge, clock } = scripted([[LINT, run(2, "test", "failure")]], [wfRun(1)]);
    forge.rerunFailedJobs = async () => {
      throw new ForgeApiError("POST", "https://api.github.com/repos/acme/app/actions/runs/70/rerun-failed-jobs", 403, "Resource not accessible by integration");
    };
    await expect(ciVerdict({ cwd: workspace({ retries: 1 }), sha: SHA, forge, wait: true, ...clock })).rejects.toThrow(/could not re-run the failed jobs of workflow run check \(70\).*needs actions: write/);
  });
});

describe("ci verdict --wait past forge errors (#4729)", () => {
  test("a 5xx that clears passes, after a backoff that doubles", async () => {
    const { forge, clock, log } = scripted([http(502), http(503), [LINT, run(2, "test", "success")]]);
    const out = await ciVerdict({ cwd: workspace(true), sha: SHA, forge, wait: true, ...clock });
    expect(out.verdict.verdict).toBe("pass");
    expect(log.sleeps).toEqual([CI_VERDICT_BACKOFF_MS, 2 * CI_VERDICT_BACKOFF_MS]);
    expect(log.notes[0]).toMatch(/^the forge failed \(GET .* answered 502\); looking again in 15s \(1 of 7 looked past\)$/);
  });

  test("a request with no answer is looked past too, and a 5xx while reading a workflow run", async () => {
    const failed = [LINT, run(2, "test", "failure")];
    const { forge, clock, log } = scripted([new TypeError("fetch failed"), failed, failed, [LINT, run(3, "test", "success")]], [http(500), wfRun(1)]);
    expect((await ciVerdict({ cwd: workspace({ retries: 1 }), sha: SHA, forge, wait: true, ...clock })).verdict.verdict).toBe("pass");
    expect(log.reruns).toEqual([70]);
  });

  test("errors that are not in a row each start the count again", async () => {
    const pending = [LINT, run(2, "test", null, "in_progress")];
    const answers: (CheckRun[] | Error)[] = [];
    for (let i = 0; i < CI_VERDICT_FORGE_ERRORS + 2; i++) answers.push(http(502), pending);
    answers.push([LINT, run(2, "test", "success")]);
    const { forge, clock } = scripted(answers);
    expect((await ciVerdict({ cwd: workspace(true), sha: SHA, forge, wait: true, ...clock })).verdict.verdict).toBe("pass");
  });

  test("a 5xx that doesn't clear fails at the bound, saying so", async () => {
    const { forge, clock, log } = scripted([http(502)]);
    const err = await ciVerdict({ cwd: workspace(true), sha: SHA, forge, wait: true, ...clock }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiVerdictGaveUpError);
    expect((err as Error).message).toMatch(new RegExp(`^the forge failed ${CI_VERDICT_FORGE_ERRORS} times in a row, the last: GET .* answered 502$`));
    expect(log.reads).toBe(CI_VERDICT_FORGE_ERRORS);
    expect(log.sleeps).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
  });

  test("a 4xx is an answer, not a blip: it fails at once, as before", async () => {
    const { forge, clock, log } = scripted([http(404)]);
    await expect(ciVerdict({ cwd: workspace(true), sha: SHA, forge, wait: true, ...clock })).rejects.toBeInstanceOf(ForgeApiError);
    expect(log.reads).toBe(1);
  });

  test("without --wait a 5xx fails at once, as before", async () => {
    const { forge, log } = scripted([http(502)]);
    await expect(ciVerdict({ cwd: workspace(true), sha: SHA, forge })).rejects.toBeInstanceOf(ForgeApiError);
    expect(log.reads).toBe(1);
  });
});

describe("ci verdict --wait --timeout-minutes (#4729)", () => {
  test("a run that never finishes gives up before the timeout, saying what it waited on", async () => {
    const { forge, clock, log } = scripted([[LINT, run(2, "test", null, "in_progress")]]);
    const err = await ciVerdict({ cwd: workspace(true), sha: SHA, forge, wait: true, timeoutMs: 10 * 60_000, ...clock }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CiVerdictGaveUpError);
    expect((err as Error).message).toBe("no verdict after 10 minutes: still waiting on test");
    expect(clock.now()).toBe(10 * 60_000);
    expect(log.sleeps.every((ms) => ms <= CI_VERDICT_INTERVAL_MS)).toBe(true);
    // It looked once more at the deadline before giving up.
    expect(log.reads).toBe(10 * 60_000 / CI_VERDICT_INTERVAL_MS + 1);
  });

  test("a re-run that never finishes gives up too, naming the run", async () => {
    const failed = [LINT, run(2, "test", "failure")];
    const { forge, clock } = scripted([failed], [wfRun(1), wfRun(2, "in_progress")]);
    await expect(ciVerdict({ cwd: workspace({ retries: 1 }), sha: SHA, forge, wait: true, timeoutMs: 5 * 60_000, ...clock })).rejects.toThrow("no verdict after 5 minutes: waiting for workflow run check to finish");
  });

  test("a forge that keeps failing gives up at the deadline when that comes first", async () => {
    const { forge, clock } = scripted([http(502)]);
    await expect(ciVerdict({ cwd: workspace(true), sha: SHA, forge, wait: true, timeoutMs: 60_000, ...clock })).rejects.toThrow(/^no verdict after 1 minute: the forge failing: GET .* answered 502$/);
    expect(clock.now()).toBe(60_000);
  });
});

describe("ci.green.mergeQueue's retries (#4729)", () => {
  const green = (mergeQueue: unknown) => parseDeclaration(JSON.stringify({ name: "w", schema: 1, members: [], ci: { green: { branch: "main", phases: { test: ["test"] }, require: ["test"], mergeQueue } } }), "chant.workspace.json").ci!.green!;

  test("true reads as no retries; the object as its retries; false as no merge queue", () => {
    expect(green(true).mergeQueue).toEqual({ retries: 0 });
    expect(green({ retries: 0 }).mergeQueue).toEqual({ retries: 0 });
    expect(green({ retries: 2 }).mergeQueue).toEqual({ retries: 2 });
    expect(green(false).mergeQueue).toBeUndefined();
  });

  test("retries is a whole number from 0 to 5, and nothing else is in the object", () => {
    for (const bad of [{ retries: -1 }, { retries: 6 }, { retries: 1.5 }, { retries: "1" }, {}, { retries: 1, extra: true }]) {
      expect(() => green(bad), JSON.stringify(bad)).toThrow();
    }
  });

  test("ci workflow without retries writes the verdict workflow as before", () => {
    const yaml = renderMergeQueueWorkflow({ green: green(true), chantVersion: "0.124.70", workspaceRoot: "." });
    expect(yaml).toBe(renderMergeQueueWorkflow({ green: green({ retries: 0 }), chantVersion: "0.124.70", workspaceRoot: "." }));
    const q = parseYAMLDocument(yaml) as { permissions: unknown; jobs: Record<string, { "timeout-minutes": number; steps: { run?: string }[] }> };
    expect(q.permissions).toEqual({ contents: "read", checks: "read" });
    expect(q.jobs[MERGE_QUEUE_VERDICT_JOB]!["timeout-minutes"]).toBe(120);
    expect(q.jobs[MERGE_QUEUE_VERDICT_JOB]!.steps.at(-1)!.run).toBe("npx --yes @intentius/chant@0.124.70 ci verdict --wait");
    expect(yaml).not.toContain("actions:");
    expect(yaml).not.toContain("re-run");
  });

  test("ci workflow with retries gives the job actions: write and a time budget under its timeout", () => {
    const yaml = renderMergeQueueWorkflow({ green: green({ retries: 1 }), chantVersion: "0.124.70", workspaceRoot: "." });
    const q = parseYAMLDocument(yaml) as { permissions: unknown; jobs: Record<string, { "timeout-minutes": number; steps: { run?: string }[] }> };
    expect(q.permissions).toEqual({ contents: "read", checks: "read", actions: "write" });
    const job = q.jobs[MERGE_QUEUE_VERDICT_JOB]!;
    expect(job.steps.at(-1)!.run).toBe(`npx --yes @intentius/chant@0.124.70 ci verdict --wait --timeout-minutes ${MERGE_QUEUE_VERDICT_TIMEOUT_MINUTES}`);
    expect(MERGE_QUEUE_VERDICT_TIMEOUT_MINUTES).toBeLessThan(job["timeout-minutes"]);
    expect(yaml).toContain("# A failed job's workflow run is re-run up to 1 time first (ci.green.mergeQueue.retries).");
    // --chant's command takes the same flag.
    const own = parseYAMLDocument(renderMergeQueueWorkflow({ green: green({ retries: 2 }), chantVersion: "0.124.70", workspaceRoot: ".", chant: "npx chant" })) as typeof q;
    expect(own.jobs[MERGE_QUEUE_VERDICT_JOB]!.steps.at(-1)!.run).toBe(`npx chant ci verdict --wait --timeout-minutes ${MERGE_QUEUE_VERDICT_TIMEOUT_MINUTES}`);
  });
});

describe("the GitHub client's workflow runs (#4729)", () => {
  function github(routes: Record<string, { status: number; body?: unknown }>) {
    const calls: string[] = [];
    const fetch: ForgeFetch = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      const r = routes[`${init.method} ${url}`] ?? { status: 404, body: { message: "Not Found" } };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)) };
    };
    return { forge: githubCiForge({ apiBase: "https://api.github.com", repo: "acme/app", token: "t", fetch }), calls };
  }
  const API = "https://api.github.com/repos/acme/app";

  test("a job's workflow run, its job read once and the run each time", async () => {
    const { forge, calls } = github({
      [`GET ${API}/actions/jobs/2`]: { status: 200, body: { id: 2, run_id: 70 } },
      [`GET ${API}/actions/runs/70`]: { status: 200, body: { id: 70, name: "check", run_attempt: 2, status: "completed", conclusion: "failure", html_url: "https://github.com/acme/app/actions/runs/70" } },
    });
    const expected = { id: 70, name: "check", attempt: 2, status: "completed", conclusion: "failure", url: "https://github.com/acme/app/actions/runs/70" };
    expect(await forge.workflowRun!(2)).toEqual(expected);
    expect(await forge.workflowRun!(2)).toEqual(expected);
    expect(calls).toEqual([`GET ${API}/actions/jobs/2`, `GET ${API}/actions/runs/70`, `GET ${API}/actions/runs/70`]);
  });

  test("another app's check run has no workflow run", async () => {
    expect(await github({}).forge.workflowRun!(5)).toBeNull();
  });

  test("a 5xx is thrown for the verdict to look past", async () => {
    const { forge } = github({ [`GET ${API}/actions/jobs/2`]: { status: 502 } });
    const err = await forge.workflowRun!(2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeApiError);
    expect(isTransientForgeError(err)).toBe(true);
  });

  test("re-running posts rerun-failed-jobs every time it's asked", async () => {
    const { forge, calls } = github({ [`POST ${API}/actions/runs/70/rerun-failed-jobs`]: { status: 201 } });
    await forge.rerunFailedJobs!(70);
    await forge.rerunFailedJobs!(70);
    expect(calls).toEqual([`POST ${API}/actions/runs/70/rerun-failed-jobs`, `POST ${API}/actions/runs/70/rerun-failed-jobs`]);
  });

  test("which errors say to look again", () => {
    expect([500, 502, 503, 504, 429].map((s) => isTransientForgeError(http(s)))).toEqual([true, true, true, true, true]);
    expect([400, 401, 403, 404, 422].map((s) => isTransientForgeError(http(s)))).toEqual([false, false, false, false, false]);
    expect(isTransientForgeError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientForgeError(new Error("something else"))).toBe(false);
  });
});

describe("chant ci verdict's flags (#4729)", () => {
  test("--retries and --timeout-minutes parse, and refuse what isn't a number", () => {
    expect(parseArgs(["ci", "verdict", "--wait", "--retries", "2", "--timeout-minutes", "85"])).toMatchObject({ command: "ci", path: "verdict", ciWait: true, ciRetries: 2, ciTimeoutMinutes: 85 });
    expect(() => parseArgs(["ci", "verdict", "--wait", "--retries", "-1"])).toThrow("--retries needs a whole number");
    expect(() => parseArgs(["ci", "verdict", "--wait", "--retries"])).toThrow("--retries needs a whole number");
    expect(() => parseArgs(["ci", "verdict", "--wait", "--timeout-minutes", "0"])).toThrow("--timeout-minutes needs a number of minutes above 0");
    expect(() => parseArgs(["ci", "verdict", "--wait", "--timeout-minutes", "soon"])).toThrow("--timeout-minutes needs a number of minutes above 0");
  });

  test("they go with --wait", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(workspace(true));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => void errors.push(m.map(String).join(" ")));
    expect(await runCiVerdict({ args: { command: "ci", path: "verdict", ciRetries: 1 } } as never)).toBe(1);
    expect(errors.join("\n")).toContain("--retries and --timeout-minutes go with --wait");
  });

  test("end to end against a fake GitHub: a failure that repeats exits 1 naming the phase, the job and the run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.spyOn(process, "cwd").mockReturnValue(workspace({ retries: 1 }));
    vi.stubEnv("GITHUB_REPOSITORY", "acme/app");
    vi.stubEnv("GITHUB_TOKEN", "t");
    vi.stubEnv("CHANT_FORGE_TOKEN", "t");
    vi.stubEnv("GITHUB_API_URL", "https://api.github.com");
    const API = "https://api.github.com/repos/acme/app";
    // GitHub: test fails on attempt 1; after the re-run, attempt 2's test fails too.
    let attempt = 1;
    const posts: string[] = [];
    const checkRun = (id: number, name: string, conclusion: string) => ({ id, name, status: "completed", conclusion, completed_at: "2026-11-06T10:00:00Z", html_url: `https://github.com/acme/app/runs/${id}` });
    const answer = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    vi.stubGlobal("fetch", (async (url: string, init: { method: string }) => {
      if (init.method === "POST") {
        posts.push(url);
        attempt = 2;
        return answer(201, {});
      }
      if (url.includes("/check-runs")) {
        const runs = [checkRun(1, "lint", "success"), checkRun(2, "test", "failure"), ...(attempt === 2 ? [checkRun(3, "test", "failure")] : [])];
        return answer(200, { total_count: runs.length, check_runs: runs });
      }
      if (url.startsWith(`${API}/actions/jobs/`)) return answer(200, { run_id: 70 });
      if (url === `${API}/actions/runs/70`) return answer(200, { id: 70, name: "check", run_attempt: attempt, status: "completed", conclusion: "failure", html_url: "https://github.com/acme/app/actions/runs/70" });
      return answer(404, { message: "Not Found" });
    }) as ForgeFetch);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => void errors.push(m.map(String).join(" ")));
    const exit = runCiVerdict({ args: { command: "ci", path: "verdict", commit: SHA, ciWait: true, ciTimeoutMinutes: 115 } } as never);
    await vi.runAllTimersAsync();
    expect(await exit).toBe(1);
    expect(posts).toEqual([`${API}/actions/runs/70/rerun-failed-jobs`]);
    expect(errors.at(-1)).toBe(`${SHA.slice(0, 12)}: phase test failed in test (failure) again on attempt 2 of workflow run check (https://github.com/acme/app/actions/runs/70)`);
  });
});
