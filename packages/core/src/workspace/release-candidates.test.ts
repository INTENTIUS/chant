/**
 * The `release-candidates` read (#4168 4.2): green commits of trunk, each
 * with the commits since the previous one, held to
 * `release-candidates.schema.json`.
 */

import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { contract } from "./__fixtures__/contract-repo";
import candidatesSchema from "./release-candidates.schema.json";
import { groupChanges, mergeRecordPr, prFromSubject, recordTrailers, releaseCandidatesDocument, RELEASE_CANDIDATES_SCHEMA_ID, type CandidateChange } from "./release-candidates";
import { appendCut, makeRelease, persistRelease } from "../lifecycle/release-store";
import { appendReleaseRecord } from "../lifecycle/release-ledger";
import { writeLedgerFiles } from "../lifecycle/git";
import type { ForgeFetch } from "../pr-forge";

const { expectValid } = contract(candidatesSchema);

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo on main with chant.config.ts declaring staging and prod, and one commit per subject. */
function repo(dir: string, subjects: string[]): string[] {
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@chant.dev"], ["config", "user.name", "T"]]) git(dir, ...args);
  writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["staging", "prod"] };\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  const shas = [git(dir, "rev-parse", "HEAD")];
  for (const s of subjects) {
    git(dir, "commit", "-q", "--allow-empty", "-m", s);
    shas.push(git(dir, "rev-parse", "HEAD"));
  }
  return shas;
}

describe("recordTrailers and prFromSubject", () => {
  test("read work ids, every record, and a squash subject's pull request", () => {
    expect(recordTrailers({ "Chant-Record": ["work:w-1", "decision:d-2", "nonsense"] })).toEqual({ work: ["w-1"], records: ["work:w-1", "decision:d-2"] });
    expect(prFromSubject("ci: a thing (#4168) (#4174)")).toBe(4174);
    expect(prFromSubject("no number here")).toBeNull();
  });
});

describe("groupChanges (#4168 4.4)", () => {
  const change = (commit: string, work: string[], pr: number | null, issues?: number[]): CandidateChange => ({
    commit,
    subject: commit,
    date: "",
    work,
    records: work.map((w) => `work:${w}`),
    pr,
    merge: null,
    closes: issues ? { resolved: true, issues, reason: null } : null,
  });

  test("groups by work item, then pull request, then commit, with the ungrouped last", () => {
    // Newest first, as a candidate's changes are.
    const groups = groupChanges([
      change("f", [], null),
      change("e", ["w-2"], null),
      change("d", ["w-1"], 4),
      change("c", [], 3),
      change("b", ["w-1", "w-2"], 2),
      change("a", ["w-1"], 2),
    ]);
    expect(groups).toEqual([
      { work: "w-1", issue: null, pullRequests: [{ pr: 2, commits: ["b", "a"] }, { pr: 4, commits: ["d"] }] },
      { work: "w-2", issue: null, pullRequests: [{ pr: 2, commits: ["b"] }, { pr: null, commits: ["e"] }] },
      { work: null, issue: null, pullRequests: [{ pr: 3, commits: ["c"] }, { pr: null, commits: ["f"] }] },
    ]);
  });

  test("a change with no work id lands under each issue its pull request closes (#4649)", () => {
    const groups = groupChanges([
      change("d", [], 9, []),
      change("c", ["w-1"], 8, [70]),
      change("b", [], 7, [71, 70]),
      change("a", [], 6, [70]),
    ]);
    expect(groups).toEqual([
      // A work id wins over the issues its pull request closes.
      { work: "w-1", issue: null, pullRequests: [{ pr: 8, commits: ["c"] }] },
      { work: null, issue: 70, pullRequests: [{ pr: 6, commits: ["a"] }, { pr: 7, commits: ["b"] }] },
      { work: null, issue: 71, pullRequests: [{ pr: 7, commits: ["b"] }] },
      { work: null, issue: null, pullRequests: [{ pr: 9, commits: ["d"] }] },
    ]);
  });

  test("a merge record names its pull request in source", () => {
    expect(mergeRecordPr({ source: { kind: "pull-request", pr: 12 } })).toBe(12);
    expect(mergeRecordPr({ source: { kind: "direct-push" } })).toBeNull();
    expect(mergeRecordPr(null)).toBeNull();
  });
});

describe("releaseCandidatesDocument", () => {
  test("partitions the walk at green commits, skips revoked ones, and says which environments each is new for", async () => {
    await withTestDir(async (dir) => {
      const [init, a, b, c, d, e] = repo(dir, ["a (#1)", "b\n\nChant-Record: work:w-7", "c", "d (#4)", "e"]);
      for (const sha of [init, b, d]) git(dir, "tag", `ci/green/${sha}`);
      git(dir, "tag", `ci/green/${c}`);
      git(dir, "tag", `ci/revoked/${c}`);

      // staging runs a release of init; prod runs nothing.
      const r = makeRelease({ member: null, commit: init, artifactDigests: [], targets: [{ env: "staging", templates: [], params: [] }] });
      await persistRelease(r, [], { cwd: dir });
      await appendCut({ releaseDigest: r.releaseDigest, label: "v0", actor: "alice", timestamp: "2026-10-20T10:00:00.000Z", runOrigin: null }, { cwd: dir });
      await appendReleaseRecord(
        { component: "api", env: "staging", digest: `sha256:${"a".repeat(64)}`, gitSha: init, runId: "r", timestamp: "2026-10-20T11:00:00.000Z", actor: "ci", releaseDigest: r.releaseDigest },
        { cwd: dir },
      );
      // A merge record for d names its pull request.
      await writeLedgerFiles([{ path: `_merges/${d}.json`, content: JSON.stringify({ source: { kind: "pull-request", pr: 40 }, approvedDigest: "sha256:x" }) }], "merge record", { cwd: dir });

      const doc = await releaseCandidatesDocument({ cwd: dir });
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc).toMatchObject({ $schema: RELEASE_CANDIDATES_SCHEMA_ID, contract: 1, branch: "main", tip: e, member: null });
      expect(doc.environments).toEqual([
        { env: "staging", running: [{ releaseDigest: r.releaseDigest, label: "v0", commit: init, components: ["api"] }] },
        { env: "prod", running: [] },
      ]);
      // prod runs nothing, so the walk is not bounded and reaches init.
      expect(doc.since).toBeNull();
      expect(doc.candidates.map((x) => x.commit)).toEqual([d, b, init]);
      expect(doc.candidates[0]).toMatchObject({ newFor: ["staging", "prod"], cut: [] });
      expect(doc.candidates[0].changes.map((x) => x.commit)).toEqual([d, c]);
      expect(doc.candidates[0].changes[0]).toMatchObject({ pr: 40, merge: { source: { kind: "pull-request", pr: 40 }, approvedDigest: "sha256:x" } });
      expect(doc.candidates[1].changes.map((x) => x.commit)).toEqual([b, a]);
      expect(doc.candidates[1].changes[0].work).toEqual(["w-7"]);
      expect(doc.candidates[1].changes[1].pr).toBe(1);
      expect(doc.candidates[2]).toMatchObject({ commit: init, newFor: ["prod"], cut: ["v0"] });
      expect(doc.skipped).toEqual([{ commit: c, subject: "c", reason: "revoked" }]);
      expect(doc.pending.map((x) => x.commit)).toEqual([e]);

      // --env staging stops at what staging runs.
      const staging = await releaseCandidatesDocument({ cwd: dir, env: "staging" });
      if ("error" in staging) throw new Error(staging.error.message);
      expectValid(staging);
      expect(staging.since).toBe(init);
      expect(staging.candidates.map((x) => x.commit)).toEqual([d, b]);
      expect(staging.candidates.every((x) => x.newFor.join() === "staging")).toBe(true);
    });
  });

  test("with forgeIssues, each change carries what its pull request closes, and groups by those issues (#4649)", async () => {
    await withTestDir(async (dir) => {
      const [init, a, b, c, d] = repo(dir, ["a (#11)", "b (#12)\n\nChant-Record: work:w-1", "c (#11)", "d"]);
      for (const sha of [init, d]) git(dir, "tag", `ci/green/${sha}`);
      const asked: number[] = [];
      const fetch: ForgeFetch = async (_url, init) => {
        const pr = (JSON.parse(init.body!) as { variables: { pr: number } }).variables.pr;
        asked.push(pr);
        const nodes = (pr === 11 ? [70, 71] : [72]).map((number) => ({ number, repository: { nameWithOwner: "acme/app" } }));
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes } } } } }) };
      };
      const forgeIssues = { env: { GH_TOKEN: "t" }, remoteUrl: "https://github.com/acme/app.git", fetch };
      const doc = await releaseCandidatesDocument({ cwd: dir, forgeIssues });
      expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      // One call per pull request, though #11 squashed two commits.
      expect(asked.sort()).toEqual([11, 12]);
      const changes = doc.candidates[0].changes;
      expect(changes.map((x) => [x.commit, x.pr, x.closes])).toEqual([
        [d, null, null],
        [c, 11, { resolved: true, issues: [70, 71], reason: null }],
        [b, 12, { resolved: true, issues: [72], reason: null }],
        [a, 11, { resolved: true, issues: [70, 71], reason: null }],
      ]);
      expect(doc.candidates[0].groups).toEqual([
        { work: "w-1", issue: null, pullRequests: [{ pr: 12, commits: [b] }] },
        { work: null, issue: 70, pullRequests: [{ pr: 11, commits: [c, a] }] },
        { work: null, issue: 71, pullRequests: [{ pr: 11, commits: [c, a] }] },
        { work: null, issue: null, pullRequests: [{ pr: null, commits: [d] }] },
      ]);

      // Without a token the pull request stands alone, unresolved, and nothing is asked.
      asked.length = 0;
      const offline = await releaseCandidatesDocument({ cwd: dir, forgeIssues: { ...forgeIssues, env: {}, ghToken: () => undefined } });
      expectValid(offline);
      if ("error" in offline) throw new Error(offline.error.message);
      expect(asked).toEqual([]);
      expect(offline.candidates[0].changes[1]).toMatchObject({ pr: 11, closes: { resolved: false, issues: [] } });
      expect(offline.candidates[0].groups.map((g) => [g.work, g.issue])).toEqual([["w-1", null], [null, null]]);

      // Not asked, closes is null.
      const plain = await releaseCandidatesDocument({ cwd: dir });
      if ("error" in plain) throw new Error(plain.error.message);
      expect(plain.candidates[0].changes.every((x) => x.closes === null)).toBe(true);
    });
  });

  test("outside git it is the failure not-a-git-repository", async () => {
    await withTestDir(async (dir) => {
      const doc = await releaseCandidatesDocument({ cwd: dir });
      expectValid(doc);
      expect(doc).toMatchObject({ error: { code: "not-a-git-repository" } });
    });
  });
});
