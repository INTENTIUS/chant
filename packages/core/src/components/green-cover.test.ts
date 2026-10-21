/**
 * #4168 step 9: apply on merge per green commit. `coverByMerges` checks the
 * plan at a green commit against the approved plans of the merges since the
 * last applied one; `resolveGreenTarget` finds those merges and where the
 * change is measured from.
 */

import { afterAll, describe, expect, test } from "vitest";
import { composeChangeSet, type ChangeSetEntry } from "../change-set";
import { cleanScratch, commitAll, declaration, git, repo, writeFiles } from "../workspace/__fixtures__/contract-repo";
import { memoryGateLedgerPort } from "../op/gate";
import { persistChangeSet } from "../lifecycle/change-set-store";
import { MERGE_RECORD_CONTRACT, MERGE_RECORD_SCHEMA_ID, writeMergeRecord, type MergeRecord } from "../lifecycle/merge-record";
import { GREEN_APPLY_CONTRACT, readGreenApply, writeGreenApply } from "../lifecycle/green-apply";
import { coverByMerges, greenOp, resolveGreenTarget, type ApprovedMerge } from "./green-cover";

afterAll(cleanScratch);

const member = (name: string, digest: string) => ({
  member: name,
  lexicon: "terraform",
  planner: "tofu" as const,
  status: "planned" as const,
  planDigest: `jcs1-sha256:${digest.repeat(64)}`,
  holes: [],
});
const write = (name: string, cidr: string, action: ChangeSetEntry["action"] = "update"): ChangeSetEntry => ({
  member: name,
  lexicon: "terraform",
  planner: "tofu",
  address: `${name}.main`,
  type: "aws_subnet",
  action,
  attributes: action === "no-op" ? [] : [{ path: "cidr", after: cidr }],
});
const merge = (commit: string, pr: number, parts: Array<[string, string, string]>, approvedBy = [`github:r${pr}`]): ApprovedMerge => ({
  commit,
  pr,
  doc: composeChangeSet(parts.map(([name, digest, cidr]) => ({ member: member(name, digest), entries: [write(name, cidr)] }))),
  approvedBy,
});

describe("coverByMerges", () => {
  test("each member is checked against the newest merge that planned it, and the approvers of the merges used are kept", () => {
    const merges = [merge("a".repeat(40), 1, [["net", "1", "10.0.0.0/16"], ["app", "2", "10.1.0.0/16"]]), merge("b".repeat(40), 2, [["app", "3", "10.2.0.0/16"]])];
    // net as #1 approved it, app as #2 (the newer one) approved it.
    const fresh = composeChangeSet([
      { member: member("net", "1"), entries: [write("net", "10.0.0.0/16")] },
      { member: member("app", "3"), entries: [write("app", "10.2.0.0/16")] },
    ]);
    expect(coverByMerges(fresh, merges)).toEqual({ covered: true, uncovered: [], approvedBy: ["github:r1", "github:r2"], coveredBy: ["a".repeat(40), "b".repeat(40)] });
  });

  test("an older merge's plan does not cover a member a newer merge planned again", () => {
    const merges = [merge("a".repeat(40), 1, [["app", "2", "10.1.0.0/16"]]), merge("b".repeat(40), 2, [["app", "3", "10.2.0.0/16"]])];
    const fresh = composeChangeSet([{ member: member("app", "4"), entries: [write("app", "10.1.0.0/16")] }]);
    const cover = coverByMerges(fresh, merges);
    expect(cover.covered).toBe(false);
    expect(cover.uncovered).toEqual(["app now writes app.main.cidr to a different value than the approved plan (checked against #2)"]);
  });

  test("a member no merge planned is not covered, and a member with nothing to do needs no approval", () => {
    const merges = [merge("a".repeat(40), 1, [["net", "1", "10.0.0.0/16"]])];
    const fresh = composeChangeSet([
      { member: member("net", "1"), entries: [write("net", "10.0.0.0/16")] },
      { member: member("edge", "5"), entries: [write("edge", "10.9.0.0/16")] },
      { member: member("idle", "6"), entries: [write("idle", "", "no-op")] },
    ]);
    expect(coverByMerges(fresh, merges)).toMatchObject({
      covered: false,
      uncovered: ["edge: no merge since the last applied green commit had an approved plan for it"],
      coveredBy: ["a".repeat(40)],
    });
    expect(coverByMerges(composeChangeSet([{ member: member("idle", "6"), entries: [write("idle", "", "no-op")] }]), [])).toMatchObject({ covered: true, approvedBy: [] });
  });

  test("a green commit's own gate is recorded under green-<sha>", () => {
    expect(greenOp("c".repeat(40))).toBe(`green-${"c".repeat(12)}`);
    expect(greenOp("c".repeat(40), "net")).toBe(`green-${"c".repeat(12)}-net`);
  });
});

describe("resolveGreenTarget", () => {
  const GREEN = { branch: "main", phases: { test: ["test"] }, require: ["test"], source: "runs" };

  /** A repository with three commits on main: c1 and c3 tagged green, c2 not. */
  function history(): { root: string; c1: string; c2: string; c3: string } {
    const root = repo({ "chant.workspace.json": declaration([], { ci: { green: GREEN } }), "a.txt": "1\n" }, true);
    git(root, "branch", "-M", "main");
    const c1 = git(root, "rev-parse", "HEAD");
    writeFiles(root, { "a.txt": "2\n" });
    const c2 = commitAll(root, "two");
    writeFiles(root, { "a.txt": "3\n" });
    const c3 = commitAll(root, "three");
    for (const c of [c1, c3]) git(root, "tag", `ci/green/${c}`, c);
    return { root, c1, c2, c3 };
  }

  const record = (commit: string, base: string, pr: number, plan: MergeRecord["plan"], digest: string | null): MergeRecord => ({
    $schema: MERGE_RECORD_SCHEMA_ID,
    contract: MERGE_RECORD_CONTRACT,
    commit,
    base,
    env: "prod",
    source: { kind: "pull-request", pr },
    op: `pr-${pr}`,
    gate: "pr-apply",
    digest,
    plan,
    approvedBy: [],
    components: ["net"],
    recordedAt: "2026-10-21T00:00:00Z",
  });

  test("HEAD must be green", async () => {
    const { root, c2 } = history();
    git(root, "checkout", "-q", c2);
    const r = await resolveGreenTarget({ cwd: root, env: "prod", gate: "pr-apply" });
    expect(r).toMatchObject({ status: "error", message: expect.stringContaining("is not a green commit") });
  });

  test("with nothing applied it measures from the green commit before, else --base, and lists the merges with a standing approval", async () => {
    const { root, c1, c2, c3 } = history();
    const approved = composeChangeSet([{ member: member("net", "1"), entries: [write("net", "10.0.0.0/16")] }]);
    await persistChangeSet(approved, { cwd: root });
    await writeMergeRecord(record(c2, c1, 2, "approved", approved.digest), { cwd: root });
    await writeMergeRecord(record(c3, c2, 3, "unapproved", null), { cwd: root });
    const ledger = memoryGateLedgerPort({
      resolutions: [{ version: 1, kind: "resolution", op: "pr-2", gate: "pr-apply", resolvedBy: "github:alice", timestamp: "2026-10-21T00:00:00Z", planDigest: approved.digest }],
    });

    const r = await resolveGreenTarget({ cwd: root, env: "prod", gate: "pr-apply", ledger });
    expect(r.status).toBe("target");
    if (r.status !== "target") return;
    expect(r.target).toMatchObject({ commit: c3, base: c1, baseFrom: "previous-green", merges: [c2, c3], prs: [2, 3] });
    expect(r.target.approved.map((m) => [m.commit, m.pr, m.doc.digest, m.approvedBy])).toEqual([[c2, 2, approved.digest, ["github:alice"]]]);

    // No approval stands for #2 any more: nothing covers.
    const none = await resolveGreenTarget({ cwd: root, env: "prod", gate: "pr-apply", ledger: memoryGateLedgerPort() });
    expect(none.status === "target" && none.target.approved).toEqual([]);

    const flagged = await resolveGreenTarget({ cwd: root, env: "prod", gate: "pr-apply", base: c2, ledger });
    expect(flagged).toMatchObject({ status: "target", target: { base: c2, baseFrom: "flag", merges: [c3] } });
  });

  test("once a green commit is applied the next measures from it, and applying it again is nothing", async () => {
    const { root, c1, c2, c3 } = history();
    const applied = { contract: GREEN_APPLY_CONTRACT, env: "prod", commit: c2, base: c1, digest: "jcs1-sha256:x", approval: "gate" as const, approvedBy: [], merges: [c2], appliedAt: "2026-10-21T00:00:00Z" };
    await writeGreenApply(applied, { cwd: root });
    expect(await readGreenApply("prod", { cwd: root })).toEqual(applied);
    // The record wins over --base.
    expect(await resolveGreenTarget({ cwd: root, env: "prod", gate: "pr-apply", base: c1, ledger: memoryGateLedgerPort() })).toMatchObject({
      status: "target",
      target: { base: c2, baseFrom: "applied", merges: [c3], prs: [] },
    });
    await writeGreenApply({ ...applied, commit: c3, base: c2, merges: [c3] }, { cwd: root });
    expect(await resolveGreenTarget({ cwd: root, env: "prod", gate: "pr-apply" })).toEqual({ status: "applied", commit: c3 });
    // Another environment has applied nothing.
    expect(await resolveGreenTarget({ cwd: root, env: "staging", gate: "pr-apply", ledger: memoryGateLedgerPort() })).toMatchObject({ status: "target", target: { base: c1 } });
  });

  test("without ci.green there is no green commit to apply", async () => {
    const root = repo({ "chant.workspace.json": declaration([]), "a.txt": "1\n" }, true);
    expect(await resolveGreenTarget({ cwd: root, env: "prod", gate: "pr-apply" })).toMatchObject({
      status: "error",
      message: expect.stringContaining("apply on merge applies green commits"),
      hint: expect.stringContaining("ci.green"),
    });
  });
});
