/**
 * Merge records (#4168 step 1) against temp git repos: written under the
 * commit on chant/lifecycle, rewritten only when the record changed, read
 * back, and validated against the schema; and where the change came from.
 */

import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MERGE_RECORD_CONTRACT, MERGE_RECORD_SCHEMA_ID, MERGES_DIR, mergeRecordFile, mergeSourceOf, readMergeRecord, writeMergeRecord, type MergeRecord } from "./merge-record";
import { contract, validSchema } from "../workspace/__fixtures__/contract-repo";
import schema from "../workspace/merge-record.schema.json";

const { expectValid } = contract(schema);

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(dir: string): string {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@chant.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return git(dir, "rev-parse", "HEAD");
}

const record = (commit: string, over: Partial<MergeRecord> = {}): MergeRecord => ({
  $schema: MERGE_RECORD_SCHEMA_ID,
  contract: MERGE_RECORD_CONTRACT,
  commit,
  base: "b".repeat(40),
  env: "prod",
  source: { kind: "pull-request", pr: 12 },
  op: "pr-12",
  gate: "pr-apply",
  digest: `jcs1-sha256:${"1".repeat(64)}`,
  plan: "approved",
  approvedBy: ["github:rev"],
  components: ["net", "app"],
  recordedAt: "2026-10-20T00:00:00.000Z",
  ...over,
});

describe("the merge record schema", () => {
  test("is a valid schema and names this module's id", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(MERGE_RECORD_SCHEMA_ID);
  });

  test("each source and plan status validates", () => {
    const sha = "a".repeat(40);
    expectValid(record(sha));
    expectValid(record(sha, { source: { kind: "work-item", records: [{ kind: "work", id: "w-7" }] }, op: null, plan: "unapproved", approvedBy: [] }));
    expectValid(record(sha, { source: { kind: "direct-push" }, op: null, digest: null, plan: "nothing", approvedBy: [], components: [] }));
    expectValid(record(sha, { plan: "changed", approvedDigest: `jcs1-sha256:${"9".repeat(64)}`, approvedBy: [], authorApproved: ["github:carol"], member: "net" }));
  });
});

describe("writeMergeRecord and readMergeRecord", () => {
  test("writes the record under its commit, leaves the same record alone, and replaces a changed one", async () => {
    await withTestDir(async (dir) => {
      const sha = initRepo(dir);
      expect(await readMergeRecord(sha, { cwd: dir })).toBeNull();
      expect((await writeMergeRecord(record(sha), { cwd: dir })).written).toBe(true);
      expect(git(dir, "ls-tree", "--name-only", `chant/lifecycle:${MERGES_DIR}`)).toBe(mergeRecordFile(sha));
      expect(await readMergeRecord(sha, { cwd: dir })).toEqual(record(sha));

      // The record job ran again: only the time differs, so nothing is written.
      const tip = git(dir, "rev-parse", "chant/lifecycle");
      expect((await writeMergeRecord(record(sha, { recordedAt: "2026-10-21T00:00:00.000Z" }), { cwd: dir })).written).toBe(false);
      expect(git(dir, "rev-parse", "chant/lifecycle")).toBe(tip);

      // A plan that moved since is a new record for the same commit.
      const moved = record(sha, { plan: "changed", approvedDigest: `jcs1-sha256:${"9".repeat(64)}`, approvedBy: [] });
      expect((await writeMergeRecord(moved, { cwd: dir })).written).toBe(true);
      expect(await readMergeRecord(sha, { cwd: dir })).toEqual(moved);
    });
  });

  test("a member's record sits under its own prefix", async () => {
    await withTestDir(async (dir) => {
      const sha = initRepo(dir);
      await writeMergeRecord(record(sha, { member: "net" }), { cwd: dir, member: "net" });
      expect(git(dir, "ls-tree", "-r", "--name-only", "chant/lifecycle")).toBe(`_members/net/${MERGES_DIR}/${mergeRecordFile(sha)}`);
      expect(await readMergeRecord(sha, { cwd: dir, member: "net" })).toMatchObject({ member: "net" });
      expect(await readMergeRecord(sha, { cwd: dir })).toBeNull();
    });
  });
});

describe("mergeSourceOf", () => {
  test("a pull request first, then the work items a commit's trailers name, then a direct push", async () => {
    await withTestDir(async (dir) => {
      const plain = initRepo(dir);
      expect(mergeSourceOf(dir, plain, 12)).toEqual({ kind: "pull-request", pr: 12 });
      expect(mergeSourceOf(dir, plain, null)).toEqual({ kind: "direct-push" });
      writeFileSync(join(dir, "a.txt"), "a\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "carry out w-7\n\nChant-Record: work:w-7\nChant-Record: decision:d-1\nChant-Record: work:w-8\nChant-Record: work:w-7");
      expect(mergeSourceOf(dir, git(dir, "rev-parse", "HEAD"), null)).toEqual({ kind: "work-item", records: [{ kind: "work", id: "w-7" }, { kind: "work", id: "w-8" }] });
      expect(mergeSourceOf(dir, "f".repeat(40), null)).toEqual({ kind: "direct-push" });
    });
  });
});
