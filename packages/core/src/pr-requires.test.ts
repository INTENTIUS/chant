/**
 * The requires checks of an apply before merge (#4301, ws-106): the four
 * PrForge methods on GitHub, Forgejo and GitLab, driven through a recording
 * fake forge, and checkPrRequires over them.
 */

import { describe, expect, test } from "vitest";
import { forgejoForge, githubForge, gitlabForge, type ForgeFetch, type PrForge } from "./pr-forge";
import { checkPrRequires, parseRequiresList, PR_APPLY_REQUIRES, unmetRequires } from "./pr-requires";
import { parseArgs } from "./cli/parse-args";

/** A fake forge: `routes` maps `METHOD path-without-query` to a body, a status, or a function of the query. */
function fakeFetch(routes: Record<string, unknown | ((q: URLSearchParams) => unknown)>): ForgeFetch {
  return async (url, init) => {
    const u = new URL(url);
    let found = routes[`${init.method} ${u.pathname}`];
    if (typeof found === "function") found = (found as (q: URLSearchParams) => unknown)(u.searchParams);
    if (found === undefined) return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
    if (typeof found === "number") return { ok: false, status: found, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(found) };
  };
}

const HEAD = "a".repeat(40);
const TIP = "b".repeat(40);
const OTHER = "c".repeat(40);

describe("github", () => {
  const repo = "/repos/acme/infra";
  const pull = (over: Record<string, unknown> = {}) => ({ number: 7, state: "open", user: { login: "alice" }, head: { ref: "f", sha: HEAD }, base: { ref: "main" }, mergeable: true, mergeable_state: "clean", ...over });
  const forge = (routes: Record<string, unknown>) =>
    githubForge({ apiBase: "https://api.github.com", repo: "acme/infra", token: "t", fetch: fakeFetch({ [`GET ${repo}/pulls/7`]: pull(), [`GET ${repo}/pulls/7/commits`]: [{ author: { login: "alice" }, committer: { login: "alice" } }], ...routes }) });

  test("approved: a reviewer other than the authors approved this head", async () => {
    const f = forge({ [`GET ${repo}/pulls/7/reviews`]: [{ user: { login: "bob" }, state: "APPROVED", commit_id: HEAD }] });
    expect(await f.prApproved!(7, HEAD)).toEqual({ passed: true, reason: "approved at aaaaaaaa by bob", approvers: ["bob"], excluded: [] });
  });

  test("approved: an approval of an older head, the author's own, or a request for changes does not pass", async () => {
    const older = forge({ [`GET ${repo}/pulls/7/reviews`]: [{ user: { login: "bob" }, state: "APPROVED", commit_id: OTHER }, { user: { login: "alice" }, state: "APPROVED", commit_id: HEAD }] });
    expect((await older.prApproved!(7, HEAD)).passed).toBe(false);
    const changes = forge({ [`GET ${repo}/pulls/7/reviews`]: [{ user: { login: "bob" }, state: "APPROVED", commit_id: HEAD }, { user: { login: "carol" }, state: "CHANGES_REQUESTED", commit_id: HEAD }] });
    expect(await changes.prApproved!(7, HEAD)).toEqual({ passed: false, reason: "carol asked for changes", approvers: [], excluded: [] });
  });

  test("approved: forgeRule counts only writers, exclude leaves a login out, and the refusal says why (#4337)", async () => {
    const reviews = [
      { user: { login: "bob" }, state: "APPROVED", commit_id: HEAD },
      { user: { login: "Carol" }, state: "APPROVED", commit_id: HEAD },
      { user: { login: "alice" }, state: "APPROVED", commit_id: HEAD },
    ];
    const f = forge({
      [`GET ${repo}/pulls/7/reviews`]: reviews,
      [`GET ${repo}/collaborators/bob/permission`]: { permission: "read", role_name: "triage" },
      [`GET ${repo}/collaborators/Carol/permission`]: { permission: "write", role_name: "maintain" },
    });
    expect(await f.prApproved!(7, HEAD, { forgeRule: true })).toEqual({
      passed: true,
      reason: "approved at aaaaaaaa by Carol",
      approvers: ["Carol"],
      excluded: [
        { login: "alice", reason: "alice is one of its authors" },
        { login: "bob", reason: "bob has no write access" },
      ],
    });
    expect(await f.prApproved!(7, HEAD, { forgeRule: true, exclude: [{ login: "carol", reason: "carol asked for aaaaaaa" }] })).toEqual({
      passed: false,
      reason: "no reviewer other than its authors approved its head aaaaaaaa: carol asked for aaaaaaa; alice is one of its authors; bob has no write access",
      approvers: [],
      excluded: [
        { login: "Carol", reason: "carol asked for aaaaaaa" },
        { login: "alice", reason: "alice is one of its authors" },
        { login: "bob", reason: "bob has no write access" },
      ],
    });
    expect((await f.prApproved!(7, HEAD, { exclude: ["bob"] })).reason).toBe("approved at aaaaaaaa by Carol");
  });

  test("every check fails when the forge's head is another commit", async () => {
    const f = forge({ [`GET ${repo}/pulls/7`]: pull({ head: { ref: "f", sha: OTHER } }) });
    const r = await f.prMergeable!(7, HEAD);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("head is cccccccc, not aaaaaaaa");
  });

  test("mergeable: conflicts and branch protection refuse, an unknown answer is pending", async () => {
    expect((await forge({}).prMergeable!(7, HEAD)).passed).toBe(true);
    expect((await forge({ [`GET ${repo}/pulls/7`]: pull({ mergeable: false, mergeable_state: "dirty" }) }).prMergeable!(7, HEAD)).reason).toContain("conflicts with main");
    expect((await forge({ [`GET ${repo}/pulls/7`]: pull({ mergeable_state: "blocked" }) }).prMergeable!(7, HEAD)).reason).toContain("branch protection");
    expect(await forge({ [`GET ${repo}/pulls/7`]: pull({ mergeable: null }) }).prMergeable!(7, HEAD)).toMatchObject({ passed: false, pending: true });
  });

  test("undiverged: reads behind_by from the compare of the base branch with the head", async () => {
    expect((await forge({ [`GET ${repo}/compare/main...${HEAD}`]: { behind_by: 0 } }).prUndiverged!(7, HEAD)).passed).toBe(true);
    expect((await forge({ [`GET ${repo}/compare/main...${HEAD}`]: { behind_by: 2 } }).prUndiverged!(7, HEAD)).reason).toBe("aaaaaaaa is 2 commits behind main");
  });

  test("checks: statuses and check runs, the apply's own left out", async () => {
    const statuses = (state: string) => ({ statuses: [{ context: "ci/test", state }, { context: "chant/apply", state: "failure" }] });
    const runs = (conclusion: string | null, status = "completed") => ({ check_runs: [{ name: "lint", status, conclusion }] });
    const f = (state: string, run: unknown) => forge({ [`GET ${repo}/commits/${HEAD}/status`]: statuses(state), [`GET ${repo}/commits/${HEAD}/check-runs`]: run });
    expect(await f("success", runs("success")).prChecksPassed!(7, HEAD, ["chant/apply"])).toEqual({ passed: true, reason: "2 checks passed on aaaaaaaa" });
    expect((await f("success", runs("success")).prChecksPassed!(7, HEAD)).reason).toBe("chant/apply failed on aaaaaaaa");
    expect(await f("pending", runs("success")).prChecksPassed!(7, HEAD, ["chant/apply"])).toMatchObject({ passed: false, pending: true });
    expect((await f("success", runs(null, "in_progress")).prChecksPassed!(7, HEAD, ["chant/apply"])).pending).toBe(true);
    expect((await f("success", runs("failure")).prChecksPassed!(7, HEAD, ["chant/apply"])).reason).toBe("lint failed on aaaaaaaa");
  });

  test("checks: nothing reported is pending", async () => {
    const f = forge({ [`GET ${repo}/commits/${HEAD}/status`]: { statuses: [] }, [`GET ${repo}/commits/${HEAD}/check-runs`]: { check_runs: [] } });
    expect(await f.prChecksPassed!(7, HEAD)).toMatchObject({ passed: false, pending: true });
  });
});

describe("forgejo", () => {
  const repo = "/api/v1/repos/acme/infra";
  const pull = (over: Record<string, unknown> = {}) => ({ number: 4, user: { login: "alice" }, head: { ref: "f", sha: HEAD }, base: { ref: "main" }, mergeable: true, merge_base: TIP, ...over });
  const forge = (routes: Record<string, unknown>) =>
    forgejoForge({ apiBase: "https://code.example/api/v1", repo: "acme/infra", host: "code.example", token: "t", fetch: fakeFetch({ [`GET ${repo}/pulls/4`]: pull(), [`GET ${repo}/pulls/4/commits`]: [], [`GET ${repo}/branches/main`]: { commit: { id: TIP } }, ...routes }) });

  test("approved: Forgejo's REQUEST_CHANGES state refuses", async () => {
    const f = forge({ [`GET ${repo}/pulls/4/reviews`]: [{ user: { login: "bob" }, state: "APPROVED", commit_id: HEAD }, { user: { login: "dave" }, state: "REQUEST_CHANGES" }] });
    expect((await f.prApproved!(4, HEAD)).reason).toBe("dave asked for changes");
  });

  test("approved: forgeRule counts an official review only, through checkPrRequires' approvers (#4337)", async () => {
    const f = forge({ [`GET ${repo}/pulls/4/reviews`]: [{ user: { login: "bob" }, state: "APPROVED", commit_id: HEAD, official: false }, { user: { login: "erin" }, state: "APPROVED", commit_id: HEAD, official: true }] });
    expect((await f.prApproved!(4, HEAD, { forgeRule: true })).reason).toBe("approved at aaaaaaaa by erin");
    const out = await checkPrRequires(f, 4, HEAD, { only: ["approved"], approvers: { forgeRule: true, exclude: ["erin"] } });
    expect(out[0]).toMatchObject({
      reason: "no reviewer other than its authors approved its head aaaaaaaa: bob's review is not official; erin is excluded",
      approvers: [],
      excluded: [
        { login: "bob", reason: "bob's review is not official" },
        { login: "erin", reason: "erin is excluded" },
      ],
    });
  });

  test("undiverged: the pull request's merge base is the base branch's tip", async () => {
    expect((await forge({}).prUndiverged!(4, HEAD)).passed).toBe(true);
    expect((await forge({ [`GET ${repo}/pulls/4`]: pull({ merge_base: OTHER }) }).prUndiverged!(4, HEAD)).reason).toBe("aaaaaaaa does not contain main at bbbbbbbb");
  });

  test("mergeable: a false while Forgejo still checks is pending, and passes once it settles (#4335)", async () => {
    expect(await forge({ [`GET ${repo}/pulls/4`]: pull({ mergeable: false }) }).prMergeable!(4, HEAD)).toMatchObject({ passed: false, pending: true });
    expect(await forge({ [`GET ${repo}/pulls/4`]: pull({ mergeable: false, draft: true }) }).prMergeable!(4, HEAD)).toEqual({ passed: false, reason: "it is a draft" });
    let reads = 0;
    const flips = forge({ [`GET ${repo}/pulls/4`]: () => pull({ mergeable: ++reads > 2 }), [`GET ${repo}/pulls/4/reviews`]: [], [`GET ${repo}/commits/${HEAD}/status`]: { statuses: [{ context: "ci/test", status: "success" }] } });
    const out = await checkPrRequires(flips, 4, HEAD, { wait: async () => {} });
    expect(out.find((o) => o.name === "mergeable")).toEqual({ name: "mergeable", passed: true, reason: "it merges into main as it stands" });
  });

  test("mergeable: no branch protection reading, and checks from the combined status alone", async () => {
    expect((await forge({ [`GET ${repo}/pulls/4`]: pull({ mergeable_state: "blocked" }) }).prMergeable!(4, HEAD)).passed).toBe(true);
    const f = forge({ [`GET ${repo}/commits/${HEAD}/status`]: { statuses: [{ context: "ci/test", status: "success" }] } });
    expect(await f.prChecksPassed!(4, HEAD)).toEqual({ passed: true, reason: "1 check passed on aaaaaaaa" });
  });
});

describe("gitlab", () => {
  const project = "/api/v4/projects/9";
  const mr = (over: Record<string, unknown> = {}) => ({ iid: 3, sha: HEAD, author: { username: "alice" }, target_branch: "main", detailed_merge_status: "mergeable", diverged_commits_count: 0, ...over });
  const note = (who: string, body: string, at: string) => ({ system: true, author: { username: who }, body, created_at: at });
  const forge = (routes: Record<string, unknown>) =>
    gitlabForge({
      apiBase: "https://gitlab.example/api/v4",
      project: "9",
      token: "t",
      host: "gitlab.example",
      fetch: fakeFetch({
        [`GET ${project}/merge_requests/3`]: mr(),
        [`GET ${project}/merge_requests/3/commits`]: [],
        "GET /api/v4/user": { id: 1, username: "chant-bot" },
        [`GET ${project}/merge_requests/3/versions`]: [{ created_at: "2026-10-01T10:00:00Z", head_commit_sha: HEAD }],
        ...routes,
      }),
    });

  test("approved: an approval after the latest push, not the token user's or the author's", async () => {
    const f = forge({
      [`GET ${project}/merge_requests/3/notes`]: [
        note("erin", "approved this merge request", "2026-10-01T09:00:00Z"),
        note("chant-bot", "approved this merge request", "2026-10-01T11:00:00Z"),
        note("alice", "approved this merge request", "2026-10-01T11:00:00Z"),
      ],
    });
    expect((await f.prApproved!(3, HEAD)).passed).toBe(false);
    const g = forge({ [`GET ${project}/merge_requests/3/notes`]: [note("bob", "approved this merge request", "2026-10-01T11:00:00Z")] });
    expect(await g.prApproved!(3, HEAD)).toEqual({ passed: true, reason: "approved after aaaaaaaa by bob", approvers: ["bob"], excluded: [] });
    const h = forge({ [`GET ${project}/merge_requests/3/notes`]: [note("bob", "approved this merge request", "2026-10-01T11:00:00Z"), note("carol", "requested changes", "2026-10-01T12:00:00Z")] });
    expect((await h.prApproved!(3, HEAD)).reason).toBe("carol requested changes");
  });

  test("approved: forgeRule reads each approver's access level, Developer by default (#4337)", async () => {
    const at = "2026-10-01T11:00:00Z";
    const f = forge({
      [`GET ${project}/merge_requests/3/notes`]: [
        { ...note("bob", "approved this merge request", at), author: { username: "bob", id: 5 } },
        { ...note("dan", "approved this merge request", at), author: { username: "dan", id: 6 } },
        { ...note("eve", "approved this merge request", at), author: { username: "eve", id: 7 } },
      ],
      [`GET ${project}/members/all/5`]: { access_level: 20 },
      [`GET ${project}/members/all/6`]: { access_level: 40 },
    });
    expect((await f.prApproved!(3, HEAD, { forgeRule: true })).reason).toBe("approved after aaaaaaaa by dan");
    expect((await f.prApproved!(3, HEAD, { forgeRule: true, minAccessLevel: 50 })).reason).toBe(
      "no member other than its authors approved it after its latest push, aaaaaaaa: bob has access level 20, under 50; dan has access level 40, under 50; eve is not a member",
    );
    expect((await f.prApproved!(3, HEAD, { forgeRule: true })).excluded).toEqual([
      { login: "bob", reason: "bob has access level 20, under 30" },
      { login: "eve", reason: "eve is not a member" },
    ]);
  });

  test("approved: pending until GitLab's newest diff version is of the head, as terragucci checked (#4287)", async () => {
    const approval = note("bob", "approved this merge request", "2026-10-01T11:00:00Z");
    const versions = [
      { created_at: "2026-10-01T10:00:00Z", head_commit_sha: HEAD },
      { created_at: "2026-10-01T12:00:00Z", head_commit_sha: OTHER },
    ];
    const f = forge({ [`GET ${project}/merge_requests/3/notes`]: [approval], [`GET ${project}/merge_requests/3/versions`]: versions });
    expect(await f.prApproved!(3, HEAD)).toEqual({ passed: false, pending: true, reason: "merge request !3's newest diff version is of cccccccc, not aaaaaaaa", approvers: [], excluded: [] });
    const none = forge({ [`GET ${project}/merge_requests/3/notes`]: [approval], [`GET ${project}/merge_requests/3/versions`]: [] });
    expect(await none.prApproved!(3, HEAD)).toMatchObject({ passed: false, pending: true });
  });

  test("mergeable and undiverged read the merge request", async () => {
    expect((await forge({}).prMergeable!(3, HEAD)).passed).toBe(true);
    expect(await forge({ [`GET ${project}/merge_requests/3`]: mr({ detailed_merge_status: "checking" }) }).prMergeable!(3, HEAD)).toMatchObject({ passed: false, pending: true });
    expect((await forge({ [`GET ${project}/merge_requests/3`]: mr({ has_conflicts: true, detailed_merge_status: "conflict" }) }).prMergeable!(3, HEAD)).reason).toContain("conflicts");
    expect((await forge({}).prUndiverged!(3, HEAD)).passed).toBe(true);
    expect((await forge({ [`GET ${project}/merge_requests/3`]: mr({ diverged_commits_count: 1 }) }).prUndiverged!(3, HEAD)).reason).toBe("aaaaaaaa is 1 commit behind main");
  });

  test("checks: each name's newest status, a job allowed to fail holding nothing back", async () => {
    const f = forge({
      [`GET ${project}/repository/commits/${HEAD}/statuses`]: [
        { id: 1, name: "test", status: "failed" },
        { id: 2, name: "test", status: "success" },
        { id: 3, name: "flaky", status: "failed", allow_failure: true },
        { id: 4, name: "apply", status: "running" },
      ],
    });
    expect(await f.prChecksPassed!(3, HEAD, ["apply"])).toEqual({ passed: true, reason: "2 checks passed on aaaaaaaa" });
    expect((await f.prChecksPassed!(3, HEAD)).pending).toBe(true);
  });
});

describe("checkPrRequires", () => {
  const ok = { passed: true, reason: "ok" };
  test("asks each check once in order, and a pending one again until it settles", async () => {
    let reads = 0;
    const forge = {
      kind: "github",
      prApproved: async () => ok,
      prMergeable: async () => (++reads < 3 ? { passed: false, pending: true, reason: "working it out" } : ok),
      prUndiverged: async () => ok,
      prChecksPassed: async (_pr: number, _head: string, ignore?: readonly string[]) => ({ passed: true, reason: `ignored ${ignore?.join(",")}` }),
    } as unknown as PrForge;
    const out = await checkPrRequires(forge, 7, HEAD, { ignore: ["chant/apply"], wait: async () => {} });
    expect(out.map((o) => o.name)).toEqual([...PR_APPLY_REQUIRES]);
    expect(reads).toBe(3);
    expect(out[3]!.reason).toBe("ignored chant/apply");
    expect(unmetRequires(out)).toBeNull();
  });

  test("only: a check left out passes as not required and asks the forge nothing (#4336)", async () => {
    const calls: string[] = [];
    const ask = (name: string) => async () => (calls.push(name), { passed: false, reason: `${name} unmet` });
    const forge = { kind: "github", prApproved: ask("approved"), prMergeable: ask("mergeable"), prUndiverged: ask("undiverged"), prChecksPassed: ask("checks") } as unknown as PrForge;
    const out = await checkPrRequires(forge, 7, HEAD, { only: ["approved", "checks"], reads: 1 });
    expect(calls).toEqual(["approved", "checks"]);
    expect(out.map((o) => o.name)).toEqual([...PR_APPLY_REQUIRES]);
    expect(out[1]).toEqual({ name: "mergeable", passed: true, reason: "not required" });
    expect(unmetRequires(out)).toBe("approved: approved unmet; checks: checks unmet");
    expect(unmetRequires(await checkPrRequires(forge, 7, HEAD, { only: [] }))).toBeNull();
  });

  test("a client without a method, or a call that throws, is unmet", async () => {
    const forge = { kind: "gitlab", prApproved: async () => { throw new Error("401"); } } as unknown as PrForge;
    const out = await checkPrRequires(forge, 3, HEAD, { reads: 1 });
    expect(out.every((o) => !o.passed)).toBe(true);
    expect(unmetRequires(out)).toBe("approved: could not ask gitlab: 401; mergeable: this gitlab client cannot say; undiverged: this gitlab client cannot say; checks: this gitlab client cannot say");
  });
});

describe("--requires (#4607)", () => {
  test("names the checks in the four's order, comma lists and repeats folded", () => {
    expect(parseRequiresList(["checks,approved"])).toEqual({ checks: ["approved", "checks"] });
    expect(parseRequiresList(["mergeable", "mergeable, undiverged"])).toEqual({ checks: ["mergeable", "undiverged"] });
  });

  test("an unknown check, or none, is an error naming the four", () => {
    const unknown = parseRequiresList(["approved,green"]);
    expect("error" in unknown && unknown.error).toContain('"green" is not one of them');
    expect("error" in unknown && unknown.error).toContain("approved, mergeable, undiverged, checks");
    expect("error" in parseRequiresList([","])).toBe(true);
  });

  test("pr-apply parses the flag into args.requires", () => {
    expect(parseArgs(["components", "pr-apply", "--before-merge", "--pr", "7", "--requires", "approved,checks"]).requires).toEqual(["approved", "checks"]);
    expect(() => parseArgs(["components", "pr-apply", "--requires", "--json"])).toThrow(/--requires needs a list/);
  });

  test("a product's subset asks only those checks", async () => {
    const calls: string[] = [];
    const forge = {
      kind: "github",
      prApproved: async () => (calls.push("approved"), { passed: true, reason: "ok" }),
      prMergeable: async () => (calls.push("mergeable"), { passed: false, reason: "conflict" }),
      prUndiverged: async () => (calls.push("undiverged"), { passed: false, reason: "behind" }),
      prChecksPassed: async () => (calls.push("checks"), { passed: true, reason: "green" }),
    } as unknown as PrForge;
    const parsed = parseRequiresList(["approved,checks"]);
    if ("error" in parsed) throw new Error(parsed.error);
    const out = await checkPrRequires(forge, 7, HEAD, { only: parsed.checks, reads: 1 });
    expect(calls).toEqual(["approved", "checks"]);
    expect(unmetRequires(out)).toBeNull();
  });
});
