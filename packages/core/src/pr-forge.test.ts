/**
 * The forge clients of the pull-request loop (#3183), driven through a
 * recording `fetch`: the calls each makes on GitHub, Forgejo and GitLab, and
 * what each reads back.
 */

import { describe, expect, test } from "vitest";
import {
  detectForge,
  ForgeApiError,
  forgeClient,
  ForgeEnvironmentError,
  forgeFromEnv,
  forgeTargetFromEnv,
  forgejoForge,
  forgePrincipalOf,
  FORGE_STATUS_STATES,
  githubForge,
  gitlabForge,
  statusStateFor,
  type ForgeFetch,
  type ForgeStatusState,
} from "./pr-forge";
import { forgePrincipal, parseForgeIdentity } from "./workspace/identity";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fake forge: `routes` maps `METHOD path-without-query` to a response body (or a status). */
function fakeFetch(routes: Record<string, unknown | ((call: Call) => unknown)>): { fetch: ForgeFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: ForgeFetch = async (url, init) => {
    const call: Call = { method: init.method, url, headers: init.headers, ...(init.body ? { body: JSON.parse(init.body) } : {}) };
    calls.push(call);
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    const page = Number(u.searchParams.get("page") ?? "1");
    let found = routes[`${key}?page=${page}`] ?? routes[key];
    if (typeof found === "function") found = (found as (c: Call) => unknown)(call);
    if (found === undefined) return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
    if (typeof found === "number") return { ok: false, status: found, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(found) };
  };
  return { fetch, calls };
}

const SHA = "a".repeat(40);

describe("github", () => {
  const opts = { apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k" };

  test("updates the note that starts with the marker, found on a later page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `other ${i}` }));
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/issues/12/comments?page=1": page1,
      "GET /repos/acme/infra/issues/12/comments?page=2": [{ id: 555, body: "<!-- chant-pr:prod -->\nold" }],
      "PATCH /repos/acme/infra/issues/comments/555": {},
    });
    await githubForge({ ...opts, fetch }).upsertNote(12, "<!-- chant-pr:prod -->", "<!-- chant-pr:prod -->\nnew");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/infra/issues/12/comments?per_page=100&page=1",
      "GET https://api.github.com/repos/acme/infra/issues/12/comments?per_page=100&page=2",
      "PATCH https://api.github.com/repos/acme/infra/issues/comments/555",
    ]);
    expect(calls[2].body).toEqual({ body: "<!-- chant-pr:prod -->\nnew" });
    expect(calls[0].headers.Authorization).toBe("Bearer t0k");
  });

  test("adds a note when none carries the marker", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/issues/12/comments": [{ id: 1, body: "lgtm" }],
      "POST /repos/acme/infra/issues/12/comments": {},
    });
    await githubForge({ ...opts, fetch }).upsertNote(12, "<!-- chant-pr:prod -->", "body");
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { body: "body" } });
  });

  test("sets a commit status with its context and link", async () => {
    const { fetch, calls } = fakeFetch({ [`POST /repos/acme/infra/statuses/${SHA}`]: {} });
    await githubForge({ ...opts, fetch }).setStatus(SHA, { context: "chant/plan", state: "success", description: "2 members", url: "https://ci/run/1" });
    expect(calls[0].body).toEqual({ state: "success", context: "chant/plan", description: "2 members", target_url: "https://ci/run/1" });
  });

  test("the authors of a pull request are its opener and every commit's author and committer, every page read (#4000)", async () => {
    const page1 = Array.from({ length: 100 }, () => ({ author: { login: "carol" }, committer: { login: "carol" } }));
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/pulls/12": { number: 12, user: { login: "carol" } },
      "GET /repos/acme/infra/pulls/12/commits?page=1": page1,
      "GET /repos/acme/infra/pulls/12/commits?page=2": [{ author: null, committer: { login: "dave" } }, { author: { login: "erin" }, committer: { login: "web-flow" } }],
    });
    expect(await githubForge({ ...opts, fetch }).authors(12)).toEqual(["carol", "dave", "erin", "web-flow"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/infra/pulls/12",
      "https://api.github.com/repos/acme/infra/pulls/12/commits?per_page=100&page=1",
      "https://api.github.com/repos/acme/infra/pulls/12/commits?per_page=100&page=2",
    ]);
  });

  test("an approver is someone whose newest deciding review approves", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/infra/pulls/12/reviews": [
        { user: { login: "alice" }, state: "APPROVED" },
        { user: { login: "alice" }, state: "COMMENTED" },
        { user: { login: "bob" }, state: "APPROVED" },
        { user: { login: "bob" }, state: "CHANGES_REQUESTED" },
        { user: { login: "carol" }, state: "APPROVED" },
        { user: { login: "carol" }, state: "DISMISSED" },
        { user: { login: "dan" }, state: "CHANGES_REQUESTED" },
        { user: { login: "dan" }, state: "APPROVED" },
      ],
    });
    expect(await githubForge({ ...opts, fetch }).approvers(12)).toEqual(["alice", "dan"]);
  });

  test("finds the merged pull request whose merge commit is the pushed one", async () => {
    const { fetch } = fakeFetch({
      [`GET /repos/acme/infra/commits/${SHA}/pulls`]: [
        { number: 3, merged_at: null },
        { number: 7, merged_at: "2026-10-01T00:00:00Z", merge_commit_sha: "b".repeat(40) },
        { number: 9, merged_at: "2026-10-02T00:00:00Z", merge_commit_sha: SHA },
      ],
    });
    expect(await githubForge({ ...opts, fetch }).pullRequestFor(SHA)).toBe(9);
  });

  test("resolves to the note's web URL", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/infra/issues/12/comments": [],
      "POST /repos/acme/infra/issues/12/comments": { id: 3, html_url: "https://github.com/acme/infra/pull/12#issuecomment-3" },
    });
    expect(await githubForge({ ...opts, fetch }).upsertNote(12, "<!-- m -->", "<!-- m -->\nbody")).toBe(
      "https://github.com/acme/infra/pull/12#issuecomment-3",
    );
  });

  test("updates the open issue that starts with the marker, title and body, skipping pull requests (#3757)", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/issues": [
        { number: 3, body: "<!-- m -->\nquoted", pull_request: { url: "x" } },
        { number: 4, body: "unrelated", pull_request: null },
        { number: 5, body: "<!-- m -->\nold" },
      ],
      "PATCH /repos/acme/infra/issues/5": { number: 5, html_url: "https://github.com/acme/infra/issues/5" },
    });
    const url = await githubForge({ ...opts, fetch }).upsertIssue("<!-- m -->", "Drift: 2", "<!-- m -->\nnew");
    expect(url).toBe("https://github.com/acme/infra/issues/5");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/infra/issues?state=open&per_page=100&page=1",
      "PATCH https://api.github.com/repos/acme/infra/issues/5",
    ]);
    expect(calls[1].body).toEqual({ title: "Drift: 2", body: "<!-- m -->\nnew" });
  });

  test("opens an issue when no open one carries the marker (#3757)", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/issues": [{ number: 4, body: null }],
      "POST /repos/acme/infra/issues": { number: 6, html_url: "https://github.com/acme/infra/issues/6" },
    });
    expect(await githubForge({ ...opts, fetch }).upsertIssue("<!-- m -->", "t", "<!-- m -->\nb")).toBe(
      "https://github.com/acme/infra/issues/6",
    );
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { title: "t", body: "<!-- m -->\nb" } });
  });

  test("an error status is a ForgeApiError naming the call", async () => {
    const { fetch } = fakeFetch({ [`POST /repos/acme/infra/statuses/${SHA}`]: 403 });
    await expect(githubForge({ ...opts, fetch }).setStatus(SHA, { context: "c", state: "success", description: "d" })).rejects.toBeInstanceOf(ForgeApiError);
  });
});

describe("forgejo", () => {
  const opts = { apiBase: "https://codeberg.org/api/v1", repo: "acme/infra", token: "t0k", host: "codeberg.org" };

  test("speaks GitHub's note and status calls under /api/v1, with a token header and Forgejo's page size", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/v1/repos/acme/infra/issues/4/comments": [{ id: 9, body: "<!-- chant-pr:prod -->x" }],
      "PATCH /api/v1/repos/acme/infra/issues/comments/9": {},
      [`POST /api/v1/repos/acme/infra/statuses/${SHA}`]: {},
    });
    const forge = forgejoForge({ ...opts, fetch });
    await forge.upsertNote(4, "<!-- chant-pr:prod -->", "y");
    await forge.setStatus(SHA, { context: "chant/apply", state: "failure", description: "refused" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://codeberg.org/api/v1/repos/acme/infra/issues/4/comments?limit=50&page=1",
      "PATCH https://codeberg.org/api/v1/repos/acme/infra/issues/comments/9",
      `POST https://codeberg.org/api/v1/repos/acme/infra/statuses/${SHA}`,
    ]);
    expect(calls[0].headers.Authorization).toBe("token t0k");
  });

  test("keeps an issue under /api/v1 with Forgejo's page size (#3757)", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ number: i + 1, body: `other ${i}`, pull_request: null }));
    const { fetch, calls } = fakeFetch({
      "GET /api/v1/repos/acme/infra/issues?page=1": page1,
      "GET /api/v1/repos/acme/infra/issues?page=2": [{ number: 77, body: "<!-- m -->\nold", pull_request: null }],
      "PATCH /api/v1/repos/acme/infra/issues/77": { number: 77, html_url: "https://codeberg.org/acme/infra/issues/77" },
    });
    expect(await forgejoForge({ ...opts, fetch }).upsertIssue("<!-- m -->", "t", "<!-- m -->\nb")).toBe(
      "https://codeberg.org/acme/infra/issues/77",
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://codeberg.org/api/v1/repos/acme/infra/issues?state=open&limit=50&page=1",
      "https://codeberg.org/api/v1/repos/acme/infra/issues?state=open&limit=50&page=2",
      "https://codeberg.org/api/v1/repos/acme/infra/issues/77",
    ]);
    expect(calls[0].headers.Authorization).toBe("token t0k");
  });

  test("the authors of a pull request come from the same endpoints, paged by limit (#4000)", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/v1/repos/acme/infra/pulls/4": { number: 4, user: { login: "ana" } },
      "GET /api/v1/repos/acme/infra/pulls/4/commits": [{ author: { login: "ana" }, committer: { login: "ben" } }],
    });
    expect(await forgejoForge({ ...opts, fetch }).authors(4)).toEqual(["ana", "ben"]);
    expect(calls.map((c) => c.url)).toContain("https://codeberg.org/api/v1/repos/acme/infra/pulls/4/commits?limit=50&page=1");
  });

  test("a dismissed approval no longer counts, and a comment review decides nothing", async () => {
    const { fetch } = fakeFetch({
      "GET /api/v1/repos/acme/infra/pulls/4/reviews": [
        { user: { login: "ana" }, state: "APPROVED" },
        { user: { login: "ana" }, state: "COMMENT" },
        { user: { login: "ben" }, state: "APPROVED", dismissed: true },
      ],
    });
    expect(await forgejoForge({ ...opts, fetch }).approvers(4)).toEqual(["ana"]);
  });

  test("finds the pull request of a commit through /commits/{sha}/pull, and none answers null", async () => {
    const found = fakeFetch({ [`GET /api/v1/repos/acme/infra/commits/${SHA}/pull`]: { number: 4 } });
    expect(await forgejoForge({ ...opts, fetch: found.fetch }).pullRequestFor(SHA)).toBe(4);
    const none = fakeFetch({});
    expect(await forgejoForge({ ...opts, fetch: none.fetch }).pullRequestFor(SHA)).toBeNull();
  });

  test("names reviewers on its host", () => {
    expect(forgejoForge({ ...opts, fetch: fakeFetch({}).fetch }).principalOf("Ana")).toBe("forgejo@codeberg.org:ana");
  });
});

describe("gitlab", () => {
  const opts = { apiBase: "https://gitlab.example.com/api/v4", project: "42", token: "glpat", host: "gitlab.example.com" };

  test("updates a merge request note with PUT, and adds one with POST", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/v4/projects/42/merge_requests/5/notes": [{ id: 77, body: "<!-- chant-pr:prod -->old" }],
      "PUT /api/v4/projects/42/merge_requests/5/notes/77": {},
    });
    await gitlabForge({ ...opts, fetch }).upsertNote(5, "<!-- chant-pr:prod -->", "new");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/v4/projects/42/merge_requests/5/notes",
      "PUT /api/v4/projects/42/merge_requests/5/notes/77",
    ]);
    expect(calls[0].headers["PRIVATE-TOKEN"]).toBe("glpat");
  });

  test("a status maps failure to GitLab's failed and names the context", async () => {
    const { fetch, calls } = fakeFetch({ [`POST /api/v4/projects/42/statuses/${SHA}`]: {} });
    await gitlabForge({ ...opts, fetch }).setStatus(SHA, { context: "chant/apply", state: "failure", description: "refused" });
    expect(calls[0].body).toEqual({ state: "failed", name: "chant/apply", description: "refused" });
  });

  test("the authors of a merge request: its author, and each commit email's account by the users search (#4000)", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/v4/projects/42/merge_requests/5": { iid: 5, author: { username: "ana" } },
      "GET /api/v4/projects/42/merge_requests/5/commits": [
        { author_email: "ana@example.com", committer_email: "Ben@Example.com" },
        { author_email: "ghost@example.com", committer_email: "ana@example.com" },
      ],
      "GET /api/v4/users": (c: Call) =>
        ({ "ana@example.com": [{ username: "ana" }], "ben@example.com": [{ username: "ben" }] })[new URL(c.url).searchParams.get("search")!] ?? [],
    });
    expect(await gitlabForge({ ...opts, fetch }).authors(5)).toEqual(["ana", "ben"]);
    expect(calls.filter((c) => new URL(c.url).pathname === "/api/v4/users").map((c) => new URL(c.url).searchParams.get("search"))).toEqual([
      "ana@example.com",
      "ben@example.com",
      "ghost@example.com",
    ]);
  });

  test("approvers come from the approvals endpoint, merged requests from the commit", async () => {
    const { fetch } = fakeFetch({
      "GET /api/v4/projects/42/merge_requests/5/approvals": { approved_by: [{ user: { username: "ana" } }, { user: { username: "ben" } }] },
      [`GET /api/v4/projects/42/repository/commits/${SHA}/merge_requests`]: [
        { iid: 3, state: "opened" },
        { iid: 5, state: "merged", merge_commit_sha: SHA },
      ],
    });
    const forge = gitlabForge({ ...opts, fetch });
    expect(await forge.approvers(5)).toEqual(["ana", "ben"]);
    expect(await forge.pullRequestFor(SHA)).toBe(5);
    expect(forge.principalOf("ana")).toBe("gitlab@gitlab.example.com:ana");
  });
});

describe("naming reviewers", () => {
  test("agrees with the workspace's own forge identities (#3163)", () => {
    for (const [kind, host, login] of [
      ["github", "github.com", "Alice"],
      ["github", "ghe.acme.io", "alice"],
      ["gitlab", "gitlab.com", "ana"],
      ["gitlab", "gitlab.acme.io", "ana"],
      ["forgejo", "codeberg.org", "ben"],
    ] as const) {
      const principal = forgePrincipalOf(kind, host, login);
      expect(principal).toBe(forgePrincipal(parseForgeIdentity(principal)!));
      expect(parseForgeIdentity(principal)).toEqual({ forge: kind, host, login: login.toLowerCase() });
    }
  });
});

describe("forgeFromEnv", () => {
  test("reads GitHub's job environment, with the run as the status link", () => {
    const forge = forgeFromEnv("github", {
      GITHUB_REPOSITORY: "acme/infra",
      GITHUB_TOKEN: "t",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "77",
    });
    expect(forge.kind).toBe("github");
    expect(forge.host).toBe("github.com");
    expect(forge.runUrl).toBe("https://github.com/acme/infra/actions/runs/77");
  });

  test("Forgejo needs its server and API URLs, and says which are missing", () => {
    expect(() => forgeFromEnv("forgejo", { GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t" })).toThrow(
      "--forge forgejo needs GITHUB_SERVER_URL, GITHUB_API_URL in the environment",
    );
    expect(
      forgeFromEnv("forgejo", { GITHUB_REPOSITORY: "a/b", GITHUB_TOKEN: "t", GITHUB_SERVER_URL: "https://codeberg.org", GITHUB_API_URL: "https://codeberg.org/api/v1" }).host,
    ).toBe("codeberg.org");
  });

  test("GitLab needs a token with the api scope, since a job token cannot write notes", () => {
    expect(() => forgeFromEnv("gitlab", { CI_API_V4_URL: "https://gitlab.com/api/v4", CI_PROJECT_ID: "1", CI_JOB_TOKEN: "j" })).toThrow(
      /CHANT_FORGE_TOKEN/,
    );
  });
});

// ── #3759: comment, status and tracking issue by marker, for the products ──

describe("upsertComment (#3759)", () => {
  const gh = { apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k" };

  test("leaves a comment whose body is already current, and says which it did", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/issues/12/comments": [{ id: 4, body: "<!-- m -->\nsame", html_url: "https://h/4" }],
    });
    expect(await githubForge({ ...gh, fetch }).upsertComment(12, "<!-- m -->", "<!-- m -->\nsame")).toEqual({
      action: "unchanged",
      id: 4,
      url: "https://h/4",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("created and updated carry the comment's id and URL", async () => {
    const created = fakeFetch({
      "GET /repos/acme/infra/issues/12/comments": [],
      "POST /repos/acme/infra/issues/12/comments": { id: 9, html_url: "https://h/9" },
    });
    expect(await githubForge({ ...gh, fetch: created.fetch }).upsertComment(12, "<!-- m -->", "<!-- m -->\nb")).toEqual({ action: "created", id: 9, url: "https://h/9" });
    const updated = fakeFetch({
      "GET /repos/acme/infra/issues/12/comments": [{ id: 3, body: "<!-- m -->\nold" }],
      "PATCH /repos/acme/infra/issues/comments/3": { id: 3, html_url: "https://h/3" },
    });
    expect(await githubForge({ ...gh, fetch: updated.fetch }).upsertComment(12, "<!-- m -->", "<!-- m -->\nnew")).toEqual({ action: "updated", id: 3, url: "https://h/3" });
  });

  test("a body without its marker is refused before any call", async () => {
    const { fetch, calls } = fakeFetch({});
    await expect(githubForge({ ...gh, fetch }).upsertComment(12, "<!-- m -->", "no marker")).rejects.toThrow(/does not start with its marker/);
    expect(calls).toEqual([]);
  });

  test("anywhere matches a marker inside the body, and author keeps only the bot's own", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/issues/12/comments": [
        { id: 1, body: "quote: <!-- yodel:env=prod -->", user: { login: "mallory" } },
        { id: 2, body: "plan\n<!-- yodel:env=prod -->", user: { login: "yodel-bot" } },
      ],
      "PATCH /repos/acme/infra/issues/comments/2": { id: 2 },
    });
    const r = await githubForge({ ...gh, fetch }).upsertComment(12, "<!-- yodel:env=prod -->", "new\n<!-- yodel:env=prod -->", { match: "anywhere", author: "Yodel-Bot" });
    expect(r.action).toBe("updated");
    expect(calls.at(-1)?.url).toBe("https://api.github.com/repos/acme/infra/issues/comments/2");
  });

  test("GitLab skips system notes, keeps the oldest of several, and edits with PUT", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/v4/projects/42/merge_requests/5/notes": [
        { id: 30, body: "<!-- m -->\nb", system: true },
        { id: 21, body: "<!-- m -->\nnewer", author: { username: "bot" } },
        { id: 20, body: "<!-- m -->\nolder", author: { username: "bot" } },
      ],
      "PUT /api/v4/projects/42/merge_requests/5/notes/20": { id: 20 },
    });
    const forge = gitlabForge({ apiBase: "https://gitlab.example.com/api/v4", project: "42", token: "glpat", fetch });
    expect(await forge.upsertComment(5, "<!-- m -->", "<!-- m -->\nnow")).toEqual({ action: "updated", id: 20 });
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { body: "<!-- m -->\nnow" } });
  });
});

describe("findComment (#3802)", () => {
  const gh = { apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k" };

  test("reads back the comment upsertComment would update, author honoured, oldest first", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/issues/12/comments": [
        { id: 1, body: "<!-- y -->\nsubject: planted", user: { login: "mallory" } },
        { id: 5, body: "<!-- y -->\nsubject: newer", user: { login: "yodel-bot" }, html_url: "https://h/5" },
        { id: 3, body: "<!-- y -->\nsubject: abc", user: { login: "Yodel-Bot" }, html_url: "https://h/3" },
      ],
    });
    const forge = githubForge({ ...gh, fetch });
    expect(await forge.findComment(12, "<!-- y -->", { author: "yodel-bot" })).toEqual({ id: 3, body: "<!-- y -->\nsubject: abc", url: "https://h/3" });
    expect((await forge.findComment(12, "<!-- y -->"))?.id).toBe(1);
    expect(await forge.findComment(12, "<!-- other -->")).toBeUndefined();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("Forgejo pages with limit, and anywhere finds a marker inside the body", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/v1/repos/acme/infra/issues/4/comments": [{ id: 7, body: "plan\n<!-- y -->", user: { login: "bot" }, html_url: "https://cb/7" }],
    });
    const forge = forgejoForge({ ...gh, apiBase: "https://codeberg.org/api/v1", host: "codeberg.org", fetch });
    expect(await forge.findComment(4, "<!-- y -->", { match: "anywhere" })).toEqual({ id: 7, body: "plan\n<!-- y -->", url: "https://cb/7" });
    expect(await forge.findComment(4, "<!-- y -->")).toBeUndefined();
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("50");
  });

  test("GitLab skips system notes and reads the note without a URL", async () => {
    const { fetch } = fakeFetch({
      "GET /api/v4/projects/42/merge_requests/5/notes": [
        { id: 30, body: "<!-- y -->\nsys", system: true },
        { id: 31, body: "<!-- y -->\nmine", author: { username: "bot" } },
      ],
    });
    const forge = gitlabForge({ apiBase: "https://gitlab.example.com/api/v4", project: "42", token: "glpat", fetch });
    expect(await forge.findComment(5, "<!-- y -->", { author: "bot" })).toEqual({ id: 31, body: "<!-- y -->\nmine" });
  });

  test("an empty marker is refused", async () => {
    const { fetch, calls } = fakeFetch({});
    await expect(githubForge({ ...gh, fetch }).findComment(12, "")).rejects.toThrow(/needs a marker/);
    expect(calls).toEqual([]);
  });
});

describe("trackIssue (#3759)", () => {
  const gh = { apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k" };
  const open = [
    { number: 8, title: "Drift: prod", body: "<!-- d -->\n2 changes", html_url: "https://h/issues/8" },
    { number: 9, title: "pr", body: "<!-- d -->", pull_request: { url: "x" } },
  ];

  test("a cleared finding leaves the issue open unless close-on-clear is set", async () => {
    const { fetch, calls } = fakeFetch({ "GET /repos/acme/infra/issues": open });
    expect(await githubForge({ ...gh, fetch }).trackIssue("<!-- d -->", null)).toEqual({ action: "left", number: 8, url: "https://h/issues/8" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("close-on-clear comments, then closes, on GitHub and Forgejo", async () => {
    for (const [make, base] of [
      [(f: ForgeFetch) => githubForge({ ...gh, fetch: f }), "/repos/acme/infra"],
      [(f: ForgeFetch) => forgejoForge({ ...gh, apiBase: "https://codeberg.org/api/v1", host: "codeberg.org", fetch: f }), "/api/v1/repos/acme/infra"],
    ] as const) {
      const { fetch, calls } = fakeFetch({
        [`GET ${base}/issues`]: open,
        [`POST ${base}/issues/8/comments`]: {},
        [`PATCH ${base}/issues/8`]: {},
      });
      const r = await make(fetch).trackIssue("<!-- d -->", null, { closeOnClear: true, clearComment: "No drift now." });
      expect(r).toEqual({ action: "closed", number: 8, url: "https://h/issues/8" });
      expect(calls.slice(1).map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
        ["POST", `${base}/issues/8/comments`, { body: "No drift now." }],
        ["PATCH", `${base}/issues/8`, { state: "closed" }],
      ]);
    }
  });

  test("a cleared finding with no open issue does nothing", async () => {
    const { fetch, calls } = fakeFetch({ "GET /repos/acme/infra/issues": [] });
    expect(await githubForge({ ...gh, fetch }).trackIssue("<!-- d -->", null, { closeOnClear: true })).toEqual({ action: "none" });
    expect(calls).toHaveLength(1);
  });

  test("a finding opens, updates, or leaves an issue that already says it", async () => {
    const same = fakeFetch({ "GET /repos/acme/infra/issues": open });
    expect(await githubForge({ ...gh, fetch: same.fetch }).trackIssue("<!-- d -->", { title: "Drift: prod", body: "<!-- d -->\n2 changes" })).toMatchObject({ action: "unchanged", number: 8 });
    const changed = fakeFetch({ "GET /repos/acme/infra/issues": open, "PATCH /repos/acme/infra/issues/8": { number: 8, html_url: "https://h/issues/8" } });
    expect(await githubForge({ ...gh, fetch: changed.fetch }).trackIssue("<!-- d -->", { title: "Drift: prod", body: "<!-- d -->\n3 changes" })).toMatchObject({ action: "updated", number: 8 });
    const none = fakeFetch({ "GET /repos/acme/infra/issues": [], "POST /repos/acme/infra/issues": { number: 10, html_url: "https://h/issues/10" } });
    expect(await githubForge({ ...gh, fetch: none.fetch }).trackIssue("<!-- d -->", { title: "t", body: "<!-- d -->\nb" })).toEqual({ action: "opened", number: 10, url: "https://h/issues/10" });
  });

  test("sameWhen counts a body that differs only in run-specific text as unchanged (#3802)", async () => {
    const issues = [{ number: 8, title: "Drift: prod", body: "<!-- d -->\nfingerprint f1\nrun 100", html_url: "https://h/issues/8" }];
    const next = { title: "Drift: prod", body: "<!-- d -->\nfingerprint f1\nrun 101" };
    const same = fakeFetch({ "GET /repos/acme/infra/issues": issues });
    expect(await githubForge({ ...gh, fetch: same.fetch }).trackIssue("<!-- d -->", next, { sameWhen: "fingerprint f1" })).toEqual({
      action: "unchanged",
      number: 8,
      url: "https://h/issues/8",
    });
    expect(same.calls.map((c) => c.method)).toEqual(["GET"]);
    const strip = (b: string) => b.replace(/\nrun \d+/, "");
    const fn = fakeFetch({ "GET /repos/acme/infra/issues": issues });
    expect(
      (await githubForge({ ...gh, fetch: fn.fetch }).trackIssue("<!-- d -->", next, { sameWhen: (o, f) => o.title === f.title && strip(o.body) === strip(f.body) })).action,
    ).toBe("unchanged");
    const retitled = fakeFetch({ "GET /repos/acme/infra/issues": issues, "PATCH /repos/acme/infra/issues/8": { number: 8 } });
    expect((await githubForge({ ...gh, fetch: retitled.fetch }).trackIssue("<!-- d -->", { ...next, title: "Drift: prod (2)" }, { sameWhen: "fingerprint f1" })).action).toBe("updated");
    const moved = fakeFetch({ "GET /repos/acme/infra/issues": issues, "PATCH /repos/acme/infra/issues/8": { number: 8 } });
    expect((await githubForge({ ...gh, fetch: moved.fetch }).trackIssue("<!-- d -->", { ...next, body: "<!-- d -->\nfingerprint f2" }, { sameWhen: "fingerprint f2" })).action).toBe("updated");
  });

  test("GitLab searches open issues by description, writes description, and closes with a note", async () => {
    const issues = [{ iid: 3, title: "Drift", description: "<!-- d -->\nold", web_url: "https://gl/i/3" }];
    const { fetch, calls } = fakeFetch({
      "GET /api/v4/projects/group%2Fapp/issues": issues,
      "PUT /api/v4/projects/group%2Fapp/issues/3": { iid: 3, web_url: "https://gl/i/3" },
      "POST /api/v4/projects/group%2Fapp/issues/3/notes": {},
    });
    const forge = gitlabForge({ apiBase: "https://gitlab.example.com/api/v4", project: "group/app", token: "glpat", fetch });
    expect(await forge.trackIssue("<!-- d -->", { title: "Drift", body: "<!-- d -->\nnew" })).toEqual({ action: "updated", number: 3, url: "https://gl/i/3" });
    const list = new URL(calls[0].url);
    expect([list.searchParams.get("state"), list.searchParams.get("search"), list.searchParams.get("in")]).toEqual(["opened", "<!-- d -->", "description"]);
    expect(calls[1].body).toEqual({ title: "Drift", description: "<!-- d -->\nnew" });
    expect(await forge.trackIssue("<!-- d -->", null, { closeOnClear: true, clearComment: "gone" })).toMatchObject({ action: "closed", number: 3 });
    expect(calls.slice(-2).map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ["POST", "/api/v4/projects/group%2Fapp/issues/3/notes", { body: "gone" }],
      ["PUT", "/api/v4/projects/group%2Fapp/issues/3", { state_event: "close" }],
    ]);
  });

  test("GitLab's upsertIssue opens one when none carries the marker", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/v4/projects/42/issues": [],
      "POST /api/v4/projects/42/issues": { iid: 1, web_url: "https://gl/i/1" },
    });
    expect(await gitlabForge({ apiBase: "https://gl/api/v4", project: "42", token: "x", fetch }).upsertIssue("<!-- d -->", "t", "<!-- d -->\nb")).toBe("https://gl/i/1");
    expect(calls.at(-1)?.body).toEqual({ title: "t", description: "<!-- d -->\nb" });
  });
});

describe("commit status (#3759)", () => {
  test("cuts the description to what each forge keeps, and passes GitLab's pipeline", async () => {
    const long = "x".repeat(400);
    const gh = fakeFetch({ [`POST /repos/acme/infra/statuses/${SHA}`]: {} });
    await githubForge({ apiBase: "https://api.github.com", repo: "acme/infra", token: "t", fetch: gh.fetch }).setStatus(SHA, { context: "c", state: "success", description: long });
    expect((gh.calls[0].body as { description: string }).description).toHaveLength(140);
    const gl = fakeFetch({ [`POST /api/v4/projects/42/statuses/${SHA}`]: {} });
    await gitlabForge({ apiBase: "https://gl/api/v4", project: "42", token: "t", fetch: gl.fetch }).setStatus(SHA, { context: "c", state: "pending", description: long, pipelineId: 7 });
    expect(gl.calls[0].body).toMatchObject({ state: "pending", pipeline_id: 7 });
    expect((gl.calls[0].body as { description: string }).description).toHaveLength(255);
  });

  test("GitLab's 400 for a status already in that state is not an error; another 400 is", async () => {
    const answer = (text: string): ForgeFetch => async () => ({ ok: false, status: 400, text: async () => text });
    const forge = (f: ForgeFetch) => gitlabForge({ apiBase: "https://gl/api/v4", project: "42", token: "t", fetch: f });
    await expect(forge(answer('{"message":"Cannot transition status via :success from :success"}')).setStatus(SHA, { context: "c", state: "success", description: "d" })).resolves.toBeUndefined();
    await expect(forge(answer('{"message":"name is invalid"}')).setStatus(SHA, { context: "c", state: "success", description: "d" })).rejects.toBeInstanceOf(ForgeApiError);
  });
});

describe("forgeTargetFromEnv (#3759)", () => {
  test("detects the forge from the job's environment", () => {
    expect(detectForge({ GITHUB_ACTIONS: "true", GITHUB_API_URL: "https://api.github.com" })).toBe("github");
    expect(detectForge({ GITHUB_ACTIONS: "true", GITHUB_API_URL: "https://forgejo.example/api/v1" })).toBe("forgejo");
    expect(detectForge({ GITHUB_ACTIONS: "true", FORGEJO_ACTIONS: "true" })).toBe("forgejo");
    expect(detectForge({ GITLAB_CI: "true" })).toBe("gitlab");
    expect(detectForge({})).toBeUndefined();
  });

  test("GitHub: repository, pull request and head from the event payload, token in the documented order, run link", () => {
    const t = forgeTargetFromEnv(
      {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "acme/infra",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "77",
        GITHUB_SHA: "m".repeat(40),
        GITHUB_EVENT_PATH: "/event.json",
        GITHUB_TOKEN: "late",
        GH_TOKEN: "early",
      },
      { readFile: () => JSON.stringify({ number: 12, pull_request: { number: 12, head: { sha: SHA } } }) },
    );
    expect(t).toEqual({
      kind: "github",
      apiBase: "https://api.github.com",
      repo: "acme/infra",
      host: "github.com",
      token: "early",
      tokenSource: "GH_TOKEN",
      pr: 12,
      sha: SHA,
      runUrl: "https://github.com/acme/infra/actions/runs/77",
    });
    expect(forgeClient(t).kind).toBe("github");
  });

  test("Forgejo: FORGEJO_* first, the API under the server, the pull request from the ref, a named token variable", () => {
    const t = forgeTargetFromEnv(
      { FORGEJO_ACTIONS: "true", FORGEJO_REPOSITORY: "a/b", GITHUB_SERVER_URL: "https://codeberg.org/", GITHUB_REF: "refs/pull/4/head", FORGEJO_TOKEN: "f", CHANT_FORGEJO_TOKEN: "c" },
      { tokenEnv: "FORGEJO_TOKEN" },
    );
    expect(t).toMatchObject({ kind: "forgejo", apiBase: "https://codeberg.org/api/v1", repo: "a/b", host: "codeberg.org", pr: 4, token: "f", tokenSource: "FORGEJO_TOKEN" });
    const forge = forgeClient(t, fakeFetch({}).fetch);
    expect(forge.principalOf("Ana")).toBe("forgejo@codeberg.org:ana");
  });

  test("GitLab: the merge request's project, its iid, and the job token in its own header", async () => {
    const t = forgeTargetFromEnv({
      GITLAB_CI: "true",
      CI_API_V4_URL: "https://gitlab.example.com/api/v4",
      CI_SERVER_URL: "https://gitlab.example.com",
      CI_PROJECT_ID: "9",
      CI_MERGE_REQUEST_PROJECT_ID: "42",
      CI_MERGE_REQUEST_IID: "5",
      CI_COMMIT_SHA: SHA,
      CI_JOB_TOKEN: "job",
    });
    expect(t).toMatchObject({ kind: "gitlab", repo: "42", pr: 5, sha: SHA, host: "gitlab.example.com", tokenSource: "CI_JOB_TOKEN", tokenHeader: "JOB-TOKEN" });
    const { fetch, calls } = fakeFetch({ "GET /api/v4/projects/42/merge_requests/5/notes": [], "POST /api/v4/projects/42/merge_requests/5/notes": { id: 1 } });
    await forgeClient(t, fetch).upsertComment(5, "<!-- m -->", "<!-- m -->");
    expect(calls[0].headers["JOB-TOKEN"]).toBe("job");
    expect(calls[0].headers["PRIVATE-TOKEN"]).toBeUndefined();
  });

  test("the default token order: CHANT_GITHUB_TOKEN on GitHub, FORGEJO_TOKEN before GITHUB_TOKEN on Forgejo (#3802)", () => {
    const base = { GITHUB_REPOSITORY: "a/b", GITHUB_SERVER_URL: "https://codeberg.org" };
    expect(forgeTargetFromEnv({ GITHUB_ACTIONS: "true", ...base, CHANT_FORGEJO_TOKEN: "fj", GITHUB_TOKEN: "gh" }).tokenSource).toBe("GITHUB_TOKEN");
    expect(forgeTargetFromEnv({ GITHUB_ACTIONS: "true", ...base, CHANT_GITHUB_TOKEN: "c", GH_TOKEN: "g" }).tokenSource).toBe("CHANT_GITHUB_TOKEN");
    expect(forgeTargetFromEnv({ FORGEJO_ACTIONS: "true", ...base, FORGEJO_TOKEN: "f", GITHUB_TOKEN: "g" }).tokenSource).toBe("FORGEJO_TOKEN");
    expect(forgeTargetFromEnv({ FORGEJO_ACTIONS: "true", ...base, CHANT_FORGEJO_TOKEN: "c", FORGEJO_TOKEN: "f" }).tokenSource).toBe("CHANT_FORGEJO_TOKEN");
  });

  test("says every missing piece, and when the forge is unknown", () => {
    let err: unknown;
    try {
      forgeTargetFromEnv({ GITHUB_ACTIONS: "true" }, { requirePr: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForgeEnvironmentError);
    expect((err as ForgeEnvironmentError).missing).toEqual([
      "GITHUB_REPOSITORY",
      "a pull request (a pull_request event, or refs/pull/<n>/ in GITHUB_REF)",
      "a token (CHANT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN)",
    ]);
    expect(() => forgeTargetFromEnv({})).toThrow(/forge is not known/);
  });
});

describe("addComment and findIssue (#3818)", () => {
  const gh = { apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k" };

  test("addComment posts a new comment every time, with no read and no marker", async () => {
    const { fetch, calls } = fakeFetch({ "POST /repos/acme/infra/issues/12/comments": { id: 9, html_url: "https://h/9" } });
    const forge = githubForge({ ...gh, fetch });
    expect(await forge.addComment(12, "terragucci: locked")).toEqual({ id: 9, url: "https://h/9" });
    await forge.addComment(12, "terragucci: locked");
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(calls[0].body).toEqual({ body: "terragucci: locked" });
  });

  test("addComment on Forgejo and GitLab", async () => {
    const fj = fakeFetch({ "POST /api/v1/repos/acme/infra/issues/4/comments": { id: 2, html_url: "https://cb/2" } });
    expect(await forgejoForge({ ...gh, apiBase: "https://codeberg.org/api/v1", host: "codeberg.org", fetch: fj.fetch }).addComment(4, "hi")).toEqual({ id: 2, url: "https://cb/2" });
    const gl = fakeFetch({ "POST /api/v4/projects/42/merge_requests/5/notes": { id: 77, body: "hi" } });
    const r = await gitlabForge({ apiBase: "https://gl/api/v4", project: "42", token: "t", fetch: gl.fetch }).addComment(5, "hi");
    expect(r).toEqual({ id: 77 });
    expect(gl.calls).toHaveLength(1);
    expect(gl.calls[0].body).toEqual({ body: "hi" });
  });

  test("trackIssue says when the issue was opened", async () => {
    const open = { number: 8, title: "Drift", body: "<!-- d -->\nold", html_url: "https://h/issues/8", created_at: "2026-10-01T00:00:00Z" };
    const upd = fakeFetch({ "GET /repos/acme/infra/issues": [open], "PATCH /repos/acme/infra/issues/8": { ...open, body: "<!-- d -->\nnew" } });
    expect(await githubForge({ ...gh, fetch: upd.fetch }).trackIssue("<!-- d -->", { title: "Drift", body: "<!-- d -->\nnew" })).toEqual({
      action: "updated", number: 8, url: "https://h/issues/8", created: "2026-10-01T00:00:00Z",
    });
    const made = fakeFetch({ "GET /repos/acme/infra/issues": [], "POST /repos/acme/infra/issues": { ...open, number: 9, html_url: "https://h/issues/9", created_at: "2026-10-11T00:00:00Z" } });
    expect(await githubForge({ ...gh, fetch: made.fetch }).trackIssue("<!-- d -->", { title: "Drift", body: "<!-- d -->\nb" })).toMatchObject({ action: "opened", number: 9, created: "2026-10-11T00:00:00Z" });
    const gl = fakeFetch({ "GET /api/v4/projects/42/issues": [{ iid: 3, title: "Drift", description: "<!-- d -->\nold", web_url: "https://gl/i/3", created_at: "2026-09-30T00:00:00Z" }] });
    const r = await gitlabForge({ apiBase: "https://gl/api/v4", project: "42", token: "t", fetch: gl.fetch }).trackIssue("<!-- d -->", null);
    expect(r).toEqual({ action: "left", number: 3, url: "https://gl/i/3", created: "2026-09-30T00:00:00Z" });
  });

  test("findIssue reads the oldest open match with no write and no token", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/issues": [
        { number: 5, title: "PR", body: "<!-- d -->", pull_request: {} },
        { number: 7, title: "newer", body: "<!-- d -->\nb", user: { login: "bot" }, created_at: "2026-10-05T00:00:00Z", html_url: "https://h/issues/7" },
        { number: 6, title: "planted", body: "<!-- d -->\nx", user: { login: "mallory" }, created_at: "2026-10-04T00:00:00Z" },
      ],
    });
    const forge = githubForge({ apiBase: "https://api.github.com", repo: "acme/infra", fetch });
    expect(await forge.findIssue("<!-- d -->", { author: "bot" })).toEqual({ number: 7, title: "newer", body: "<!-- d -->\nb", created: "2026-10-05T00:00:00Z", url: "https://h/issues/7" });
    expect((await forge.findIssue("<!-- d -->"))?.number).toBe(6);
    expect(await forge.findIssue("<!-- none -->")).toBeUndefined();
    expect(calls.every((c) => c.method === "GET" && !("Authorization" in c.headers))).toBe(true);
  });

  test("findIssue on GitLab and Forgejo, tokenless", async () => {
    const gl = fakeFetch({ "GET /api/v4/projects/42/issues": [{ iid: 3, title: "Drift", description: "<!-- d -->\nb", web_url: "https://gl/i/3", created_at: "2026-09-30T00:00:00Z" }] });
    const g = gitlabForge({ apiBase: "https://gl/api/v4", project: "42", fetch: gl.fetch });
    expect(await g.findIssue("<!-- d -->")).toEqual({ number: 3, title: "Drift", body: "<!-- d -->\nb", created: "2026-09-30T00:00:00Z", url: "https://gl/i/3" });
    expect(Object.keys(gl.calls[0].headers)).toEqual([]);
    const fj = fakeFetch({ "GET /api/v1/repos/acme/infra/issues": [{ number: 2, title: "t", body: "<!-- d -->", created_at: "2026-10-02T00:00:00Z" }] });
    const f = forgejoForge({ apiBase: "https://codeberg.org/api/v1", repo: "acme/infra", host: "codeberg.org", fetch: fj.fetch });
    expect((await f.findIssue("<!-- d -->"))?.created).toBe("2026-10-02T00:00:00Z");
    expect(fj.calls[0].headers.Authorization).toBeUndefined();
  });
});

describe("status states and author lists (#3834)", () => {
  const gh = { apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k" };

  test("each state goes to each forge as its nearest state", () => {
    const table = Object.fromEntries(FORGE_STATUS_STATES.map((s) => [s, [statusStateFor("github", s), statusStateFor("forgejo", s), statusStateFor("gitlab", s)]]));
    expect(table).toEqual({
      pending: ["pending", "pending", "pending"],
      running: ["pending", "pending", "running"],
      success: ["success", "success", "success"],
      failed: ["failure", "failure", "failed"],
      failure: ["failure", "failure", "failed"],
      canceled: ["error", "error", "canceled"],
      error: ["error", "error", "failed"],
    });
    expect(() => statusStateFor("gitlab", "skipped" as ForgeStatusState)).toThrow(/one of pending, running/);
  });

  test("a running status is running on GitLab and pending on GitHub and Forgejo", async () => {
    const gl = fakeFetch({ [`POST /api/v4/projects/42/statuses/${SHA}`]: {} });
    await gitlabForge({ apiBase: "https://gl/api/v4", project: "42", token: "t", fetch: gl.fetch }).setStatus(SHA, { context: "terragucci/plan", state: "running", description: "planning" });
    await gitlabForge({ apiBase: "https://gl/api/v4", project: "42", token: "t", fetch: gl.fetch }).setStatus(SHA, { context: "terragucci/plan", state: "canceled", description: "stopped" });
    expect(gl.calls.map((c) => (c.body as { state: string }).state)).toEqual(["running", "canceled"]);
    const g = fakeFetch({ [`POST /repos/acme/infra/statuses/${SHA}`]: {} });
    await githubForge({ ...gh, fetch: g.fetch }).setStatus(SHA, { context: "terragucci/plan", state: "running", description: "planning" });
    await githubForge({ ...gh, fetch: g.fetch }).setStatus(SHA, { context: "terragucci/plan", state: "failed", description: "no" });
    expect(g.calls.map((c) => (c.body as { state: string }).state)).toEqual(["pending", "failure"]);
    const fj = fakeFetch({ [`POST /api/v1/repos/acme/infra/statuses/${SHA}`]: {} });
    await forgejoForge({ ...gh, apiBase: "https://codeberg.org/api/v1", host: "codeberg.org", fetch: fj.fetch }).setStatus(SHA, { context: "c", state: "running", description: "d" });
    expect(fj.calls[0].body).toMatchObject({ state: "pending" });
  });

  const BOTS = ["github-actions[bot]", "gitea-actions", "forgejo-actions"];

  test("a comment by any of several logins is the caller's own, without case", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/v1/repos/acme/infra/issues/4/comments": [
        { id: 1, body: "<!-- tg -->\nplanted", user: { login: "mallory" } },
        { id: 2, body: "<!-- tg -->\nold", user: { login: "Forgejo-Actions" } },
      ],
      "PATCH /api/v1/repos/acme/infra/issues/comments/2": { id: 2, html_url: "https://cb/2" },
    });
    const forge = forgejoForge({ ...gh, apiBase: "https://codeberg.org/api/v1", host: "codeberg.org", fetch });
    expect(await forge.findComment(4, "<!-- tg -->", { author: BOTS })).toEqual({ id: 2, body: "<!-- tg -->\nold" });
    expect(await forge.upsertComment(4, "<!-- tg -->", "<!-- tg -->\nnew", { author: BOTS })).toEqual({ action: "updated", id: 2, url: "https://cb/2" });
    expect(calls.at(-1)?.url).toBe("https://codeberg.org/api/v1/repos/acme/infra/issues/comments/2");
    expect(await forge.findComment(4, "<!-- tg -->", { author: [] })).toBeUndefined();
    expect((await forge.findComment(4, "<!-- tg -->", { author: "mallory" }))?.id).toBe(1);
  });

  test("an issue by any of several logins, for findIssue and trackIssue", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/infra/issues": [
        { number: 3, title: "Drift", body: "<!-- d -->\nplanted", user: { login: "mallory" } },
        { number: 4, title: "Drift", body: "<!-- d -->\nold", user: { login: "github-actions[bot]" } },
      ],
      "PATCH /repos/acme/infra/issues/4": { number: 4 },
    });
    const forge = githubForge({ ...gh, fetch });
    expect((await forge.findIssue("<!-- d -->", { author: BOTS }))?.number).toBe(4);
    expect(await forge.trackIssue("<!-- d -->", { title: "Drift", body: "<!-- d -->\nnew" }, { author: BOTS })).toMatchObject({ action: "updated", number: 4 });
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "https://api.github.com/repos/acme/infra/issues/4" });
  });
});

describe("pull requests over REST (#3798)", () => {
  const gh = { apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k" };
  const fjOpts = { ...gh, apiBase: "https://forge.example/api/v1", host: "forge.example" };
  const gl = { apiBase: "https://gl/api/v4", project: "group/infra", token: "t" };

  test("Forgejo opens a pull request into the default branch read from the repository", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/v1/repos/acme/infra": { default_branch: "trunk" },
      "POST /api/v1/repos/acme/infra/pulls": (c: Call) => ({ number: 9, html_url: "https://forge.example/acme/infra/pulls/9", title: (c.body as { title: string }).title, body: "b", head: { ref: "chant/x" }, base: { ref: "trunk" } }),
    });
    const pr = await forgejoForge({ ...fjOpts, fetch }).openPullRequest({ head: "chant/x", title: "t", body: "b" });
    expect(pr).toEqual({ number: 9, url: "https://forge.example/acme/infra/pulls/9", title: "t", body: "b", head: "chant/x", base: "trunk" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://forge.example/api/v1/repos/acme/infra", "POST https://forge.example/api/v1/repos/acme/infra/pulls"]);
    expect(calls[1].body).toEqual({ title: "t", body: "b", head: "chant/x", base: "trunk" });
    expect(calls[1].headers.Authorization).toBe("token t0k");
  });

  test("a draft is GitHub's draft field, Forgejo's WIP: and GitLab's Draft: prefix", async () => {
    const g = fakeFetch({ "POST /repos/acme/infra/pulls": { number: 1 } });
    await githubForge({ ...gh, fetch: g.fetch }).openPullRequest({ head: "h", base: "main", title: "t", body: "b", draft: true });
    expect(g.calls[0].body).toEqual({ title: "t", body: "b", head: "h", base: "main", draft: true });
    const f = fakeFetch({ "POST /api/v1/repos/acme/infra/pulls": { number: 1 } });
    await forgejoForge({ ...fjOpts, fetch: f.fetch }).openPullRequest({ head: "h", base: "main", title: "t", body: "b", draft: true });
    expect(f.calls[0].body).toEqual({ title: "WIP: t", body: "b", head: "h", base: "main" });
    const l = fakeFetch({ "POST /api/v4/projects/group%2Finfra/merge_requests": { iid: 4, web_url: "https://gl/mr/4", source_branch: "h", target_branch: "main", title: "Draft: t", description: "b" } });
    const mr = await gitlabForge({ ...gl, fetch: l.fetch }).openPullRequest({ head: "h", base: "main", title: "t", body: "b", draft: true });
    expect(l.calls[0].body).toEqual({ source_branch: "h", target_branch: "main", title: "Draft: t", description: "b" });
    expect(mr).toEqual({ number: 4, url: "https://gl/mr/4", title: "Draft: t", body: "b", head: "h", base: "main" });
  });

  test("GitLab reads the default branch off the project", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /api/v4/projects/group%2Finfra": { default_branch: "main" },
      "POST /api/v4/projects/group%2Finfra/merge_requests": { iid: 2 },
    });
    await gitlabForge({ ...gl, fetch }).openPullRequest({ head: "h", title: "t", body: "b" });
    expect((calls[1].body as { target_branch: string }).target_branch).toBe("main");
  });

  test("openPullRequests lists the heads into a base and marks forks; branchHead reads a branch's commit (#4095)", async () => {
    const f = fakeFetch({
      "GET /api/v1/repos/acme/infra/pulls": [
        { number: 12, head: { ref: "x", sha: "c".repeat(40), repo: { full_name: "mallory/infra" } }, base: { ref: "main", sha: "b".repeat(40) }, user: { login: "mallory" } },
        { number: 4, head: { ref: "y", sha: "d".repeat(40), repo: { full_name: "acme/infra" } }, base: { ref: "main", sha: "b".repeat(40) }, user: { login: "driver" } },
        { number: 5, head: { ref: "z", sha: "e".repeat(40) }, base: { ref: "release" } },
      ],
      "GET /api/v1/repos/acme/infra/branches/main": { name: "main", commit: { id: "f".repeat(40) } },
    });
    const forge = forgejoForge({ ...fjOpts, fetch: f.fetch });
    expect(await forge.openPullRequests!("main")).toEqual([
      { number: 4, head: "y", headSha: "d".repeat(40), base: "main", baseSha: "b".repeat(40), author: "driver", fork: false },
      { number: 12, head: "x", headSha: "c".repeat(40), base: "main", baseSha: "b".repeat(40), author: "mallory", fork: true },
    ]);
    expect(f.calls[0].url).toBe("https://forge.example/api/v1/repos/acme/infra/pulls?state=open&limit=50&page=1");
    expect(await forge.branchHead!("main")).toBe("f".repeat(40));
    expect(await forge.branchHead!("gone")).toBeUndefined();

    const g = fakeFetch({ "GET /repos/acme/infra/pulls": [], "GET /repos/acme/infra/branches/main": { commit: { sha: SHA } } });
    const github = githubForge({ ...gh, fetch: g.fetch });
    expect(await github.openPullRequests!("main")).toEqual([]);
    expect(g.calls[0].url).toBe("https://api.github.com/repos/acme/infra/pulls?state=open&base=main&per_page=100&page=1");
    expect(await github.branchHead!("main")).toBe(SHA);
  });

  test("findPullRequest takes the oldest open one from this repository, not a fork's", async () => {
    const f = fakeFetch({
      "GET /api/v1/repos/acme/infra/pulls": [
        { number: 12, title: "fork", body: "", head: { ref: "chant/x", repo: { full_name: "mallory/infra" } } },
        { number: 11, title: "newer", body: "", head: { ref: "chant/x", repo: { full_name: "acme/infra" } } },
        { number: 10, title: "mine", body: "b", head: { ref: "chant/x", repo: { full_name: "acme/infra" } }, base: { ref: "main" }, html_url: "https://forge.example/acme/infra/pulls/10" },
        { number: 3, title: "other", body: "", head: { ref: "other", repo: { full_name: "acme/infra" } } },
      ],
    });
    const forge = forgejoForge({ ...fjOpts, fetch: f.fetch });
    expect(await forge.findPullRequest("chant/x")).toEqual({ number: 10, title: "mine", body: "b", head: "chant/x", base: "main", url: "https://forge.example/acme/infra/pulls/10" });
    expect(f.calls[0].url).toBe("https://forge.example/api/v1/repos/acme/infra/pulls?state=open&limit=50&page=1");
    expect(await forge.findPullRequest("none")).toBeUndefined();

    const g = fakeFetch({ "GET /repos/acme/infra/pulls": [] });
    expect(await githubForge({ ...gh, fetch: g.fetch }).findPullRequest("chant/x")).toBeUndefined();
    expect(g.calls[0].url).toBe("https://api.github.com/repos/acme/infra/pulls?state=open&head=acme%3Achant%2Fx&per_page=100&page=1");

    const l = fakeFetch({
      "GET /api/v4/projects/group%2Finfra/merge_requests": [
        { iid: 8, source_branch: "chant/x", project_id: 1, source_project_id: 2, title: "fork", description: "" },
        { iid: 7, source_branch: "chant/x", project_id: 1, source_project_id: 1, title: "mine", description: "d", target_branch: "main" },
      ],
    });
    expect(await gitlabForge({ ...gl, fetch: l.fetch }).findPullRequest("chant/x")).toEqual({ number: 7, title: "mine", body: "d", head: "chant/x", base: "main" });
    expect(l.calls[0].url).toBe("https://gl/api/v4/projects/group%2Finfra/merge_requests?state=opened&source_branch=chant%2Fx&per_page=100&page=1");
  });

  test("editPullRequest and addLabels on each forge", async () => {
    const f = fakeFetch({ "PATCH /api/v1/repos/acme/infra/pulls/10": { number: 10, title: "t2" }, "POST /api/v1/repos/acme/infra/issues/10/labels": [] });
    const forge = forgejoForge({ ...fjOpts, fetch: f.fetch });
    expect((await forge.editPullRequest(10, { title: "t2", body: "b2" }))?.title).toBe("t2");
    await forge.addLabels(10, ["minor"]);
    await forge.addLabels(10, []);
    expect(f.calls.map((c) => [c.method, c.body])).toEqual([["PATCH", { title: "t2", body: "b2" }], ["POST", { labels: ["minor"] }]]);
    const l = fakeFetch({ "PUT /api/v4/projects/group%2Finfra/merge_requests/7": { iid: 7 } });
    const g = gitlabForge({ ...gl, fetch: l.fetch });
    await g.editPullRequest(7, { body: "d" });
    await g.addLabels(7, ["minor", "breaking"]);
    expect(l.calls.map((c) => c.body)).toEqual([{ description: "d" }, { add_labels: "minor,breaking" }]);
  });

  test("labels reads the names a pull request carries on each forge (#4292)", async () => {
    const f = fakeFetch({ "GET /api/v1/repos/acme/infra/issues/10/labels": [{ name: "plan:prod" }, { name: "bug" }, { id: 3 }] });
    expect(await forgejoForge({ ...fjOpts, fetch: f.fetch }).labels!(10)).toEqual(["plan:prod", "bug"]);
    const l = fakeFetch({ "GET /api/v4/projects/group%2Finfra/merge_requests/7": { iid: 7, labels: ["plan:prod", 4] } });
    expect(await gitlabForge({ ...gl, fetch: l.fetch }).labels!(7)).toEqual(["plan:prod"]);
  });

  test("Forgejo's 404 on the pull list of a just-pushed empty repository is no pull request (#3845)", async () => {
    const empty = fakeFetch({ "GET /api/v1/repos/acme/infra": { default_branch: "main" } });
    expect(await forgejoForge({ ...fjOpts, fetch: empty.fetch }).findPullRequest("chant/x")).toBeUndefined();
    // A repository that is really missing 404s on its own read, and that still throws.
    const gone = fakeFetch({});
    await expect(forgejoForge({ ...fjOpts, fetch: gone.fetch }).findPullRequest("chant/x")).rejects.toThrow(/404/);
    // GitHub's list 404 stays an error.
    await expect(githubForge({ ...gh, fetch: fakeFetch({}).fetch }).findPullRequest("chant/x")).rejects.toThrow(/404/);
  });

  const answering = (status: number, body: unknown, calls: Call[] = []): ForgeFetch => async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    return { ok: status < 400, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) };
  };

  test("mergePullRequest merges only at the reviewed sha on GitHub", async () => {
    const f = fakeFetch({
      "PUT /repos/acme/infra/pulls/5/merge": { merged: true, sha: "m1" },
      "GET /repos/acme/infra/pulls/5": { number: 5, head: { ref: "chant/x", repo: { full_name: "acme/infra" } } },
      "DELETE /repos/acme/infra/git/refs/heads/chant/x": null,
    });
    const r = await githubForge({ ...gh, fetch: f.fetch }).mergePullRequest(5, { sha: SHA, method: "squash", title: "t", message: "m", deleteBranch: true });
    expect(r).toEqual({ merged: true, sha: "m1" });
    expect(f.calls[0].body).toEqual({ sha: SHA, merge_method: "squash", commit_title: "t", commit_message: "m" });
    expect(f.calls.map((c) => c.method)).toEqual(["PUT", "GET", "DELETE"]);
    const calls: Call[] = [];
    const moved = await githubForge({ ...gh, fetch: answering(409, { message: "Head branch was modified. Review and try the merge again." }, calls) }).mergePullRequest(5, { sha: SHA });
    expect(moved).toEqual({ merged: false, reason: "Head branch was modified. Review and try the merge again." });
    expect(calls[0].body).toEqual({ sha: SHA, merge_method: "merge" });
    const blocked = await githubForge({ ...gh, fetch: answering(405, { message: "Required status check is expected." }) }).mergePullRequest(5, { sha: SHA });
    expect(blocked.merged).toBe(false);
    await expect(githubForge({ ...gh, fetch: answering(401, { message: "Bad credentials" }) }).mergePullRequest(5, { sha: SHA })).rejects.toThrow(/401/);
  });

  test("mergePullRequest on Forgejo sends head_commit_id and reads the merge commit back", async () => {
    const f = fakeFetch({
      "POST /api/v1/repos/acme/infra/pulls/5/merge": null,
      "GET /api/v1/repos/acme/infra/pulls/5": { number: 5, merge_commit_sha: "m2" },
    });
    const r = await forgejoForge({ ...fjOpts, fetch: f.fetch }).mergePullRequest(5, { sha: SHA, method: "rebase", title: "t", message: "m", deleteBranch: true });
    expect(r).toEqual({ merged: true, sha: "m2" });
    expect(f.calls[0].body).toEqual({ Do: "rebase", head_commit_id: SHA, MergeTitleField: "t", MergeMessageField: "m", delete_branch_after_merge: true });
    const moved = await forgejoForge({ ...fjOpts, fetch: answering(409, { message: "head commit id does not match" }) }).mergePullRequest(5, { sha: SHA });
    expect(moved).toEqual({ merged: false, reason: "head commit id does not match" });
    expect((await forgejoForge({ ...fjOpts, fetch: answering(405, undefined) }).mergePullRequest(5, { sha: SHA })).merged).toBe(false);
  });

  test("mergePullRequest on GitLab passes sha and squash, and refuses rebase", async () => {
    const f = fakeFetch({ "PUT /api/v4/projects/group%2Finfra/merge_requests/7/merge": { state: "merged", merge_commit_sha: "m3" } });
    const g = gitlabForge({ ...gl, fetch: f.fetch });
    expect(await g.mergePullRequest(7, { sha: SHA, method: "squash", title: "t", message: "m", deleteBranch: true })).toEqual({ merged: true, sha: "m3" });
    expect(f.calls[0].body).toEqual({ sha: SHA, squash: true, squash_commit_message: "t\n\nm", merge_commit_message: "t\n\nm", should_remove_source_branch: true });
    const moved = await gitlabForge({ ...gl, fetch: answering(409, { message: "SHA does not match HEAD of source branch" }) }).mergePullRequest(7, { sha: SHA });
    expect(moved).toEqual({ merged: false, reason: "SHA does not match HEAD of source branch" });
    expect((await gitlabForge({ ...gl, fetch: answering(405, { message: "Branch cannot be merged" }) }).mergePullRequest(7, { sha: SHA })).merged).toBe(false);
    await expect(g.mergePullRequest(7, { sha: SHA, method: "rebase" })).rejects.toThrow(/rebase/);
  });

  test("a repository with no default branch is refused by name", async () => {
    const { fetch } = fakeFetch({ "GET /api/v1/repos/acme/infra": {} });
    await expect(forgejoForge({ ...fjOpts, fetch }).openPullRequest({ head: "h", title: "t", body: "b" })).rejects.toThrow(/no default branch.*pass base/);
  });
});

describe("setCommitStatus, a runner job's status (#4097)", () => {
  const long = "x".repeat(300);

  test("GitHub posts state, context, a description cut to 140 and target_url", async () => {
    const { fetch, calls } = fakeFetch({ [`POST /repos/acme/infra/statuses/${SHA}`]: {} });
    const forge = githubForge({ apiBase: "https://api.github.com", repo: "acme/infra", token: "t0k", fetch });
    await forge.setCommitStatus!(SHA, { context: "chant/pr-plan", state: "failure", description: long, targetUrl: "https://host/reports/7/abc/" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `https://api.github.com/repos/acme/infra/statuses/${SHA}` });
    expect(calls[0].headers.Authorization).toBe("Bearer t0k");
    expect(calls[0].body).toEqual({ state: "failure", context: "chant/pr-plan", description: "x".repeat(140), target_url: "https://host/reports/7/abc/" });
  });

  test("Forgejo posts to /repos/{owner}/{repo}/statuses/{sha} under /api/v1, and omits target_url when there is none", async () => {
    const { fetch, calls } = fakeFetch({ [`POST /api/v1/repos/acme/infra/statuses/${SHA}`]: {} });
    const forge = forgejoForge({ apiBase: "https://codeberg.org/api/v1", repo: "acme/infra", token: "t0k", host: "codeberg.org", fetch });
    await forge.setCommitStatus!(SHA, { context: "chant/pr-apply", state: "pending", description: "pr-apply running" });
    expect(calls[0]).toMatchObject({ method: "POST", url: `https://codeberg.org/api/v1/repos/acme/infra/statuses/${SHA}` });
    expect(calls[0].headers.Authorization).toBe("token t0k");
    expect(calls[0].body).toEqual({ state: "pending", context: "chant/pr-apply", description: "pr-apply running" });
  });

  test("a refusal throws, and GitLab's client has none", async () => {
    const { fetch } = fakeFetch({ [`POST /repos/acme/infra/statuses/${SHA}`]: 403 });
    await expect(githubForge({ apiBase: "https://api.github.com", repo: "acme/infra", token: "t", fetch }).setCommitStatus!(SHA, { context: "c", state: "success", description: "d" })).rejects.toBeInstanceOf(ForgeApiError);
    expect(gitlabForge({ apiBase: "https://gl/api/v4", project: "42", token: "t", fetch }).setCommitStatus).toBeUndefined();
  });
});
