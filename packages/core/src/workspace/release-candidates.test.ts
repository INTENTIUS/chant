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
import { prFromSubject, recordTrailers, releaseCandidatesDocument, RELEASE_CANDIDATES_SCHEMA_ID } from "./release-candidates";
import { appendCut, makeRelease, persistRelease } from "../lifecycle/release-store";
import { appendReleaseRecord } from "../lifecycle/release-ledger";
import { writeLedgerFiles } from "../lifecycle/git";

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
      await writeLedgerFiles([{ path: `_merges/${d}.json`, content: JSON.stringify({ pr: 40, approvedDigest: "sha256:x" }) }], "merge record", { cwd: dir });

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
      expect(doc.candidates[0].changes[0]).toMatchObject({ pr: 40, merge: { pr: 40, approvedDigest: "sha256:x" } });
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

  test("outside git it is the failure not-a-git-repository", async () => {
    await withTestDir(async (dir) => {
      const doc = await releaseCandidatesDocument({ cwd: dir });
      expectValid(doc);
      expect(doc).toMatchObject({ error: { code: "not-a-git-repository" } });
    });
  });
});
