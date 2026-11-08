/**
 * The forge reads beside the clients (#4809), driven through a recording
 * `fetch`: the calls each makes on GitHub, Forgejo and GitLab, and what each
 * reads back.
 */

import { describe, expect, test } from "vitest";
import { ForgeApiError, type ForgeFetch } from "./pr-forge";
import { forgejoReads, forgeReadsFor, githubReads, gitlabReads } from "./pr-forge-reads";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** A fake forge: `routes` maps `METHOD path-without-query` (optionally `?page=N`) to a response body, or a status. */
function fakeFetch(routes: Record<string, unknown>): { fetch: ForgeFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: ForgeFetch = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers });
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    const page = Number(u.searchParams.get("page") ?? "1");
    const found = routes[`${key}?page=${page}`] ?? routes[key];
    if (found === undefined) return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
    if (typeof found === "number") return { ok: false, status: found, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(found) };
  };
  return { fetch, calls };
}

const SHA = "a".repeat(40);
const MERGED = "m".repeat(40);
const urls = (calls: Call[]) => calls.map((c) => `${c.method} ${c.url}`);

describe("github", () => {
  const opts = { apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k" };

  test("names the token's user", async () => {
    const { fetch, calls } = fakeFetch({ "GET /user": { login: "tg-bot", id: 7 } });
    expect(await githubReads({ ...opts, fetch }).tokenUser()).toEqual({ login: "tg-bot", id: 7 });
    expect(urls(calls)).toEqual(["GET https://api.github.com/user"]);
    expect(calls[0]!.headers.Authorization).toBe("Bearer t0k");
  });

  test("reads a merged pull request's author, URL and merge commit, and undefined for a missing one", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/infra/pulls/12": {
        number: 12,
        title: "t",
        body: "b",
        state: "closed",
        merged: true,
        merge_commit_sha: MERGED,
        html_url: "https://github.com/acme/infra/pull/12",
        user: { login: "alice" },
        head: { ref: "feat", sha: SHA, repo: { full_name: "acme/infra" } },
        base: { ref: "main" },
        updated_at: "2026-11-08T00:00:00Z",
      },
    });
    const reads = githubReads({ ...opts, fetch });
    expect(await reads.pullRequest(12)).toEqual({
      number: 12,
      title: "t",
      body: "b",
      state: "merged",
      head: "feat",
      headSha: SHA,
      base: "main",
      author: "alice",
      url: "https://github.com/acme/infra/pull/12",
      sameRepo: true,
      mergeCommit: MERGED,
      updated: "2026-11-08T00:00:00Z",
    });
    expect(await reads.pullRequest(13)).toBeUndefined();
  });

  test("finds the pull requests from a branch in any state, newest first, and filters the head server-side", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/pulls": [
        { number: 3, state: "closed", head: { ref: "wave/1" } },
        { number: 9, state: "open", head: { ref: "wave/1" } },
        { number: 5, state: "open", head: { ref: "wave/1", repo: { full_name: "fork/infra" } } },
      ],
    });
    const got = await githubReads({ ...opts, fetch }).pullRequestsFrom("wave/1");
    expect(got.map((p) => [p.number, p.state])).toEqual([
      [9, "open"],
      [3, "closed"],
    ]);
    expect(urls(calls)).toEqual(["GET https://api.github.com/repos/acme/infra/pulls?state=all&head=acme%3Awave%2F1&per_page=100&page=1"]);
  });

  test("lists the pull requests whose head starts with a prefix, newest update first, up to the limit", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: 1000 - i, state: "closed", head: { ref: i % 2 ? "other" : `rollout/${i}` } }));
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/pulls?page=1": page1,
      "GET /repos/acme/infra/pulls?page=2": [{ number: 1, state: "open", head: { ref: "rollout/late" } }],
    });
    const got = await githubReads({ ...opts, fetch }).pullRequestsFrom("rollout/", { prefix: true, limit: 100 });
    expect(got).toHaveLength(50);
    expect(got[0]!.head).toBe("rollout/0");
    expect(urls(calls)).toEqual(["GET https://api.github.com/repos/acme/infra/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1"]);
  });

  test("reads every comment with its author, across pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `c${i}`, user: { login: "bob", id: 2 } }));
    const { fetch } = fakeFetch({
      "GET /repos/acme/infra/issues/12/comments?page=1": page1,
      "GET /repos/acme/infra/issues/12/comments?page=2": [{ id: 500, body: "marker", user: { login: "tg-bot", id: 7 }, created_at: "2026-11-08T00:00:00Z" }],
    });
    const notes = await githubReads({ ...opts, fetch }).pullRequestNotes(12);
    expect(notes).toHaveLength(101);
    expect(notes.at(-1)).toEqual({ id: 500, body: "marker", author: "tg-bot", authorId: 7, system: false, created: "2026-11-08T00:00:00Z" });
  });

  test("reads the newest check run per name", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET /repos/acme/infra/commits/${SHA}/check-runs`]: {
        total_count: 3,
        check_runs: [
          { id: 1, name: "apply/net", status: "completed", conclusion: "failure" },
          { id: 4, name: "apply/net", status: "completed", conclusion: "success" },
          { id: 2, name: "lint", status: "in_progress", conclusion: null },
        ],
      },
    });
    expect(await githubReads({ ...opts, fetch }).checkRuns(SHA)).toEqual([
      { id: 4, name: "apply/net", status: "completed", conclusion: "success" },
      { id: 2, name: "lint", status: "in_progress" },
    ]);
    expect(urls(calls)).toEqual([`GET https://api.github.com/repos/acme/infra/commits/${SHA}/check-runs?per_page=100&page=1`]);
  });

  test("reads a pull request's commits with their authors and committers", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/infra/pulls/12/commits": [
        {
          sha: SHA,
          commit: { message: "fix\n\nRequested-by: carol", author: { name: "Al", email: "al@x.io" }, committer: { name: "GitHub", email: "noreply@github.com" } },
          author: { login: "alice" },
          committer: { login: "web-flow" },
        },
      ],
    });
    expect(await githubReads({ ...opts, fetch }).pullRequestCommits(12)).toEqual([
      { sha: SHA, message: "fix\n\nRequested-by: carol", author: { name: "Al", email: "al@x.io", login: "alice" }, committer: { name: "GitHub", email: "noreply@github.com", login: "web-flow" } },
    ]);
  });

  test("names a collaborator's permission level, and undefined for a stranger", async () => {
    const { fetch } = fakeFetch({ "GET /repos/acme/infra/collaborators/alice/permission": { permission: "triage" } });
    const reads = githubReads({ ...opts, fetch });
    expect(await reads.permission("alice")).toBe("triage");
    expect(await reads.permission("mallory")).toBeUndefined();
  });

  test("lists every open pull request, into any base", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/pulls": [
        { number: 8, user: { login: "bob" }, head: { ref: "b", sha: SHA, repo: { full_name: "bob/infra" } }, base: { ref: "release", sha: MERGED } },
        { number: 4, user: { login: "al" }, head: { ref: "a", sha: SHA }, base: { ref: "main" } },
      ],
    });
    expect(await githubReads({ ...opts, fetch }).openPullRequests()).toEqual([
      { number: 4, head: "a", headSha: SHA, base: "main", author: "al", fork: false },
      { number: 8, head: "b", headSha: SHA, base: "release", baseSha: MERGED, author: "bob", fork: true },
    ]);
    expect(urls(calls)).toEqual(["GET https://api.github.com/repos/acme/infra/pulls?state=open&per_page=100&page=1"]);
  });

  test("a forge error other than 404 throws a ForgeApiError", async () => {
    const { fetch } = fakeFetch({ "GET /repos/acme/infra/pulls/12": 500 });
    await expect(githubReads({ ...opts, fetch }).pullRequest(12)).rejects.toBeInstanceOf(ForgeApiError);
  });
});

describe("forgejo", () => {
  const opts = { apiBase: "https://code.acme.io/api/v1", repo: "acme/infra", token: "t0k", host: "code.acme.io" };

  test("matches a branch's pull requests over pages, with token auth", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ number: 100 + i, state: "closed", head: { ref: `x${i}` } }));
    const { fetch, calls } = fakeFetch({
      "GET /api/v1/repos/acme/infra/pulls?page=1": page1,
      "GET /api/v1/repos/acme/infra/pulls?page=2": [{ number: 7, state: "closed", merged: true, merge_commit_sha: MERGED, head: { ref: "wave/1" } }],
    });
    const got = await forgejoReads({ ...opts, fetch }).pullRequestsFrom("wave/1");
    expect(got.map((p) => [p.number, p.state, p.mergeCommit])).toEqual([[7, "merged", MERGED]]);
    expect(urls(calls)).toEqual([
      "GET https://code.acme.io/api/v1/repos/acme/infra/pulls?state=all&sort=recentupdate&limit=50&page=1",
      "GET https://code.acme.io/api/v1/repos/acme/infra/pulls?state=all&sort=recentupdate&limit=50&page=2",
    ]);
    expect(calls[0]!.headers.Authorization).toBe("token t0k");
  });

  test("an empty repository's 404 list is no pull request", async () => {
    const { fetch } = fakeFetch({ "GET /api/v1/repos/acme/infra": { empty: true } });
    expect(await forgejoReads({ ...opts, fetch }).pullRequestsFrom("wave/", { prefix: true })).toEqual([]);
  });

  test("has no check runs", async () => {
    const { fetch, calls } = fakeFetch({});
    expect(await forgejoReads({ ...opts, fetch }).checkRuns(SHA)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("gitlab", () => {
  const opts = { apiBase: "https://gitlab.com/api/v4", project: "acme/infra", token: "glpat" };
  const P = "/api/v4/projects/acme%2Finfra";

  test("names the token's user by username and id", async () => {
    const { fetch, calls } = fakeFetch({ "GET /api/v4/user": { username: "project_1_bot", id: 41 } });
    expect(await gitlabReads({ ...opts, fetch }).tokenUser()).toEqual({ login: "project_1_bot", id: 41 });
    expect(calls[0]!.headers["PRIVATE-TOKEN"]).toBe("glpat");
  });

  test("reads a merge request, its merge commit falling back to squash and then head", async () => {
    const mr = { iid: 5, title: "t", description: "d", state: "merged", sha: SHA, source_branch: "feat", target_branch: "main", web_url: "https://gitlab.com/acme/infra/-/merge_requests/5", author: { username: "alice" }, source_project_id: 1, target_project_id: 1 };
    const { fetch } = fakeFetch({ [`GET ${P}/merge_requests/5`]: { ...mr, merge_commit_sha: null, squash_commit_sha: null } });
    expect(await gitlabReads({ ...opts, fetch }).pullRequest(5)).toMatchObject({ number: 5, state: "merged", author: "alice", url: mr.web_url, mergeCommit: SHA, sameRepo: true });
    const squashed = fakeFetch({ [`GET ${P}/merge_requests/5`]: { ...mr, squash_commit_sha: MERGED } });
    expect((await gitlabReads({ ...opts, fetch: squashed.fetch }).pullRequest(5))?.mergeCommit).toBe(MERGED);
  });

  test("finds the merge requests from a branch in any state, a fork's left out", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${P}/merge_requests`]: [
        { iid: 2, state: "opened", source_branch: "wave/1", source_project_id: 1, target_project_id: 1 },
        { iid: 3, state: "opened", source_branch: "wave/1", source_project_id: 9, target_project_id: 1 },
        { iid: 1, state: "closed", source_branch: "wave/1" },
      ],
    });
    expect((await gitlabReads({ ...opts, fetch }).pullRequestsFrom("wave/1")).map((m) => [m.number, m.state])).toEqual([
      [2, "open"],
      [1, "closed"],
    ]);
    expect(urls(calls)).toEqual([`GET https://gitlab.com${P}/merge_requests?state=all&source_branch=wave%2F1&order_by=updated_at&sort=desc&per_page=100&page=1`]);
  });

  test("reads every note, system notes marked", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${P}/merge_requests/5/notes`]: [
        { id: 1, body: "approved this merge request", system: true, author: { username: "project_1_bot", id: 41 } },
        { id: 2, body: "<!-- marker -->", system: false, author: { username: "project_1_bot", id: 41 } },
      ],
    });
    const notes = await gitlabReads({ ...opts, fetch }).pullRequestNotes(5);
    expect(notes.map((n) => [n.id, n.system, n.authorId])).toEqual([
      [1, true, 41],
      [2, false, 41],
    ]);
    expect(urls(calls)).toEqual([`GET https://gitlab.com${P}/merge_requests/5/notes?sort=asc&order_by=created_at&per_page=100&page=1`]);
  });

  test("reads a merge request's commits", async () => {
    const { fetch } = fakeFetch({ [`GET ${P}/merge_requests/5/commits`]: [{ id: SHA, message: "m", author_name: "Al", author_email: "al@x.io", committer_email: "c@x.io" }] });
    expect(await gitlabReads({ ...opts, fetch }).pullRequestCommits(5)).toEqual([{ sha: SHA, message: "m", author: { name: "Al", email: "al@x.io" }, committer: { email: "c@x.io" } }]);
  });

  test("names a member's role by the access level, and undefined for a stranger", async () => {
    const { fetch } = fakeFetch({ "GET /api/v4/users": [{ id: 3, username: "alice" }], [`GET ${P}/members/all/3`]: { access_level: 30 } });
    expect(await gitlabReads({ ...opts, fetch }).permission("alice")).toBe("developer");
    const none = fakeFetch({ "GET /api/v4/users": [] });
    expect(await gitlabReads({ ...opts, fetch: none.fetch }).permission("mallory")).toBeUndefined();
  });

  test("lists every open merge request, into any target", async () => {
    const { fetch } = fakeFetch({
      [`GET ${P}/merge_requests`]: [{ iid: 4, source_branch: "a", sha: SHA, target_branch: "release", author: { username: "al" }, diff_refs: { base_sha: MERGED }, source_project_id: 1, target_project_id: 1 }],
    });
    expect(await gitlabReads({ ...opts, fetch }).openPullRequests()).toEqual([{ number: 4, head: "a", headSha: SHA, base: "release", baseSha: MERGED, author: "al", fork: false }]);
  });
});

test("forgeReadsFor builds the reads for a target", async () => {
  const { fetch, calls } = fakeFetch({ "GET /api/v4/user": { username: "bot", id: 1 } });
  const reads = forgeReadsFor({ kind: "gitlab", apiBase: "https://gitlab.com/api/v4", repo: "42", host: "gitlab.com", token: "cj", tokenSource: "CI_JOB_TOKEN", tokenHeader: "JOB-TOKEN" }, fetch);
  expect(reads.kind).toBe("gitlab");
  expect(await reads.tokenUser()).toEqual({ login: "bot", id: 1 });
  expect(calls[0]!.headers["JOB-TOKEN"]).toBe("cj");
});
