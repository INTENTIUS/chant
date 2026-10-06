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
