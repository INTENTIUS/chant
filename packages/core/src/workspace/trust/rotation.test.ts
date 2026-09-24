/**
 * #2553: signer rotation, verified from history, with revocation by position.
 *
 * The attacker controls the change and its commit dates: a rotation signed by
 * the key it adds, too few signatures, a replayed or rolled-back set, a commit
 * signature passed off as a rotation signature, a main branch whose set was
 * changed without a rotation, and a revoked key's commit backdated to before
 * the revocation.
 */

import { afterEach, describe, expect, test } from "vitest";
import { queryRecords, type RecordView } from "../records-cli";
import { activeAttestors } from "./attestor";
import { policyAtBase, resolveBase } from "./provenance";
import { signerHistory } from "./rotation";
import { verifyChange } from "./verify";
import { hasSshKeygen, note, TestRepo, writeRecordKind, writeRotation, type Key } from "./test-repo";

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

function signers(...entries: Array<[string, Key]>): string {
  return entries.map(([p, k]) => `${p} ${k.pub}`).join("\n") + "\n";
}

async function verify(r: TestRepo, require?: "attested") {
  return verifyChange({ repo: r.dir, base: "main", require, attestors: await activeAttestors() });
}

async function records(r: TestRepo, kind: string): Promise<RecordView[]> {
  const doc = await queryRecords({ kind, cwd: r.dir, base: "main" });
  if ("error" in doc) throw new Error(doc.error.message);
  return doc.records;
}

function level(rs: RecordView[], id: string): string {
  return rs.find((x) => x.id === id)!.provenance.level;
}

/** main holds version 1: alice and bob, with `threshold`. */
function setup(label: string, threshold = 1) {
  const r = new TestRepo(label);
  repos.push(r);
  const alice = r.key("alice");
  const bob = r.key("bob");
  const carol = r.key("carol");
  const kind = writeRecordKind(r);
  const v1 = signers(["alice@example.test", alice], ["bob@example.test", bob]);
  r.write(".chant/allowed_signers", v1);
  if (threshold !== 1) {
    r.write(".chant/allowed_signers.rotation.json", JSON.stringify({ schema: 1, version: 1, previous: null, threshold, signatures: [] }));
  }
  r.commit("signers v1", alice);
  return { r, alice, bob, carol, kind, v1 };
}

describe.skipIf(!hasSshKeygen)("signer rotation", () => {
  test("a new set signed by the old one is accepted, and history shows both versions", async () => {
    const { r, alice, bob, carol, v1 } = setup("rotate");
    r.git(["checkout", "-q", "-b", "change"]);
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice], ["bob@example.test", bob], ["carol@example.test", carol]));
    writeRotation(r, { previousText: v1, version: 2, by: [["alice@example.test", alice]] });
    r.commit("add carol", alice);
    const report = await verify(r);
    expect(report.failures).toEqual([]);
    expect(report.rotation).toEqual({ from: 1, to: 2, signedBy: ["alice@example.test"] });

    r.git(["checkout", "-q", "main"]);
    r.git(["merge", "-q", "--ff-only", "change"]);
    const h = signerHistory(r.dir, r.head(), ".chant/allowed_signers");
    expect(h.broken).toBeUndefined();
    expect(h.versions.map((v) => [v.version, v.signedBy])).toEqual([
      [1, []],
      [2, ["alice@example.test"]],
    ]);
  });

  test("attack: the change's new signer signs her own admission", async () => {
    const { r, alice, bob, carol, v1 } = setup("self-admit");
    r.git(["checkout", "-q", "-b", "change"]);
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice], ["bob@example.test", bob], ["carol@example.test", carol]));
    writeRotation(r, { previousText: v1, version: 2, by: [["carol@example.test", carol]] });
    r.commit("add carol", alice);
    const report = await verify(r);
    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toMatch(/signed by 0 of the 1 signers of version 1/);
  });

  test("a threshold of 2 needs two distinct keys; one key under two names counts once", async () => {
    const { r, alice, bob, carol, v1 } = setup("threshold", 2);
    r.git(["checkout", "-q", "-b", "change"]);
    const v2 = signers(["alice@example.test", alice], ["bob@example.test", bob], ["carol@example.test", carol]);
    r.write(".chant/allowed_signers", v2);
    writeRotation(r, { previousText: v1, version: 2, threshold: 2, by: [["alice@example.test", alice]] });
    r.commit("one signature", alice);
    expect((await verify(r)).failures.join("\n")).toMatch(/signed by 1 of the 2/);

    // alice's key listed twice at base would still be one key.
    writeRotation(r, { previousText: v1, version: 2, threshold: 2, by: [["alice@example.test", alice], ["alice@example.test", alice]] });
    r.commit("same key twice", alice);
    expect((await verify(r)).failures.join("\n")).toMatch(/signed by 1 of the 2/);

    writeRotation(r, { previousText: v1, version: 2, threshold: 2, by: [["alice@example.test", alice], ["bob@example.test", bob]] });
    r.commit("two signatures", alice);
    const report = await verify(r);
    expect(report.failures).toEqual([]);
    expect(report.rotation?.signedBy.sort()).toEqual(["alice@example.test", "bob@example.test"]);
  });

  test("attack: a commit signature, in the git namespace, is not a rotation signature", async () => {
    const { r, alice, bob, carol, v1 } = setup("namespace");
    r.git(["checkout", "-q", "-b", "change"]);
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice], ["bob@example.test", bob], ["carol@example.test", carol]));
    writeRotation(r, { previousText: v1, version: 2, by: [["alice@example.test", alice]], namespace: "git" });
    r.commit("add carol", alice);
    expect((await verify(r)).ok).toBe(false);
  });

  test("attack: rolling back to an older set, or replaying an old rotation, is refused", async () => {
    const { r, alice, bob, v1 } = setup("rollback");
    // version 2 removes bob, and is merged.
    const v2 = signers(["alice@example.test", alice]);
    r.write(".chant/allowed_signers", v2);
    writeRotation(r, { previousText: v1, version: 2, by: [["alice@example.test", alice]] });
    r.commit("remove bob", alice);
    const replay = r.git(["show", "HEAD:.chant/allowed_signers.rotation.json"]);

    // Restore v1 and bob, keeping version 2's rotation file.
    r.git(["checkout", "-q", "-b", "rollback"]);
    r.write(".chant/allowed_signers", v1);
    r.write(".chant/allowed_signers.rotation.json", replay);
    r.commit("bring bob back", alice);
    expect((await verify(r)).failures.join("\n")).toMatch(/the next version is 3/);

    // Or claim to be version 3 with version 1's digest as previous.
    writeRotation(r, { previousText: v1, version: 3, by: [["alice@example.test", alice], ["bob@example.test", bob]] });
    r.commit("claim v3", alice);
    expect((await verify(r)).failures.join("\n")).toMatch(/names previous/);
  });

  test("attack: a signer set changed on main without a rotation breaks the history, and nothing verifies", async () => {
    const { r, alice, bob, carol, kind } = setup("broken");
    r.write("records/n1.md", note("n1"));
    r.commit("n1", alice);
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice], ["bob@example.test", bob], ["carol@example.test", carol]));
    r.commit("pushed straight to main", alice);
    const policy = policyAtBase(r.dir, resolveBase(r.dir, "main"));
    expect(policy.problems[0]).toMatch(/signer history .* is broken/);
    expect(level(await records(r, kind), "n1")).toBe("unattested");
    r.git(["checkout", "-q", "-b", "change"]);
    expect((await verify(r)).ok).toBe(false);
  });

  test("attack: a revoked key keeps what was merged before its revocation, and nothing after, whatever the dates say", async () => {
    const { r, alice, bob, v1, kind } = setup("position");
    r.write("records/early.md", note("early"));
    r.commit("bob, before revocation", bob);
    r.git(["branch", "fork-before-revocation"]);

    const v2 = signers(["alice@example.test", alice]);
    r.write(".chant/allowed_signers", v2);
    writeRotation(r, { previousText: v1, version: 2, by: [["alice@example.test", alice]] });
    r.commit("revoke bob", alice);

    // bob, after revocation, backdates a commit onto a branch forked before it...
    r.git(["checkout", "-q", "fork-before-revocation"]);
    r.write("records/late.md", note("late"));
    const old = "2001-01-01T00:00:00Z";
    r.commit("bob, backdated", bob, { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });
    // ...and it is merged after the revocation, by a signer in good standing.
    r.git(["checkout", "-q", "main"]);
    r.git(["-c", "gpg.format=ssh", "-c", `user.signingkey=${alice.file}`, "merge", "-q", "--no-ff", "-S", "-m", "merge", "fork-before-revocation"]);

    // And straight onto main, backdated too.
    r.write("records/direct.md", note("direct"));
    r.commit("bob, backdated, on main", bob, { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });

    const rs = await records(r, kind);
    expect(level(rs, "early")).toBe("attested");
    expect(rs.find((x) => x.id === "early")!.provenance.principal).toBe("bob@example.test");
    expect(level(rs, "late")).toBe("unattested");
    expect(level(rs, "direct")).toBe("unattested");
  });

  test("the commit that adds the first signer set is judged by the set before it, which is none", async () => {
    const r = new TestRepo("genesis");
    repos.push(r);
    const alice = r.key("alice");
    const kind = writeRecordKind(r);
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice]));
    r.write("records/n1.md", note("n1"));
    r.commit("signers and a record together", alice);
    r.write("records/n2.md", note("n2"));
    r.commit("n2", alice);
    const rs = await records(r, kind);
    expect(level(rs, "n1")).toBe("unattested");
    expect(level(rs, "n2")).toBe("attested");
  });
});
