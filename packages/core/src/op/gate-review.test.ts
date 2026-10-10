import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ForgeFetch } from "../pr-forge";
import { waveSetDigest } from "../gated-waves";
import { sealGateApproval } from "../workspace/trust/seal";
import { TestRepo, hasSshKeygen } from "../workspace/trust/test-repo";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import { memoryGateLedgerPort } from "./gate";
import { githubReviews, forgejoReviews, gitlabReviews, type MergedReview, type ReviewSource } from "./gate-review";
import type { OpWavesSpec } from "./op-waves";
import { recordOpWaveHeadPlans, runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";

const HEAD = "h".repeat(40);
const MERGE = "m".repeat(40);
const digest = (n: string) => `sha256:${n.repeat(64)}`;

/** A fake forge answering GETs by path. */
function forge(routes: Record<string, unknown>): ForgeFetch {
  return async (url) => {
    const { pathname } = new URL(url);
    if (!(pathname in routes)) return { ok: false, status: 404, text: async () => "not found" };
    return { ok: true, status: 200, text: async () => JSON.stringify(routes[pathname]) };
  };
}

const opts = (fetch: ForgeFetch, apiBase = "https://api.github.com") => ({ apiBase, repo: "acme/db", token: "t", host: "github.com", fetch });

describe("the merged pull request's review", () => {
  const pr = { number: 7, user: { login: "carol" }, head: { sha: HEAD }, html_url: "https://github.com/acme/db/pull/7" };
  const base = {
    "/repos/acme/db/commits/mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm/pulls": [{ number: 7, merged_at: "x", merge_commit_sha: MERGE }],
    "/repos/acme/db/pulls/7": pr,
    "/repos/acme/db/collaborators/alice/permission": { permission: "write", role_name: "write" },
    "/repos/acme/db/collaborators/dave/permission": { permission: "read", role_name: "read" },
  };

  test("GitHub: the author's own approval never counts", async () => {
    const review = await githubReviews(opts(forge({ ...base, "/repos/acme/db/pulls/7/reviews": [{ user: { login: "carol" }, state: "APPROVED", commit_id: HEAD }] }))).mergedReview(MERGE);
    expect(review).toMatchObject({ pr: 7, author: "github:carol", head: HEAD, approvers: [] });
    expect(review!.refused[0]).toMatch(/github:carol is the author/);
  });

  test("GitHub: a writer's approval of the head counts; a reader's, or one of an older commit, does not", async () => {
    const review = await githubReviews(
      opts(
        forge({
          ...base,
          "/repos/acme/db/pulls/7/reviews": [
            { user: { login: "alice" }, state: "APPROVED", commit_id: "old" },
            { user: { login: "alice" }, state: "APPROVED", commit_id: HEAD },
            { user: { login: "dave" }, state: "APPROVED", commit_id: HEAD },
          ],
        }),
      ),
    ).mergedReview(MERGE);
    expect(review!.approvers).toEqual(["github:alice"]);
    expect(review!.refused).toEqual(["github:dave approved without write access"]);
  });

  test("GitHub: a writer who requests changes holds the review back", async () => {
    const review = await githubReviews(
      opts(
        forge({
          ...base,
          "/repos/acme/db/collaborators/bob/permission": { permission: "write", role_name: "maintain" },
          "/repos/acme/db/pulls/7/reviews": [
            { user: { login: "alice" }, state: "APPROVED", commit_id: HEAD },
            { user: { login: "bob" }, state: "CHANGES_REQUESTED", commit_id: HEAD },
          ],
        }),
      ),
    ).mergedReview(MERGE);
    expect(review!.approvers).toEqual([]);
  });

  test("Forgejo: only an official review that is neither stale nor dismissed counts", async () => {
    const review = await forgejoReviews(
      opts(
        forge({
          "/api/v1/repos/acme/db/commits/mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm/pull": { number: 7 },
          "/api/v1/repos/acme/db/pulls/7": pr,
          "/api/v1/repos/acme/db/pulls/7/reviews": [
            { user: { login: "alice" }, state: "APPROVED", commit_id: HEAD, official: true },
            { user: { login: "dave" }, state: "APPROVED", commit_id: HEAD, official: false },
            { user: { login: "erin" }, state: "APPROVED", commit_id: HEAD, official: true, stale: true },
          ],
        }),
        "https://code.example.org/api/v1",
      ),
    ).mergedReview(MERGE);
    expect(review!.approvers).toEqual(["forgejo@github.com:alice"]);
    expect(review!.refused).toHaveLength(2);
  });

  test("GitLab: an approval counts only where a push removes approvals, and never the author's", async () => {
    const routes = {
      "/api/v4/projects/7/repository/commits/mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm/merge_requests": [{ iid: 3, state: "merged", merge_commit_sha: MERGE, sha: HEAD, author: { username: "carol" } }],
      "/api/v4/projects/7/merge_requests/3/approvals": { approved_by: [{ user: { id: 1, username: "carol" } }, { user: { id: 2, username: "alice" } }] },
      "/api/v4/projects/7/members/all/2": { access_level: 30 },
    };
    const keeps = await gitlabReviews({ ...opts(forge({ ...routes, "/api/v4/projects/7/approvals": { reset_approvals_on_push: false } }), "https://gl/api/v4"), repo: "7", host: "gitlab.com" }).mergedReview(MERGE);
    expect(keeps!.approvers).toEqual([]);
    const resets = await gitlabReviews({ ...opts(forge({ ...routes, "/api/v4/projects/7/approvals": { reset_approvals_on_push: true } }), "https://gl/api/v4"), repo: "7", host: "gitlab.com" }).mergedReview(MERGE);
    expect(resets).toMatchObject({ pr: 3, head: HEAD, approvers: ["gitlab:alice"] });
    expect(resets!.refused[0]).toMatch(/gitlab:carol is the author/);
  });
});

const spec = (approval: "pr-review" | "sealed"): OpWavesSpec => ({
  name: "migrations",
  op: "migrate",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}"],
  waves: [{ name: "prod", runs: [{ target: "prod" }], approval }],
});

function harness(plan: string, dir?: string) {
  const cwd = dir ?? mkdtempSync(join(tmpdir(), "gate-review-"));
  const applied: string[] = [];
  const exec: OpWaveExec = (argv, at) => {
    if (argv[1] === "plan") {
      mkdirSync(join(at, argv[4]!, ".."), { recursive: true });
      writeFileSync(join(at, argv[4]!), JSON.stringify({ planDigest: plan }));
    }
    if (argv[1] === "apply") applied.push(argv[2]!);
    return 0;
  };
  return { cwd, exec, applied };
}

describe("a pr-review wave (#3684)", () => {
  const set = (plan: string) => waveSetDigest([{ member: "prod", planDigest: plan }]);
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec("pr-review")) });
  const reviewed = (approvers: string[], refused: string[] = []): ReviewSource => ({
    kind: "github",
    async mergedReview(): Promise<MergedReview> {
      return { pr: 7, author: "github:carol", head: HEAD, approvers, refused, url: "https://github.com/acme/db/pull/7" };
    },
  });
  const plans = (d: string) => async () => ({ version: 1 as const, name: "migrations", head: HEAD, timestamp: "t", waves: [{ wave: 1, name: "prod", digest: d }] });

  test("the author's own review applies nothing", async () => {
    const h = harness(digest("a"));
    const result = await runOpWave({
      spec: spec("pr-review"), specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show, head: MERGE,
      gates: memoryGateLedgerPort(), reviews: reviewed([], ["github:carol is the author, whose own review never counts"]), headPlans: plans(set(digest("a"))),
    });
    expect(result).toMatchObject({ exitCode: 3, applied: [], decision: { approval: "pr-review", status: "waiting" } });
    expect(result.decision!.review!.reason).toMatch(/is the author/);
    expect(h.applied).toEqual([]);
  });

  test("a writer's review of the head approves the digest the head planned, and the ledger records it", async () => {
    const h = harness(digest("a"));
    const gates = memoryGateLedgerPort();
    const result = await runOpWave({
      spec: spec("pr-review"), specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show, head: MERGE,
      gates, reviews: reviewed(["github:alice"]), headPlans: plans(set(digest("a"))),
    });
    expect(result).toMatchObject({ exitCode: 0, applied: ["prod"], decision: { status: "approved", via: "pr-review", approvedBy: "github:alice" } });
    expect(gates.resolved[0]).toMatchObject({ resolvedBy: "github:alice", planDigest: set(digest("a")), review: { pr: 7, head: HEAD, approvers: ["github:alice"] } });
  });

  test("a plan that moved after the review waits for a new approval", async () => {
    const h = harness(digest("b"));
    const result = await runOpWave({
      spec: spec("pr-review"), specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show, head: MERGE,
      gates: memoryGateLedgerPort(), reviews: reviewed(["github:alice"]), headPlans: plans(set(digest("a"))),
    });
    expect(result.exitCode).toBe(3);
    expect(result.decision!.review!.reason).toMatch(/plan moved after the review/);
  });

  test("--record-plans records each wave's digest at the head", async () => {
    const h = harness(digest("a"));
    let written: unknown;
    const recorded = await recordOpWaveHeadPlans({ spec: spec("pr-review"), cwd: h.cwd, exec: h.exec, head: HEAD, now: "t", write: async (p) => void (written = p) });
    expect(recorded.waves).toEqual([{ wave: 1, name: "prod", digest: set(digest("a")) }]);
    expect(written).toEqual(recorded);
  });
});

describe.skipIf(!hasSshKeygen)("a sealed wave (#3684)", () => {
  const repo = new TestRepo("3684-sealed");
  const alice = repo.key("alice");
  const mallory = repo.key("mallory");
  afterAll(() => rmSync(join(repo.dir, ".."), { recursive: true, force: true }));

  // Base: the spec and a signers file listing alice. The applied change adds mallory's key.
  writeFileSync(join(repo.dir, "waves.json"), JSON.stringify(spec("sealed")));
  mkdirSync(join(repo.dir, ".chant"), { recursive: true });
  writeFileSync(join(repo.dir, ".chant/allowed_signers"), `alice ${alice.pub}\n`);
  repo.git(["add", "-A"]);
  repo.git(["commit", "-q", "-m", "base"]);
  writeFileSync(join(repo.dir, ".chant/allowed_signers"), `alice ${alice.pub}\nmallory ${mallory.pub}\n`);
  repo.git(["add", "-A"]);
  repo.git(["commit", "-q", "-m", "the change adds a signer"]);

  const plan = digest("a");
  const set = waveSetDigest([{ member: "prod", planDigest: plan }]);
  const approval = (by: string, keyFile?: string): GateResolutionRecord => {
    const a = { op: "migrations", gate: "migrations-wave-1", resolvedBy: by, timestamp: "2026-10-10T00:00:00Z", planDigest: set };
    return { version: 1, ...a, ...(keyFile ? { seal: sealGateApproval(keyFile, a) } : {}) };
  };
  const run = (resolutions: GateResolutionRecord[]) => {
    const h = harness(plan, repo.dir);
    return runOpWave({ spec: spec("sealed"), specFile: "waves.json", wave: 1, cwd: repo.dir, exec: h.exec, gates: memoryGateLedgerPort({ resolutions }), now: "2026-10-10T01:00:00Z" });
  };

  test("an unsigned approval applies nothing, and the hint asks for --sign", async () => {
    const result = await run([approval("alice")]);
    expect(result).toMatchObject({ exitCode: 3, decision: { approval: "sealed", status: "waiting" } });
    expect(result.decision!.approve).toMatch(/--sign$/);
  });

  test("a seal by a key the change itself added applies nothing", async () => {
    expect((await run([approval("mallory", mallory.file)])).exitCode).toBe(3);
  });

  test("a seal by a signer listed at base applies the wave", async () => {
    expect(await run([approval("alice", alice.file)])).toMatchObject({ exitCode: 0, applied: ["prod"], decision: { status: "approved", approvedBy: "alice" } });
  });
});
