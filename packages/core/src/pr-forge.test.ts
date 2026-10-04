/**
 * The forge clients of the pull-request loop (#3183), driven through a
 * recording `fetch`: the calls each makes on GitHub, Forgejo and GitLab, and
 * what each reads back.
 */

import { describe, expect, test } from "vitest";
import {
  ForgeApiError,
  forgeFromEnv,
  forgejoForge,
  forgePrincipalOf,
  githubForge,
  gitlabForge,
  type ForgeFetch,
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
