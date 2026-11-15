/**
 * Comment commands limited to logins and teams (INTENTIUS/terragucci#1461):
 * the decision, the team reads on GitHub's and Forgejo's request shapes, the
 * comment job's hook, the re-plan's script, and the pipeline's refusals. No
 * network: every read is a fake that records the requests it was asked.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { COMMENT_ALLOW_ENV, COMMENT_ALLOW_GATE_JS, TeamReadError, commentAllowFromEnv, commentAllowProblems, decideCommentAllow, type CommentAllow } from "./ci-comment-allow";
import { answerProductComment, type AnswerCommentOptions, type CommentJobs } from "./ci-comment-commands";
import { assertProductWords } from "./ci-product-words";
import { productPipelineJobs } from "./components/product-pipeline";
import { replanDecideJs } from "./components/product-plan";
import { forgeReadsFor, type ForgeReads, type PullRequestDetail } from "./pr-forge-reads";
import type { ForgeFetch } from "./pr-forge";

type Answer = { status: number; body?: unknown };

/** A fetch that answers from a table of `METHOD path` and records every request, with its Authorization header. */
function recorded(table: Record<string, Answer>) {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const posts: string[] = [];
  const fetch = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const path = url.replace(/^https?:\/\/[^/]+(?=\/)/, "");
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body ?? "{}").body);
      return { ok: true, status: 201, text: async () => "{}", json: async () => ({}) };
    }
    seen.push({ url: path, auth: init?.headers?.Authorization ?? init?.headers?.authorization });
    const a = table[path] ?? { status: 404 };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => (a.body === undefined ? "" : JSON.stringify(a.body)), json: async () => a.body };
  }) as unknown as ForgeFetch;
  return { fetch, seen, posts };
}

/** A table whose paths sit under a prefix, as Forgejo's API root does. */
const under = (prefix: string, table: Record<string, Answer>): Record<string, Answer> => Object.fromEntries(Object.entries(table).map(([k, v]) => [prefix + k, v]));
const FJ = "/api/v1";

// What GitHub answers for a team and a membership (docs.github.com/rest/teams), cut down to the fields read.
const GH_TEAM = { id: 7, slug: "release", name: "Release" };
const GH_ACTIVE = { url: "https://api.github.com/orgs/acme/teams/release/memberships/alice", role: "member", state: "active" };
const GH_PENDING = { ...GH_ACTIVE, state: "pending" };
// Forgejo's team search is `{ ok, data: [teams] }`; a member read is 204 with no body, or 404.
const FJ_SEARCH = { ok: true, data: [{ id: 41, name: "Owners" }, { id: 42, name: "release" }] };

const github = (fetch: ForgeFetch) => forgeReadsFor({ kind: "github", apiBase: "https://api.github.com", repo: "acme/infra", token: "team-tok", host: "github.com" } as never, fetch);
const forgejo = (fetch: ForgeFetch) => forgeReadsFor({ kind: "forgejo", apiBase: "https://git.example/api/v1", repo: "acme/infra", token: "team-tok", host: "git.example" } as never, fetch);

describe("the map", () => {
  test("checks commands and entries, and an empty list", () => {
    expect(commentAllowProblems({ apply: ["team:acme/release", "alice"], default: ["bob"] }, "x")).toEqual([]);
    expect(commentAllowProblems({ apply: [] }, "x")[0]).toMatch(/at least one entry/);
    expect(commentAllowProblems({ frob: ["a"] }, "x")[0]).toMatch(/not a command/);
    expect(commentAllowProblems({ apply: ["team:acme"] }, "x")[0]).toMatch(/team:<org>\/<team>/);
    expect(commentAllowProblems({ apply: ["team:a/b/c"] }, "x")[0]).toMatch(/not a team/);
    expect(commentAllowProblems({ apply: ["a b"] }, "x")[0]).toMatch(/not a login/);
    expect(commentAllowProblems(["a"], "x")[0]).toMatch(/must be a map/);
  });

  test("a value that does not read never turns the limit off", () => {
    expect(commentAllowFromEnv(undefined)).toBeUndefined();
    expect(commentAllowFromEnv("")).toBeUndefined();
    expect(commentAllowFromEnv('{"apply":["alice"]}')).toEqual({ apply: ["alice"] });
    expect(() => commentAllowFromEnv("{")).toThrow(/CHANT_COMMENT_ALLOW is JSON/);
    expect(() => commentAllowFromEnv('{"apply":[]}')).toThrow(/at least one entry/);
  });
});

describe("decideCommentAllow", () => {
  const reads = (member: boolean | Error) => ({ teamMember: async () => { if (member instanceof Error) throw member; return member; } });

  test("a command with no list, and no default, is open to every writer", async () => {
    expect(await decideCommentAllow({ apply: ["alice"] }, "plan", "bob", undefined)).toEqual({ ok: true });
    expect(await decideCommentAllow(undefined, "apply", "bob", undefined)).toEqual({ ok: true });
  });

  test("a listed login needs no read, whatever its case, and default covers what is not named", async () => {
    expect(await decideCommentAllow({ apply: ["Alice"] }, "apply", "alice", undefined)).toEqual({ ok: true });
    const refused = await decideCommentAllow({ apply: ["alice"] }, "apply", "bob", undefined);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok === false && refused.reason).toContain("bob may not run `apply`");
    expect(await decideCommentAllow({ default: ["alice"] }, "agent", "bob", undefined)).toMatchObject({ ok: false });
    expect(await decideCommentAllow({ default: ["alice"], agent: ["bob"] }, "agent", "bob", undefined)).toEqual({ ok: true });
  });

  test("a team is read until one holds the user; a user in none is refused", async () => {
    const seen: string[] = [];
    const r = { teamMember: async (team: string) => (seen.push(team), team === "acme/b") };
    expect(await decideCommentAllow({ plan: ["team:acme/a", "team:acme/b", "team:acme/c"] }, "plan", "bob", r)).toEqual({ ok: true });
    expect(seen).toEqual(["acme/a", "acme/b"]);
    expect(await decideCommentAllow({ plan: ["team:acme/a"] }, "plan", "bob", reads(false))).toMatchObject({ ok: false });
  });

  test("a team the forge cannot answer for fails closed, with what to fix, even when another team says no", async () => {
    const got = await decideCommentAllow({ apply: ["team:acme/release", "team:acme/ops"] }, "apply", "bob", { teamMember: async (t) => { if (t === "acme/release") throw new TeamReadError("GitHub team acme/release answered 404: the team does not exist, or the token cannot see it"); return false; } });
    expect(got).toMatchObject({ ok: false, fail: true });
    expect(got.ok === false && got.reason).toMatch(/so nothing runs \(GitHub team acme\/release answered 404.*CHANT_COMMENT_ALLOW_TOKEN/);
    expect(await decideCommentAllow({ apply: ["team:acme/release"] }, "apply", "bob", undefined)).toMatchObject({ ok: false, fail: true });
    await expect(decideCommentAllow({ apply: ["team:acme/release"] }, "apply", "bob", reads(new Error("boom")))).rejects.toThrow("boom");
  });
});

describe("ForgeReads.teamMember on recorded shapes", () => {
  test("GitHub: looks the team up, then reads the membership; active is a member, pending is not, 404 is not", async () => {
    const ok = recorded({ "/orgs/acme/teams/release": { status: 200, body: GH_TEAM }, "/orgs/acme/teams/release/memberships/alice": { status: 200, body: GH_ACTIVE }, "/orgs/acme/teams/release/memberships/pat": { status: 200, body: GH_PENDING } });
    const r = github(ok.fetch);
    expect(await r.teamMember!("acme/release", "alice")).toBe(true);
    expect(await r.teamMember!("acme/release", "pat")).toBe(false);
    expect(await r.teamMember!("acme/release", "bob")).toBe(false);
    expect(ok.seen[0]).toEqual({ url: "/orgs/acme/teams/release", auth: "Bearer team-tok" });
    expect(ok.seen[1]!.url).toBe("/orgs/acme/teams/release/memberships/alice");
  });

  test("GitHub: a team the token cannot see throws a message that says what to fix, never `not a member`", async () => {
    const r = github(recorded({ "/orgs/acme/teams/release": { status: 404 } }).fetch);
    await expect(r.teamMember!("acme/release", "alice")).rejects.toThrow(/GitHub team acme\/release answered 404: the team does not exist, or the token cannot see it/);
    await expect(r.teamMember!("acme/release", "alice")).rejects.toBeInstanceOf(TeamReadError);
    const denied = github(recorded({ "/orgs/acme/teams/release": { status: 403 } }).fetch);
    await expect(denied.teamMember!("acme/release", "alice")).rejects.toThrow(/answered 403/);
    const noScope = github(recorded({ "/orgs/acme/teams/release": { status: 200, body: GH_TEAM }, "/orgs/acme/teams/release/memberships/alice": { status: 403 } }).fetch);
    await expect(noScope.teamMember!("acme/release", "alice")).rejects.toThrow(/membership of alice answered 403/);
    await expect(r.teamMember!("acme", "alice")).rejects.toThrow(/write <org>\/<team>/);
  });

  test("Forgejo: finds the team by name, then asks whether the login is a member", async () => {
    const t = recorded(under(FJ, { "/orgs/acme/teams/search?q=release&limit=50": { status: 200, body: FJ_SEARCH }, "/teams/42/members/alice": { status: 204 }, "/teams/42/members/bob": { status: 404 } }));
    const r = forgejo(t.fetch);
    expect(await r.teamMember!("acme/release", "alice")).toBe(true);
    expect(await r.teamMember!("acme/release", "bob")).toBe(false);
    expect(t.seen[0]).toEqual({ url: `${FJ}/orgs/acme/teams/search?q=release&limit=50`, auth: "token team-tok" });
    const none = forgejo(recorded(under(FJ, { "/orgs/acme/teams/search?q=ops&limit=50": { status: 200, body: FJ_SEARCH } })).fetch);
    await expect(none.teamMember!("acme/ops", "alice")).rejects.toThrow(/acme has no team named ops/);
    const hidden = forgejo(recorded(under(FJ, { "/orgs/acme/teams/search?q=release&limit=50": { status: 403 } })).fetch);
    await expect(hidden.teamMember!("acme/release", "alice")).rejects.toThrow(/searching acme's teams answered 403/);
  });
});

const tg = assertProductWords({ product: "terragucci", noun: ["root", "roots"], commands: { plan: "plan", apply: "apply", lock: "lock", unlock: "unlock", agent: "agent", action: "action" } });

function comment(body: string, allow: CommentAllow | undefined, jobs: CommentJobs, teams: ForgeReads["teamMember"] | undefined, o: { forge?: "github" | "forgejo"; user?: string } = {}) {
  const posted: string[] = [];
  const forge = o.forge ?? "github";
  const reads = {
    kind: forge,
    permission: async () => "write",
    pullRequest: async (n: number) => ({ number: n, title: "", body: "", state: "merged", head: "f", base: "main", sameRepo: true, mergeCommit: "a".repeat(40) }) as PullRequestDetail,
    headRuns: async () => [],
    runJobs: async () => [],
    branchRuns: async () => [],
    ...(teams ? { teamMember: teams } : {}),
  } as unknown as ForgeReads;
  const user = o.user ?? "bob";
  const opts: AnswerCommentOptions = {
    forge,
    event: { action: "created", comment: { id: 7, body, user: { login: user } }, issue: { number: 12, pull_request: {} }, repository: { full_name: "acme/infra", default_branch: "main", permissions: { push: true } }, sender: { login: user } },
    repo: "acme/infra",
    reads,
    poster: { addComment: async (_n: number, text: string) => (posted.push(text), { id: 1 } as never), commitStatuses: async () => [] as never },
    runs: { rerunFailed: async () => ({}), dispatch: async () => ({}) },
    words: tg,
    base: "main",
    jobs,
    ...(allow ? { allow } : {}),
  };
  return { opts, posted };
}

describe("the comment job's hook", () => {
  test("a writer a list leaves out gets a reply that names it, for each command the job answers", async () => {
    for (const [body, jobs] of [
      ["/terragucci apply", { applyOnMerge: true }],
      ["/terragucci lock", {}],
      ["/terragucci unlock", {}],
      ["/terragucci agent fix it", {}],
      ["/terragucci plan", { preview: true }],
      ["/terragucci agent fix it", { agent: true }],
    ] as Array<[string, CommentJobs]>) {
      const s = comment(body, { default: ["alice"] }, jobs, undefined);
      const got = await answerProductComment(s.opts);
      expect(got, body).toMatchObject({ replied: true, ran: false });
      expect(got.fail, body).toBeUndefined();
      expect(s.posted, body).toEqual([expect.stringMatching(/^terragucci: bob may not run `\w+` here: it is limited to `alice`/)]);
    }
  });

  test("a listed login, and a member of a listed team, go on to the command", async () => {
    const login = comment("/terragucci lock", { lock: ["Bob"] }, {}, undefined);
    expect(await answerProductComment(login.opts)).toMatchObject({ replied: true });
    expect(login.posted[0]).toMatch(/lock/);
    expect(login.posted[0]).not.toMatch(/may not run/);
    const asked: string[] = [];
    const team = comment("/terragucci apply", { apply: ["team:acme/release"] }, { applyOnMerge: true }, async (t, l) => (asked.push(`${t}:${l}`), true));
    const got = await answerProductComment(team.opts);
    expect(asked).toEqual(["acme/release:bob"]);
    expect(team.posted.join("\n")).not.toMatch(/may not run/);
    expect(got.fail).toBeUndefined();
  });

  test("a command with no list is open to every writer", async () => {
    const s = comment("/terragucci lock", { apply: ["alice"] }, {}, undefined);
    await answerProductComment(s.opts);
    expect(s.posted.join("\n")).not.toMatch(/may not run/);
  });

  test("a team the token cannot read fails the job, with a reply that says what to fix", async () => {
    const s = comment("/terragucci apply", { apply: ["team:acme/release"] }, { applyOnMerge: true }, async () => { throw new TeamReadError("GitHub team acme/release answered 403"); });
    const got = await answerProductComment(s.opts);
    expect(got).toMatchObject({ fail: true, replied: true, ran: false });
    expect(s.posted).toEqual([expect.stringMatching(/could not read team membership for bob, so nothing runs \(GitHub team acme\/release answered 403\)/)]);
    // A read that fails some other way fails the job and runs nothing.
    const other = comment("/terragucci apply", { apply: ["team:acme/release"] }, { applyOnMerge: true }, async () => { throw new Error("socket closed"); });
    expect(await answerProductComment(other.opts)).toMatchObject({ fail: true, ran: false });
    // GitLab-shaped reads that cannot read teams fail closed too.
    const none = comment("/terragucci apply", { apply: ["team:acme/release"] }, { applyOnMerge: true }, undefined);
    expect(await answerProductComment(none.opts)).toMatchObject({ fail: true });
  });

  test("Forgejo's commenter is held to the list the same way", async () => {
    const s = comment("/terragucci apply", { apply: ["alice"] }, { applyOnMerge: true }, undefined, { forge: "forgejo" });
    expect(await answerProductComment(s.opts)).toMatchObject({ replied: true, ran: false });
    expect(s.posted[0]).toMatch(/bob may not run `apply`/);
  });

  test("a commenter without write access gets no reply, before any list is read", async () => {
    const s = comment("/terragucci apply", { apply: ["team:acme/release"] }, { applyOnMerge: true }, async () => { throw new Error("never read"); });
    (s.opts.reads as unknown as { permission: () => Promise<string> }).permission = async () => "read";
    expect(await answerProductComment(s.opts)).toMatchObject({ replied: false });
    expect(s.posted).toEqual([]);
  });
});

/** The gate script alone, run with a fake process and the forge's answers. */
async function gate(env: Record<string, string>, who: string, command: string, table: Record<string, Answer>) {
  const t = recorded(table);
  const run = new Function("process", "fetch", `${COMMENT_ALLOW_GATE_JS}; return commentAllowRefusal;`) as (p: unknown, f: unknown) => (who: string, command: string) => Promise<string | undefined>;
  const refusal = run({ env }, t.fetch);
  return { result: await refusal(who, command), seen: t.seen };
}

describe("the re-plan's gate script", () => {
  const list = JSON.stringify({ plan: ["team:acme/release", "Carol"] });
  const base = { [COMMENT_ALLOW_ENV]: list, GITHUB_API_URL: "https://api.github.com", CHANT_REPLAN_TOKEN: "job-tok" };

  test("answers undefined for a listed login, with no request, and for a command with no list", async () => {
    const a = await gate(base, "carol", "plan", {});
    expect(a).toEqual({ result: undefined, seen: [] });
    expect((await gate(base, "bob", "apply", {})).result).toBeUndefined();
  });

  test("makes GitHub's requests with the team token, else the job's", async () => {
    const table = { "/orgs/acme/teams/release": { status: 200, body: GH_TEAM }, "/orgs/acme/teams/release/memberships/alice": { status: 200, body: GH_ACTIVE } };
    const a = await gate({ ...base, CHANT_COMMENT_ALLOW_TOKEN: "team-tok" }, "alice", "plan", table);
    expect(a.result).toBeUndefined();
    expect(a.seen.map((s) => s.auth)).toEqual(["Bearer team-tok", "Bearer team-tok"]);
    const job = await gate(base, "alice", "plan", table);
    expect(job.seen[0]!.auth).toBe("Bearer job-tok");
    const out = await gate(base, "bob", "plan", table);
    expect(out.result).toMatch(/^bob may not run `plan` here: it is limited to `team:acme\/release`, `Carol`/);
  });

  test("makes Forgejo's requests, and a pending invitation is not membership", async () => {
    const env = { ...base, GITHUB_API_URL: "https://git.example/api/v1", CHANT_COMMENT_ALLOW_FORGE: "forgejo" };
    const table = under(FJ, { "/orgs/acme/teams/search?q=release&limit=50": { status: 200, body: FJ_SEARCH }, "/teams/42/members/alice": { status: 204 } });
    expect((await gate(env, "alice", "plan", table)).result).toBeUndefined();
    expect((await gate(env, "bob", "plan", table)).result).toMatch(/bob may not run/);
    const pending = await gate(base, "pat", "plan", { "/orgs/acme/teams/release": { status: 200, body: GH_TEAM }, "/orgs/acme/teams/release/memberships/pat": { status: 200, body: GH_PENDING } });
    expect(pending.result).toMatch(/pat may not run/);
  });

  test("throws when a team cannot be read, so the decision fails and nothing is planned", async () => {
    await expect(gate(base, "bob", "plan", { "/orgs/acme/teams/release": { status: 404 } })).rejects.toThrow(/could not read team membership for bob, so nothing runs \(GitHub team acme\/release answered 404/);
    await expect(gate({ ...base, [COMMENT_ALLOW_ENV]: "{" }, "bob", "plan", {})).rejects.toThrow(/not JSON/);
  });
});

describe("the re-plan's decision with a list", () => {
  /** The whole decision script, against an event file and a forge that answers from a table. */
  async function decide(opts: { allow?: boolean; reply?: boolean; dispatch?: boolean }, env: Record<string, string>, who: string, table: Record<string, Answer>) {
    const dir = mkdtempSync(join(tmpdir(), "chant-allow-"));
    const eventFile = join(dir, "event.json");
    const out = join(dir, "output");
    writeFileSync(eventFile, JSON.stringify({ comment: { body: "/terragucci plan", user: { login: who } }, issue: { number: 12, pull_request: {} } }));
    writeFileSync(out, "");
    const t = recorded(table);
    const logs: string[] = [];
    let exit: number | undefined;
    const proc = { env: { ...env, GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "acme/infra", CHANT_REPLAN_COMMANDS: '["/terragucci plan"]' }, exit: (c: number) => { exit = c; } };
    const run = new Function("process", "fetch", "require", "console", replanDecideJs(opts));
    run(proc, t.fetch, (m: string) => (m === "fs" ? { readFileSync, appendFileSync: (f: string, d: string) => writeFileSync(f, readFileSync(f, "utf8") + d) } : undefined), { log: (m: string) => logs.push(m), error: (m: string) => logs.push(m) });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    return { output: readFileSync(out, "utf8"), logs, exit, seen: t.seen, posts: t.posts };
  }
  const SHA = "c".repeat(40);
  const pr = { "/repos/acme/infra/pulls/12": { status: 200, body: { state: "open", head: { sha: SHA, repo: { full_name: "acme/infra" } }, base: { sha: SHA } } } };
  const team = { "/orgs/acme/teams/release": { status: 200, body: GH_TEAM }, "/orgs/acme/teams/release/memberships/alice": { status: 200, body: GH_ACTIVE } };
  const env = { GITHUB_API_URL: "https://api.github.com", CHANT_REPLAN_TOKEN: "job-tok", [COMMENT_ALLOW_ENV]: JSON.stringify({ plan: ["team:acme/release"] }) };

  test("a member plans, a writer outside the team does not, and neither pays for a request without a list", async () => {
    const yes = await decide({ allow: true }, env, "alice", { ...pr, ...team });
    expect(yes.output).toMatch(/^go=1\npr=12\n/m);
    const no = await decide({ allow: true }, env, "bob", { ...pr, ...team });
    expect(no.output).toBe("");
    expect(no.logs.join("\n")).toMatch(/bob may not run `plan` here.*so nothing is planned again/);
    const plain = await decide({}, env, "bob", pr);
    expect(plain.output).toMatch(/^go=1/);
    expect(plain.seen.every((s) => !s.url.startsWith("/orgs"))).toBe(true);
  });

  test("with reply, the re-plan posts the refusal itself, once, as the product", async () => {
    const forgejoEnv = { ...env, CHANT_REPLAN_PERMISSION: "1", CHANT_REPLAN_PRODUCT: "/terragucci" };
    const perm = { "/repos/acme/infra/collaborators/bob/permission": { status: 200, body: { permission: "write" } } };
    const got = await decide({ allow: true, reply: true }, forgejoEnv, "bob", { ...pr, ...team, ...perm });
    expect(got.output).toBe("");
    expect(got.posts).toEqual([expect.stringMatching(/^terragucci: bob may not run `plan` here: it is limited to `team:acme\/release`.*, so nothing is planned again$/)]);
    const quiet = await decide({ allow: true }, env, "bob", { ...pr, ...team });
    expect(quiet.output).toBe("");
  });

  test("with reply, the check comes after the permission and holds the same", async () => {
    const forgejoEnv = { ...env, CHANT_REPLAN_PERMISSION: "1" };
    const perm = (p: string) => ({ "/repos/acme/infra/collaborators/bob/permission": { status: 200, body: { permission: p } }, "/repos/acme/infra/collaborators/alice/permission": { status: 200, body: { permission: "write" } } });
    const no = await decide({ allow: true, reply: true }, forgejoEnv, "bob", { ...pr, ...team, ...perm("write") });
    expect(no.output).toBe("");
    expect(no.logs.join("\n")).toMatch(/bob may not run/);
    const yes = await decide({ allow: true, reply: true }, forgejoEnv, "alice", { ...pr, ...team, ...perm("write") });
    expect(yes.output).toMatch(/^go=1/);
  });

  test("a team that cannot be read fails the decision with a non-zero exit", async () => {
    const got = await decide({ allow: true }, env, "alice", { ...pr, "/orgs/acme/teams/release": { status: 404 } });
    expect(got.output).toBe("");
    expect(got.exit).toBe(1);
    expect(got.logs.join("\n")).toMatch(/the re-plan could not decide: could not read team membership for alice, so nothing runs/);
  });

  test("without the option the script is the one chant wrote before", () => {
    expect(replanDecideJs({})).not.toContain("commentAllowRefusal");
    expect(replanDecideJs({ allow: true })).toContain("commentAllowRefusal(asker,\"plan\")");
    expect(replanDecideJs({ allow: true })).not.toContain("'");
  });
});

describe("productPipelineJobs", () => {
  const words = { product: "terragucci", noun: ["root", "roots"] as [string, string], commands: { plan: "plan" as const, apply: "apply" as const, lock: "lock" as const, unlock: "unlock" as const, agent: "agent" as const }, approval: "per-wave" as const, op: "tf-apply" };
  const waves = { name: "tf-apply", op: "tf-apply", planWave: ["terragucci", "plan-wave", "--runs", "{runs}", "--plans", "{plans}"], applyWave: ["terragucci", "apply-wave", "--runs", "{runs}", "--plans", "{plans}"], waves: [{ name: "n", runs: [{ target: "a" }] }] };
  const plan = { command: "terragucci plan --pr-report {output}", workflow: "terragucci-pr", replan: true };
  const allow = { allow: { apply: ["team:acme/release"], plan: ["alice"], agent: ["team:acme/ai"] }, tokenSecret: "TG_TEAM_TOKEN" };

  test("writes the map and the team token into the comment job, the re-plan and the agent", () => {
    const jobs = productPipelineJobs("github", "default", { words, productPlan: plan, commentJob: true, waves, agent: true, commentAllow: allow });
    expect(JSON.parse(jobs.comment!.env.CHANT_COMMENT_ALLOW!)).toEqual(allow.allow);
    expect(jobs.comment!.env.CHANT_COMMENT_ALLOW_TOKEN).toBe("${{ secrets.TG_TEAM_TOKEN }}");
    expect(jobs.productPlan![0]!.replan!.allow).toEqual({ list: allow.allow, tokenSecret: "TG_TEAM_TOKEN" });
    expect(jobs.agent!.spec.agent).toMatchObject({ commentAllow: allow.allow, commentAllowTokenEnv: "TG_TEAM_TOKEN" });
  });

  test("leaves the jobs as they were without it, and the re-plan alone when the plan comment has no list", () => {
    const plain = productPipelineJobs("github", "default", { words, productPlan: plan, commentJob: true, waves, agent: true });
    expect(plain.comment!.env).not.toHaveProperty("CHANT_COMMENT_ALLOW");
    expect(plain.productPlan![0]!.replan).not.toHaveProperty("allow");
    expect(plain.agent!.spec.agent).not.toHaveProperty("commentAllow");
    const applyOnly = productPipelineJobs("github", "default", { words, productPlan: plan, commentJob: true, waves, agent: true, commentAllow: { allow: { apply: ["alice"] } } });
    expect(applyOnly.productPlan![0]!.replan).not.toHaveProperty("allow");
    expect(applyOnly.agent!.spec.agent).not.toHaveProperty("commentAllow");
    expect(applyOnly.comment!.env).not.toHaveProperty("CHANT_COMMENT_ALLOW_TOKEN");
  });

  test("refuses what it cannot carry: GitLab, a bad entry, a secret name, the apply before merge and the comment lock jobs", () => {
    const base = { words, productPlan: plan, commentJob: true, waves };
    expect(() => productPipelineJobs("gitlab", "default", { ...base, words: { ...words, commands: { plan: "plan" as const, apply: "apply" as const } }, commentJob: undefined, noteCommands: true, commentAllow: allow })).toThrow(/GitHub and Forgejo/);
    expect(() => productPipelineJobs("github", "default", { ...base, commentAllow: { allow: { apply: ["team:acme"] } } })).toThrow(/team:<org>\/<team>/);
    expect(() => productPipelineJobs("github", "default", { ...base, commentAllow: { allow: { apply: ["a"] }, tokenSecret: "x y" } })).toThrow(/secret's name/);
    expect(() => productPipelineJobs("github", "default", { words, productPlan: plan, commentJob: true, applyBeforeMerge: true, commentAllow: { allow: { default: ["a"] } } })).toThrow(/applyBeforeMerge/);
    expect(() => productPipelineJobs("github", "default", { ...base, locks: "plan", commentAllow: { allow: { lock: ["a"] } } })).toThrow(/comment lock jobs/);
    expect(() => productPipelineJobs("github", "default", { ...base, locks: "plan", commentAllow: { allow: { plan: ["a"], apply: ["b"] } } })).not.toThrow();
  });
});
