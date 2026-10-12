/**
 * Which pull-request paths go over REST (#3798): a Forgejo or GitLab job
 * does, GitHub and a local run keep `gh`. Driven with an injected fetch.
 */

import { describe, expect, test } from "vitest";
import { ForgeEnvironmentError, type ForgeFetch } from "../../pr-forge";
import { remoteRepoPath, restPullRequestForge, upsertPullRequest } from "./forge-pull-request";

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

function fakeFetch(routes: Record<string, unknown>): { fetch: ForgeFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: ForgeFetch = async (url, init) => {
    calls.push({ method: init.method, url, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    const found = routes[`${init.method} ${new URL(url).pathname}`];
    if (found === undefined) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(found) };
  };
  return { fetch, calls };
}

const FORGEJO_JOB = {
  FORGEJO_ACTIONS: "true",
  GITHUB_SERVER_URL: "https://forge.example",
  GITHUB_API_URL: "https://forge.example/api/v1",
  GITHUB_REPOSITORY: "acme/infra",
  GITHUB_TOKEN: "tok",
};

describe("remoteRepoPath", () => {
  test("reads owner/name off https, ssh and scp-style remotes", () => {
    expect(remoteRepoPath("https://forge.example/acme/infra.git")).toBe("acme/infra");
    expect(remoteRepoPath("ssh://git@forge.example:2222/acme/infra.git")).toBe("acme/infra");
    expect(remoteRepoPath("git@gitlab.com:group/sub/infra.git")).toBe("group/sub/infra");
    expect(remoteRepoPath("https://forge.example/")).toBeUndefined();
    expect(remoteRepoPath(undefined)).toBeUndefined();
  });
});

describe("restPullRequestForge", () => {
  test("GitHub and a run outside CI keep gh", async () => {
    expect(await restPullRequestForge({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t" })).toBeUndefined();
    expect(await restPullRequestForge({})).toBeUndefined();
  });

  test("a Forgejo job opens over REST, on the repository the checkout's remote names", async () => {
    const { fetch, calls } = fakeFetch({ "POST /api/v1/repos/acme/other/pulls": { number: 3, html_url: "https://forge.example/acme/other/pulls/3" } });
    const forge = await restPullRequestForge(FORGEJO_JOB, { cwd: "/wt", fetch, remoteUrl: async () => "https://forge.example/acme/other.git" });
    expect(forge?.kind).toBe("forgejo");
    expect((await forge!.openPullRequest({ head: "h", base: "main", title: "t", body: "b" })).url).toBe("https://forge.example/acme/other/pulls/3");
    expect(calls[0].url).toBe("https://forge.example/api/v1/repos/acme/other/pulls");
  });

  test("a remote on another host leaves the job's repository", async () => {
    const { fetch, calls } = fakeFetch({ "POST /api/v1/repos/acme/infra/pulls": { number: 1 } });
    const forge = await restPullRequestForge(FORGEJO_JOB, { cwd: "/wt", fetch, remoteUrl: async () => "https://github.com/acme/mirror.git" });
    await forge!.openPullRequest({ head: "h", base: "main", title: "t", body: "b" });
    expect(calls[0].url).toBe("https://forge.example/api/v1/repos/acme/infra/pulls");
  });

  test("a GitLab job opens a merge request; a Forgejo job with no token is refused by name", async () => {
    const forge = await restPullRequestForge({ GITLAB_CI: "true", CI_API_V4_URL: "https://gl/api/v4", CI_PROJECT_ID: "42", GITLAB_TOKEN: "t" });
    expect(forge?.kind).toBe("gitlab");
    const { GITHUB_TOKEN: _, ...noToken } = FORGEJO_JOB;
    await expect(restPullRequestForge(noToken)).rejects.toBeInstanceOf(ForgeEnvironmentError);
  });
});

describe("upsertPullRequest", () => {
  const open = { number: 10, title: "t", body: "b", head: { ref: "h", repo: { full_name: "acme/infra" } }, html_url: "https://forge.example/acme/infra/pulls/10" };

  test("opens one when none is open, edits the open one, leaves a current one alone", async () => {
    const env = FORGEJO_JOB;
    const none = fakeFetch({ "GET /api/v1/repos/acme/infra/pulls": [], "POST /api/v1/repos/acme/infra/pulls": { number: 11 } });
    expect((await upsertPullRequest((await restPullRequestForge(env, { fetch: none.fetch }))!, { head: "h", base: "main", title: "t", body: "b" })).action).toBe("opened");

    const stale = fakeFetch({ "GET /api/v1/repos/acme/infra/pulls": [open], "PATCH /api/v1/repos/acme/infra/pulls/10": { ...open, title: "t2" } });
    const r = await upsertPullRequest((await restPullRequestForge(env, { fetch: stale.fetch }))!, { head: "h", base: "main", title: "t2", body: "b" });
    expect(r).toMatchObject({ action: "updated", pr: { number: 10, title: "t2", url: open.html_url } });
    expect(stale.calls.at(-1)).toMatchObject({ method: "PATCH", body: { title: "t2", body: "b" } });

    const current = fakeFetch({ "GET /api/v1/repos/acme/infra/pulls": [open] });
    expect((await upsertPullRequest((await restPullRequestForge(env, { fetch: current.fetch }))!, { head: "h", title: "t", body: "b\n" })).action).toBe("unchanged");
    expect(current.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
