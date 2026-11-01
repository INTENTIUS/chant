/**
 * Work items from the forge (#4649): which forge and token a read finds, one
 * call per pull request, and an answer without the forge when it can't be
 * read. Driven through a recording `fetch`; nothing here reaches a network.
 */

import { describe, expect, test } from "vitest";
import type { ForgeFetch } from "../pr-forge";
import { forgeApiBase, forgeKindOfHost, forgeWorkReader, setCommitCloses } from "./forge-work";

/** A GitHub GraphQL endpoint that says pull request `n` closes `closes[n]`; any other is not found. */
function github(closes: Record<number, number[]>): { fetch: ForgeFetch; calls: { url: string; pr: number; auth: string | undefined }[] } {
  const calls: { url: string; pr: number; auth: string | undefined }[] = [];
  const fetch: ForgeFetch = async (url, init) => {
    const pr = (JSON.parse(init.body ?? "{}") as { variables: { pr: number } }).variables.pr;
    calls.push({ url, pr, auth: init.headers.Authorization });
    const issues = closes[pr];
    const body = issues
      ? { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: issues.map((number) => ({ number, repository: { nameWithOwner: "acme/app" } })) } } } } }
      : { data: { repository: { pullRequest: null } }, errors: [{ message: `Could not resolve to a PullRequest with the number of ${pr}.` }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

const top = "/nowhere";
const remoteUrl = "git@github.com:acme/app.git";

describe("forgeWorkReader", () => {
  test("asks GitHub once per pull request, with the token the environment names", async () => {
    const { fetch, calls } = github({ 12: [70, 71], 13: [] });
    const reader = forgeWorkReader(top, { env: { GH_TOKEN: "t0k" }, remoteUrl, fetch });
    expect(reader.source).toEqual({ kind: "github", host: "github.com", repo: "acme/app" });
    const all = await reader.closesAll([12, 13, 12]);
    expect(all.get(12)).toEqual({ resolved: true, issues: [70, 71], reason: null });
    expect(all.get(13)).toEqual({ resolved: true, issues: [], reason: null });
    expect(await reader.closes(12)).toEqual({ resolved: true, issues: [70, 71], reason: null });
    expect(calls.map((c) => c.pr).sort()).toEqual([12, 13]);
    expect(calls[0]).toMatchObject({ url: "https://api.github.com/graphql", auth: "Bearer t0k" });
  });

  test("without a token every pull request is unresolved and the forge is never called", async () => {
    const { fetch, calls } = github({ 12: [70] });
    const reader = forgeWorkReader(top, { env: {}, remoteUrl, fetch, ghToken: () => undefined });
    const got = await reader.closes(12);
    expect(got).toMatchObject({ resolved: false, issues: [] });
    expect(got.reason).toMatch(/^no token for github\.com: set CHANT_FORGE_TOKEN, CHANT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, or log in with gh auth login$/);
    expect(calls).toEqual([]);
  });

  test("falls back to the token gh holds for the host", async () => {
    const { fetch, calls } = github({ 12: [70] });
    const hosts: string[] = [];
    const reader = forgeWorkReader(top, { env: {}, remoteUrl: "https://ghe.github.acme.io/acme/app.git", fetch, ghToken: (h) => (hosts.push(h), "from-gh") });
    expect(await reader.closes(12)).toMatchObject({ resolved: true, issues: [70] });
    expect(hosts).toEqual(["ghe.github.acme.io"]);
    expect(calls[0]).toMatchObject({ url: "https://ghe.github.acme.io/api/graphql", auth: "Bearer from-gh" });
  });

  test("a pull request the forge doesn't know is unresolved, and the next is still asked", async () => {
    const { fetch, calls } = github({ 13: [5] });
    const reader = forgeWorkReader(top, { env: { GITHUB_TOKEN: "t" }, remoteUrl, fetch });
    expect((await reader.closes(12)).reason).toMatch(/Could not resolve to a PullRequest/);
    expect(await reader.closes(13)).toMatchObject({ resolved: true, issues: [5] });
    expect(calls).toHaveLength(2);
  });

  test("offline, the first failure answers the rest without another call", async () => {
    let calls = 0;
    const fetch: ForgeFetch = async () => {
      calls++;
      throw new TypeError("fetch failed");
    };
    const reader = forgeWorkReader(top, { env: { GITHUB_TOKEN: "t" }, remoteUrl, fetch });
    const first = await reader.closes(12);
    expect(first).toEqual({ resolved: false, issues: [], reason: "github.com could not be read: fetch failed" });
    expect(await reader.closes(13)).toEqual(first);
    expect(calls).toBe(1);
  });

  test("a 401 stops the rest too", async () => {
    let calls = 0;
    const fetch: ForgeFetch = async () => (calls++, { ok: false, status: 401, text: async () => "Bad credentials" });
    const reader = forgeWorkReader(top, { env: { GITHUB_TOKEN: "t" }, remoteUrl, fetch });
    expect((await reader.closes(12)).reason).toMatch(/answered 401/);
    expect((await reader.closes(13)).reason).toMatch(/answered 401/);
    expect(calls).toBe(1);
  });

  test("a call that never answers times out", async () => {
    const fetch: ForgeFetch = () => new Promise(() => {});
    const reader = forgeWorkReader(top, { env: { GITHUB_TOKEN: "t" }, remoteUrl, fetch, timeoutMs: 20 });
    expect(await reader.closes(12)).toMatchObject({ resolved: false, reason: "github.com could not be read: no answer in 0.02s" });
  });

  test("an origin on no forge it knows, or none, is unresolved with why", async () => {
    expect((await forgeWorkReader(top, { env: { GITHUB_TOKEN: "t" }, remoteUrl: "https://git.example.org/a/b.git" }).closes(1)).reason).toBe(
      "origin (https://git.example.org/a/b.git) is not on a forge chant reads issues from: GitHub, GitLab or Forgejo",
    );
    const none = forgeWorkReader(top, { env: {}, remoteUrl: null });
    expect(none.source).toBeNull();
    expect((await none.closes(1)).reason).toBe("there is no origin remote to name the forge");
  });

  test("in a CI job it reads the job's forge and repository", async () => {
    const { fetch, calls } = github({ 3: [1] });
    const reader = forgeWorkReader(top, { env: { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app", GITHUB_TOKEN: "job" }, remoteUrl: "https://example.org/x/y", fetch });
    expect(reader.source).toEqual({ kind: "github", host: "github.com", repo: "acme/app" });
    expect(await reader.closes(3)).toMatchObject({ resolved: true, issues: [1] });
    expect(calls[0].auth).toBe("Bearer job");
  });

  test("GitLab and Forgejo origins get their own REST base and token order", async () => {
    const urls: string[] = [];
    const fetch: ForgeFetch = async (url) => (urls.push(url), { ok: true, status: 200, text: async () => (url.includes("gitlab") ? "[]" : '{"body":"fixes #4"}') });
    expect(await forgeWorkReader(top, { env: { GITLAB_TOKEN: "g" }, remoteUrl: "git@gitlab.com:grp/sub/app.git", fetch }).closes(5)).toMatchObject({ resolved: true, issues: [] });
    expect(await forgeWorkReader(top, { env: { FORGEJO_TOKEN: "f" }, remoteUrl: "https://codeberg.org/acme/app", fetch }).closes(6)).toMatchObject({ resolved: true, issues: [4] });
    expect(urls).toEqual([
      "https://gitlab.com/api/v4/projects/grp%2Fsub%2Fapp/merge_requests/5/closes_issues?per_page=100&page=1",
      "https://codeberg.org/api/v1/repos/acme/app/pulls/6",
    ]);
  });
});

describe("setCommitCloses", () => {
  test("sets closes on each commit with a pull request, asking once per pull request, and null on the rest", async () => {
    const { fetch, calls } = github({ 4: [9] });
    const commits: { pullRequest: number | null; closes?: unknown }[] = [{ pullRequest: 4 }, { pullRequest: null }, { pullRequest: 4 }];
    await setCommitCloses(commits as { pullRequest: number | null }[], forgeWorkReader(top, { env: { GH_TOKEN: "t" }, remoteUrl, fetch }));
    expect(commits.map((c) => c.closes)).toEqual([{ resolved: true, issues: [9], reason: null }, null, { resolved: true, issues: [9], reason: null }]);
    expect(calls).toHaveLength(1);
  });
});

describe("forgeKindOfHost and forgeApiBase", () => {
  test("name a host's forge and its REST base", () => {
    expect(["github.com", "github.acme.io", "gitlab.com", "gitlab.acme.io", "codeberg.org", "forgejo.acme.io", "git.acme.io"].map(forgeKindOfHost)).toEqual(["github", "github", "gitlab", "gitlab", "forgejo", "forgejo", null]);
    expect(forgeApiBase("github", "github.com")).toBe("https://api.github.com");
    expect(forgeApiBase("github", "ghe.acme.io")).toBe("https://ghe.acme.io/api/v3");
    expect(forgeApiBase("gitlab", "gitlab.acme.io")).toBe("https://gitlab.acme.io/api/v4");
    expect(forgeApiBase("forgejo", "codeberg.org")).toBe("https://codeberg.org/api/v1");
  });
});
