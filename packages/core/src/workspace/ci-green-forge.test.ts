/**
 * #3573 — the check-run client `chant ci tick` reads, driven through a
 * recording `fetch` with no network.
 */

import { describe, expect, test } from "vitest";
import { ForgeApiError, ForgeEnvironmentError, type ForgeFetch } from "../pr-forge";
import { ciForgeFromEnv, CiForgeUnsupportedError, githubCiForge } from "./ci-green-forge";

const SHA = "a".repeat(40);

function fakeFetch(pages: Record<number, unknown> | number): { fetch: ForgeFetch; urls: string[]; headers: Record<string, string>[] } {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetch: ForgeFetch = async (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    if (typeof pages === "number") return { ok: false, status: pages, text: async () => '{"message":"nope"}' };
    const page = Number(new URL(url).searchParams.get("page"));
    return { ok: true, status: 200, text: async () => JSON.stringify(pages[page] ?? { total_count: 0, check_runs: [] }) };
  };
  return { fetch, urls, headers };
}

const apiRun = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `job ${id}`,
  status: "completed",
  conclusion: "success",
  started_at: "2026-10-06T10:00:00Z",
  completed_at: "2026-10-06T10:05:00Z",
  html_url: `https://github.com/acme/app/runs/${id}`,
  ...extra,
});

describe("the GitHub check-run client (#3573)", () => {
  test("reads every attempt across pages", async () => {
    const first = Array.from({ length: 100 }, (_, i) => apiRun(i + 1));
    const { fetch, urls, headers } = fakeFetch({
      1: { total_count: 101, check_runs: first },
      2: { total_count: 101, check_runs: [apiRun(101, { status: "in_progress", conclusion: null, completed_at: null })] },
    });
    const runs = await githubCiForge({ apiBase: "https://api.github.com/", repo: "acme/app", token: "t0k", fetch }).checkRuns(SHA);
    expect(urls).toEqual([
      `https://api.github.com/repos/acme/app/commits/${SHA}/check-runs?filter=all&per_page=100&page=1`,
      `https://api.github.com/repos/acme/app/commits/${SHA}/check-runs?filter=all&per_page=100&page=2`,
    ]);
    expect(headers[0].Authorization).toBe("Bearer t0k");
    expect(runs).toHaveLength(101);
    expect(runs[0]).toEqual({ id: 1, name: "job 1", status: "completed", conclusion: "success", completedAt: "2026-10-06T10:05:00Z", url: "https://github.com/acme/app/runs/1" });
    expect(runs[100]).toMatchObject({ id: 101, status: "in_progress", conclusion: null });
  });

  test("an error status is an error, not an empty list", async () => {
    const { fetch } = fakeFetch(403);
    await expect(githubCiForge({ apiBase: "https://api.github.com", repo: "acme/app", token: "t", fetch }).checkRuns(SHA)).rejects.toBeInstanceOf(ForgeApiError);
  });

  test("comes from the job's environment, and refuses the forges with no check-run client yet", () => {
    const { fetch } = fakeFetch({});
    expect(ciForgeFromEnv("github", { GITHUB_REPOSITORY: "acme/app", GITHUB_TOKEN: "t" }, fetch).kind).toBe("github");
    expect(() => ciForgeFromEnv("github", { GITHUB_TOKEN: "t" })).toThrow(ForgeEnvironmentError);
    expect(() => ciForgeFromEnv("gitlab", {})).toThrow(CiForgeUnsupportedError);
    expect(() => ciForgeFromEnv("forgejo", {})).toThrow(/GitHub only/);
  });
});

describe("re-running a failed check run (#4219)", () => {
  const run = (id: number) => ({ id, name: "suites", status: "completed", conclusion: "failure", completedAt: null, url: null });
  const forgeWith = (jobs: Record<number, unknown>) => {
    const calls: string[] = [];
    const fetch: ForgeFetch = async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      const m = /\/actions\/jobs\/(\d+)$/.exec(new URL(url).pathname);
      if (init.method === "GET" && m) return { ok: true, status: 200, text: async () => JSON.stringify(jobs[Number(m[1])] ?? {}) };
      return { ok: true, status: 201, text: async () => "" };
    };
    return { forge: githubCiForge({ apiBase: "https://api.github.com", repo: "acme/app", token: "t", fetch }), calls };
  };

  test("re-runs the failed jobs of the job's workflow run, so an aggregate's shards go again with it, once per run", async () => {
    const { forge, calls } = forgeWith({ 7: { id: 7, run_id: 500 }, 8: { id: 8, run_id: 500 } });
    await forge.rerun!(run(7));
    await forge.rerun!(run(8));
    expect(calls).toEqual([
      "GET /repos/acme/app/actions/jobs/7",
      "POST /repos/acme/app/actions/runs/500/rerun-failed-jobs",
      "GET /repos/acme/app/actions/jobs/8",
    ]);
  });

  test("falls back to the job's own re-run when the job names no workflow run", async () => {
    const { forge, calls } = forgeWith({ 9: { id: 9 } });
    await forge.rerun!(run(9));
    expect(calls).toEqual(["GET /repos/acme/app/actions/jobs/9", "POST /repos/acme/app/actions/jobs/9/rerun"]);
  });
});
