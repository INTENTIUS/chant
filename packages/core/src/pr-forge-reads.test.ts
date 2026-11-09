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

describe("workflow runs, jobs and artifacts (#4846)", () => {
  const gh = { apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k" };
  const fj = { apiBase: "https://code.acme.io/api/v1", repo: "acme/infra", token: "t0k", host: "code.acme.io" };
  const gl = { apiBase: "https://gitlab.com/api/v4", project: "acme/infra", token: "glpat" };
  const P = "/api/v4/projects/acme%2Finfra";
  const OTHER = "b".repeat(40);

  test("github: a head's runs of an event, newest first, with their pull requests", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/actions/runs": {
        total_count: 3,
        workflow_runs: [
          { id: 10, event: "pull_request", head_sha: SHA, head_branch: "feat", path: ".github/workflows/pipeline.yml@refs/heads/feat", status: "completed", conclusion: "success", head_repository: { full_name: "acme/infra" }, pull_requests: [{ number: 12, head: { ref: "feat", sha: SHA }, base: { ref: "main" } }] },
          { id: 11, event: "pull_request", head_sha: SHA, path: ".github/workflows/pipeline.yml", status: "in_progress", pull_requests: [] },
          { id: 12, event: "pull_request", head_sha: OTHER, status: "completed" },
        ],
      },
    });
    const runs = await githubReads({ ...gh, fetch }).headRuns(SHA, { event: "pull_request" });
    expect(runs.map((r) => [r.id, r.done])).toEqual([
      [11, false],
      [10, true],
    ]);
    expect(runs[1]).toEqual({
      id: 10,
      event: "pull_request",
      workflow: "pipeline.yml",
      path: ".github/workflows/pipeline.yml",
      headSha: SHA,
      headBranch: "feat",
      headRepo: "acme/infra",
      status: "completed",
      conclusion: "success",
      done: true,
      pullRequests: [{ number: 12, head: "feat", headSha: SHA, base: "main" }],
    });
    expect(urls(calls)).toEqual([`GET https://api.github.com/repos/acme/infra/actions/runs?head_sha=${SHA}&event=pull_request&per_page=100&page=1`]);
  });

  test("github: a run by id, undefined when missing; its jobs over the jobs object", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/actions/runs/10": { id: 10, event: "workflow_run", head_sha: SHA, path: ".github/workflows/review.yml", status: "completed" },
      "GET /repos/acme/infra/actions/runs/10/jobs": { total_count: 2, jobs: [{ id: 1, name: "plan", status: "completed", conclusion: "failure" }, { id: 2, name: "plan-note", status: "queued" }] },
    });
    const reads = githubReads({ ...gh, fetch });
    expect(await reads.run(10)).toMatchObject({ id: 10, event: "workflow_run", path: ".github/workflows/review.yml", workflow: "review.yml" });
    expect(await reads.run(99)).toBeUndefined();
    expect(await reads.runJobs(10)).toEqual([
      { id: 1, name: "plan", status: "completed", conclusion: "failure", done: true },
      { id: 2, name: "plan-note", status: "queued", done: false },
    ]);
    expect(urls(calls)).toContain("GET https://api.github.com/repos/acme/infra/actions/runs/10/jobs?per_page=100&page=1");
  });

  test("github: artifacts by name in a run and across the repository, expired ones and other names left out", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/actions/runs/10/artifacts": { artifacts: [{ id: 5, name: "report", size_in_bytes: 300 }] },
      "GET /repos/acme/infra/actions/artifacts": {
        artifacts: [
          { id: 6, name: "review-x", workflow_run: { id: 20, head_sha: SHA } },
          { id: 9, name: "review-x", expired: true, workflow_run: { id: 21 } },
          { id: 8, name: "review-x", workflow_run: { id: 22, head_sha: SHA } },
          { id: 7, name: "other", workflow_run: { id: 23 } },
        ],
      },
    });
    const reads = githubReads({ ...gh, fetch });
    expect(await reads.artifacts("report", { run: 10 })).toEqual([{ id: 5, name: "report", run: 10, size: 300 }]);
    expect(await reads.artifacts("review-x")).toEqual([
      { id: 8, name: "review-x", run: 22, headSha: SHA },
      { id: 6, name: "review-x", run: 20, headSha: SHA },
    ]);
    expect(urls(calls)).toEqual([
      "GET https://api.github.com/repos/acme/infra/actions/runs/10/artifacts?name=report&per_page=100&page=1",
      "GET https://api.github.com/repos/acme/infra/actions/artifacts?name=review-x&per_page=100&page=1",
    ]);
  });

  test("forgejo: trigger_event is the run's event, its listed event kept, and the payload names the pull request", async () => {
    const payload = JSON.stringify({ pull_request: { number: 3, base: { ref: "main" }, head: { ref: "feat", sha: SHA } } });
    const { fetch, calls } = fakeFetch({
      "GET /api/v1/repos/acme/infra/actions/runs": {
        workflow_runs: [
          { id: 40, event: "pull_request", trigger_event: "pull_request_target", workflow_id: "review.yml", commit_sha: SHA, status: "running", event_payload: payload },
          { id: 41, event: "pull_request", trigger_event: "pull_request", workflow_id: "pipeline.yml", commit_sha: SHA, status: "success" },
        ],
      },
      "GET /api/v1/repos/acme/infra/actions/runs/40/jobs": [{ id: 1, name: "plan-note", status: "success" }],
      "GET /api/v1/repos/acme/infra/actions/runs/40/artifacts": [{ id: 2, name: "report", run_id: 40 }],
    });
    const reads = forgejoReads({ ...fj, fetch });
    const runs = await reads.headRuns(SHA, { event: "pull_request" });
    expect(runs.map((r) => [r.id, r.event, r.listedEvent, r.workflow, r.done])).toEqual([
      [41, "pull_request", undefined, "pipeline.yml", true],
      [40, "pull_request_target", "pull_request", "review.yml", false],
    ]);
    expect(runs[1]!.pullRequests).toEqual([{ number: 3, head: "feat", headSha: SHA, base: "main" }]);
    expect(await reads.runJobs(40)).toEqual([{ id: 1, name: "plan-note", status: "success", done: true }]);
    expect(await reads.artifacts("report", { run: 40 })).toEqual([{ id: 2, name: "report", run: 40 }]);
    expect(urls(calls)[0]).toBe(`GET https://code.acme.io/api/v1/repos/acme/infra/actions/runs?head_sha=${SHA}&event=pull_request&limit=50&page=1`);
  });

  test("gitlab: a head's pipelines by source, a pipeline's merge request from its ref, its jobs", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${P}/pipelines`]: [
        { id: 31, sha: SHA, ref: "refs/merge-requests/5/head", source: "merge_request_event", status: "running", web_url: "https://gitlab.com/acme/infra/-/pipelines/31" },
        { id: 30, sha: SHA, ref: "refs/merge-requests/5/head", source: "merge_request_event", status: "failed" },
      ],
      [`GET ${P}/pipelines/30`]: { id: 30, sha: SHA, ref: "main", source: "push", status: "success" },
      [`GET ${P}/pipelines/30/jobs`]: [{ id: 300, name: "plan", status: "success" }, { id: 301, name: "apply", status: "manual" }],
    });
    const reads = gitlabReads({ ...gl, fetch });
    const runs = await reads.headRuns(SHA, { event: "merge_request_event" });
    expect(runs.map((r) => [r.id, r.event, r.done])).toEqual([
      [31, "merge_request_event", false],
      [30, "merge_request_event", true],
    ]);
    expect(runs[0]).toMatchObject({ headBranch: "refs/merge-requests/5/head", pullRequests: [{ number: 5, headSha: SHA }], url: "https://gitlab.com/acme/infra/-/pipelines/31" });
    expect(await reads.run(30)).toMatchObject({ id: 30, event: "push", headBranch: "main", pullRequests: [] });
    expect(await reads.run(99)).toBeUndefined();
    expect(await reads.runJobs(30)).toEqual([
      { id: 300, name: "plan", status: "success", done: true },
      { id: 301, name: "apply", status: "manual", done: false },
    ]);
    expect(urls(calls)[0]).toBe(`GET https://gitlab.com${P}/pipelines?sha=${SHA}&source=merge_request_event&order_by=id&sort=desc&per_page=100&page=1`);
  });

  test("gitlab: a job's archive is its artifact, by the job's name, in a pipeline or across the project", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${P}/pipelines/30/jobs`]: [
        { id: 300, name: "plan", artifacts: [{ file_type: "archive", size: 12 }, { file_type: "metadata" }], pipeline: { id: 30, sha: SHA } },
        { id: 301, name: "plan", artifacts: [{ file_type: "trace" }], pipeline: { id: 30, sha: SHA } },
        { id: 302, name: "lint", artifacts_file: { filename: "artifacts.zip", size: 1 }, pipeline: { id: 30, sha: SHA } },
      ],
      [`GET ${P}/jobs`]: [
        { id: 410, name: "review", artifacts_file: { filename: "artifacts.zip", size: 5 }, pipeline: { id: 41, sha: OTHER } },
        { id: 400, name: "review", artifacts_file: { filename: "artifacts.zip" }, artifacts_expire_at: "2000-01-01T00:00:00Z", pipeline: { id: 40 } },
        { id: 390, name: "review", artifacts: [{ file_type: "archive" }], pipeline: { id: 39, sha: SHA } },
      ],
    });
    const reads = gitlabReads({ ...gl, fetch });
    expect(await reads.artifacts("plan", { run: 30 })).toEqual([{ id: 300, name: "plan", run: 30, headSha: SHA, size: 12 }]);
    expect(await reads.artifacts("review")).toEqual([
      { id: 410, name: "review", run: 41, headSha: OTHER, size: 5 },
      { id: 390, name: "review", run: 39, headSha: SHA },
    ]);
    expect(urls(calls)).toEqual([`GET https://gitlab.com${P}/pipelines/30/jobs?per_page=100&page=1`, `GET https://gitlab.com${P}/jobs?per_page=100&page=1`]);
  });
});

describe("a branch's runs, and the pull requests updated since a time (#4785)", () => {
  const gh = { apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k" };
  const gl = { apiBase: "https://gitlab.com/api/v4", project: "acme/infra", token: "glpat" };
  const P = "/api/v4/projects/acme%2Finfra";

  test("github: a branch's push runs, newest first", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/actions/runs": { workflow_runs: [{ id: 3, event: "push", head_sha: SHA, head_branch: "main", status: "completed" }, { id: 4, event: "push", head_sha: MERGED, head_branch: "main", status: "queued" }] },
    });
    expect((await githubReads({ ...gh, fetch }).branchRuns("main", { event: "push" })).map((r) => [r.id, r.headSha])).toEqual([
      [4, MERGED],
      [3, SHA],
    ]);
    expect(urls(calls)).toEqual(["GET https://api.github.com/repos/acme/infra/actions/runs?branch=main&event=push&per_page=100&page=1"]);
  });

  test("gitlab: a branch's pipelines by ref and source, another ref's left out", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${P}/pipelines`]: [
        { id: 12, sha: MERGED, ref: "main", source: "push", status: "success" },
        { id: 11, sha: SHA, ref: "ci/green/1", source: "push", status: "success" },
      ],
    });
    expect((await gitlabReads({ ...gl, fetch }).branchRuns("main", { event: "push" })).map((r) => r.id)).toEqual([12]);
    expect(urls(calls)).toEqual([`GET https://gitlab.com${P}/pipelines?ref=main&source=push&order_by=id&sort=desc&per_page=100&page=1`]);
  });

  test("gitlab: the merge requests updated since a time, forks' among them", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${P}/merge_requests`]: [
        { iid: 3, state: "opened", source_branch: "a", source_project_id: 9, target_project_id: 1 },
        { iid: 2, state: "merged", source_branch: "b", merge_commit_sha: MERGED },
      ],
    });
    expect((await gitlabReads({ ...gl, fetch }).pullRequestsUpdated("2026-11-07T00:00:00.000Z")).map((m) => [m.number, m.state, m.sameRepo])).toEqual([
      [3, "open", false],
      [2, "merged", true],
    ]);
    expect(urls(calls)).toEqual([`GET https://gitlab.com${P}/merge_requests?state=all&updated_after=2026-11-07T00%3A00%3A00.000Z&order_by=updated_at&sort=desc&per_page=100&page=1`]);
  });

  test("github: newest update first, stopping at the first one older than the time", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/pulls": [
        { number: 9, state: "open", updated_at: "2026-11-08T00:00:00Z", head: { ref: "x", repo: { full_name: "eve/infra" } } },
        { number: 8, state: "closed", updated_at: "2026-11-01T00:00:00Z", head: { ref: "y" } },
      ],
    });
    expect((await githubReads({ ...gh, fetch }).pullRequestsUpdated("2026-11-07T00:00:00Z")).map((p) => [p.number, p.sameRepo])).toEqual([[9, false]]);
    expect(urls(calls)).toEqual(["GET https://api.github.com/repos/acme/infra/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1"]);
  });
});
