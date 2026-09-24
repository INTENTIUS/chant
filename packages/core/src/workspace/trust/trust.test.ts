/**
 * #2547: attestors and policy read from the base revision.
 *
 * Every verification path is tested with the attacker controlling the working
 * tree and the change under review: an edited signers file, a signature by a
 * key the same change adds, a backdated commit, a trailer, a signature in the
 * wrong namespace, and a forged merge.
 */

import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020";
import schema from "../records.schema.json";
import { afterEach, describe, expect, test } from "vitest";
import { queryRecords, type RecordsDocument, type RecordView } from "../records-cli";
import { activeAttestors } from "./attestor";
import { parseAllowedSigners } from "./policy";
import { verifyChange } from "./verify";
import { hasSshKeygen, note, TestRepo, writeRecordKind, type Key } from "./test-repo";

const repos: TestRepo[] = [];
function repo(label: string): TestRepo {
  const r = new TestRepo(label);
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

function signers(...entries: Array<[string, Key] | string>): string {
  return entries.map((e) => (typeof e === "string" ? e : `${e[0]} ${e[1].pub}`)).join("\n") + "\n";
}

async function verify(r: TestRepo, opts: { base?: string; head?: string; require?: "attested" } = {}) {
  return verifyChange({ repo: r.dir, base: opts.base ?? "main", head: opts.head, require: opts.require, attestors: await activeAttestors() });
}

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** Records through the real query; every document is checked against the published output schema. */
async function records(r: TestRepo, kind: string, extra: { base?: string; at?: string } = {}): Promise<RecordView[]> {
  const doc: RecordsDocument = await queryRecords({ kind, cwd: r.dir, base: extra.base ?? "main", at: extra.at });
  expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  if ("error" in doc) throw new Error(doc.error.message);
  return doc.records;
}

function level(rs: RecordView[], id: string): string {
  return rs.find((r) => r.id === id)!.provenance.level;
}

describe("parseAllowedSigners", () => {
  const k = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrbXxpbHmPGSDRaxyUkF4H1j3VsnNwhk4tEsZ7Cw6Tt";

  test("reads principals, namespaces and comments", () => {
    const set = parseAllowedSigners(`# team\nalice@example.test ${k} laptop\n"bob@example.test,carol@example.test" namespaces="git,file" ${k}\n\n`);
    expect(set.excluded).toEqual([]);
    expect(set.signers.map((s) => [s.principal, s.namespaces, s.line])).toEqual([
      ["alice@example.test", undefined, 2],
      ["bob@example.test", "git,file", 3],
      ["carol@example.test", "git,file", 3],
    ]);
    expect(set.signers[0].key).toBe(k);
  });

  test("refuses entries whose meaning depends on a date, a CA or a pattern", () => {
    const set = parseAllowedSigners(
      [
        `old@example.test valid-before="20200101" ${k}`,
        `new@example.test valid-after="20990101" ${k}`,
        `ca@example.test cert-authority ${k}`,
        `*@example.test ${k}`,
        `x@example.test no-touch-required ${k}`,
        `broken`,
      ].join("\n"),
    );
    expect(set.signers).toEqual([]);
    expect(set.excluded.map((e) => e.line)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(set.excluded[0].reason).toMatch(/commit's own date/);
  });
});

describe.skipIf(!hasSshKeygen)("the ssh-commit attestor, against the policy at base", () => {
  /** main: alice (admin) and bob are signers; one note record. Returns keys and the kind path. */
  function baseline(label: string, opts: { admin?: boolean } = {}) {
    const r = repo(label);
    const alice = r.key("alice");
    const bob = r.key("bob");
    const mallory = r.key("mallory");
    const kind = writeRecordKind(r);
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice], ["bob@example.test", bob]));
    if (opts.admin) r.write(".chant/trust.json", JSON.stringify({ schema: 1, roles: { admin: ["alice@example.test"] } }));
    r.write("records/n1.md", note("n1"));
    r.commit("policy and first record", alice);
    r.git(["checkout", "-q", "-b", "change"]);
    return { r, alice, bob, mallory, kind };
  }

  test("a commit signed by a signer at base is attested, and so is its record", async () => {
    const { r, bob, kind } = baseline("good");
    r.write("records/n2.md", note("n2"));
    r.commit("add n2", bob);
    const report = await verify(r, { require: "attested" });
    expect(report.failures).toEqual([]);
    expect(report.commits.map((c) => [c.level, c.principal])).toEqual([["attested", "bob@example.test"]]);
    const rs = await records(r, kind);
    expect(level(rs, "n1")).toBe("attested");
    expect(level(rs, "n2")).toBe("attested");
    expect(rs.find((x) => x.id === "n2")!.provenance.principal).toBe("bob@example.test");
  });

  test("attack: the change edits the signers file to add its own key, and signs with it", async () => {
    const { r, mallory, kind } = baseline("edited-signers");
    r.write(".chant/allowed_signers", signers(["mallory@example.test", mallory]));
    r.write("records/n1.md", note("n1", "rewritten"));
    r.commit("trust me", mallory);
    const report = await verify(r);
    expect(report.ok).toBe(false);
    expect(report.commits[0].level).toBe("unattested");
    expect(report.protectedWrites).toHaveLength(1);
    expect(report.protectedWrites[0].allowed).toBe(false);
    expect(report.failures.join("\n")).toMatch(/\.chant\/allowed_signers is protected/);
    // The record is judged by main's signers, where mallory is nobody.
    expect(level(await records(r, kind), "n1")).toBe("unattested");
  });

  test("attack: the signers file is edited in the working tree only", async () => {
    const { r, mallory, kind } = baseline("worktree-signers");
    r.write("records/n3.md", note("n3"));
    r.commit("n3", mallory);
    r.write(".chant/allowed_signers", signers(["mallory@example.test", mallory]));
    expect(level(await records(r, kind), "n3")).toBe("unattested");
    // Even reading at the base itself: the working-tree policy is never read.
    expect(level(await records(r, kind, { base: "HEAD" }), "n3")).toBe("unattested");
  });

  test("attack: a signer at base adds a key, and the change's next commit is signed by that key", async () => {
    const { r, alice, mallory, kind } = baseline("key-added-in-change");
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice], ["mallory@example.test", mallory]));
    r.commit("add mallory", alice);
    r.write("records/n2.md", note("n2"));
    r.commit("n2", mallory);
    const report = await verify(r, { require: "attested" });
    // The policy edit itself is signed by alice, a signer at base: allowed.
    expect(report.protectedWrites.map((w) => w.allowed)).toEqual([true]);
    // mallory's key is not in the policy at base, so her commit is not attested.
    expect(report.commits.map((c) => c.level)).toEqual(["attested", "unattested"]);
    expect(report.ok).toBe(false);
    expect(level(await records(r, kind), "n2")).toBe("unattested");
  });

  test("attack: a backdated commit signed by a key whose valid-before window has closed", async () => {
    const r = repo("backdated");
    const alice = r.key("alice");
    const old = r.key("old");
    const kind = writeRecordKind(r);
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice], `old@example.test valid-before="20200101" ${old.pub}`));
    r.commit("policy", alice);
    r.git(["checkout", "-q", "-b", "change"]);
    r.write("records/n1.md", note("n1"));
    const date = "2019-06-01T00:00:00Z";
    const c = r.commit("backdated", old, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });

    // git's own check trusts the commit's date, so it accepts this signature.
    r.write("allowed-for-git", signers(`old@example.test valid-before="20200101" ${old.pub}`));
    const gitSays = execFileSync("git", ["-c", `gpg.ssh.allowedSignersFile=${r.dir}/allowed-for-git`, "verify-commit", c], {
      cwd: r.dir,
      env: r.env(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(gitSays).toBeDefined();

    const report = await verify(r, { require: "attested" });
    expect(report.policy.excluded.map((e) => e.line)).toEqual([2]);
    expect(report.commits[0].level).toBe("unattested");
    expect(report.ok).toBe(false);
    expect(level(await records(r, kind), "n1")).toBe("unattested");
  });

  test("attack: a backdated commit by a key removed from the signers before base", async () => {
    const { r, alice, bob, kind } = baseline("backdated-revoked");
    r.git(["checkout", "-q", "main"]);
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice]));
    r.commit("remove bob", alice);
    r.git(["checkout", "-q", "-b", "late"]);
    r.write("records/n2.md", note("n2"));
    const date = "2001-01-01T00:00:00Z";
    r.commit("dated long ago", bob, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    const report = await verify(r, { require: "attested" });
    expect(report.commits[0].level).toBe("unattested");
    expect(report.ok).toBe(false);
    expect(level(await records(r, kind), "n2")).toBe("unattested");
  });

  test("attack: a trailer or an author name is not an attestation", async () => {
    const { r, kind } = baseline("trailer");
    r.write("records/n2.md", note("n2"));
    r.commit("n2\n\nSigned-off-by: alice@example.test\nApproved-by: alice@example.test", undefined, {
      GIT_AUTHOR_NAME: "alice",
      GIT_AUTHOR_EMAIL: "alice@example.test",
      GIT_COMMITTER_EMAIL: "alice@example.test",
    });
    const report = await verify(r, { require: "attested" });
    expect(report.commits[0].level).toBe("unattested");
    expect(report.commits[0].reason).toMatch(/not signed/);
    expect(level(await records(r, kind), "n2")).toBe("unattested");
  });

  test("attack: a valid signature by a base signer, made in another namespace, is spliced into a commit", async () => {
    const { r, bob } = baseline("namespace");
    r.write("records/n2.md", note("n2"));
    r.forgeCommit("n2", (payload) => r.sshSign(bob, payload, "file"));
    const report = await verify(r, { require: "attested" });
    expect(report.commits[0].level).toBe("unattested");
    expect(report.commits[0].reason).toMatch(/git namespace/);
  });

  test("attack: a signature lifted from another commit does not cover this one", async () => {
    const { r, bob } = baseline("lifted");
    const signed = r.git(["cat-file", "commit", "main"]);
    const sig = signed.split("\n").reduce<string[]>((acc, l) => {
      if (l.startsWith("gpgsig ")) acc.push(l.slice(7));
      else if (acc.length && l.startsWith(" ")) acc.push(l.slice(1));
      return acc;
    }, []);
    void bob;
    r.write("records/n2.md", note("n2"));
    r.forgeCommit("n2", () => sig.join("\n") + "\n");
    const report = await verify(r);
    expect(report.commits[0].level).toBe("unattested");
  });

  test("an OpenPGP signature is reported as present but unverifiable here", async () => {
    const { r, kind } = baseline("pgp");
    r.write("records/n2.md", note("n2"));
    r.forgeCommit("n2", () => "-----BEGIN PGP SIGNATURE-----\n\nwsBcBAABCAAQBQJ\n-----END PGP SIGNATURE-----\n");
    const report = await verify(r, { require: "attested" });
    expect(report.commits[0].level).toBe("attested-unverifiable-here");
    expect(report.ok).toBe(false);
    expect(level(await records(r, kind), "n2")).toBe("attested-unverifiable-here");
  });

  test("an uncommitted edit to a signed record is unattested", async () => {
    const { r, kind } = baseline("dirty");
    r.write("records/n1.md", note("n1", "edited"));
    const rs = await records(r, kind);
    expect(level(rs, "n1")).toBe("unattested");
    expect(rs[0].provenance.reason).toMatch(/uncommitted/);
    // The committed version, read with --at, is still attested.
    expect(level(await records(r, kind, { at: "HEAD" }), "n1")).toBe("attested");
  });

  test("attack: an evil merge changes a record beyond either parent, and is judged as its own commit", async () => {
    const { r, bob, kind } = baseline("evil-merge");
    r.write("records/n2.md", note("n2"));
    r.commit("side", bob);
    r.git(["checkout", "-q", "main"]);
    r.git(["checkout", "-q", "-b", "merge"]);
    r.write("other.txt", "x");
    r.commit("other", bob);
    r.git(["merge", "-q", "--no-ff", "--no-commit", "change"]);
    r.write("records/n2.md", note("n2", "slipped in during the merge"));
    r.commit("merge");
    const rs = await records(r, kind);
    expect(level(rs, "n2")).toBe("unattested");
    const report = await verify(r, { require: "attested" });
    expect(report.ok).toBe(false);
  });

  test("a merge with no changes of its own is passed through to the commits it brings", async () => {
    const { r, bob, kind } = baseline("clean-merge");
    r.write("records/n2.md", note("n2"));
    r.commit("side", bob);
    r.git(["checkout", "-q", "main"]);
    r.git(["checkout", "-q", "-b", "merge"]);
    r.write("other.txt", "x");
    r.commit("other", bob);
    r.git(["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge", "change"]);
    expect(level(await records(r, kind), "n2")).toBe("attested");
    const report = await verify(r, { require: "attested" });
    expect(report.failures).toEqual([]);
    expect(report.commits.find((c) => c.subject === "merge")!.skipped).toBeDefined();
  });

  test("with an admin role granted, a policy edit by a non-admin signer is refused", async () => {
    const { r, alice, bob } = baseline("admin", { admin: true });
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice], ["bob@example.test", bob], ["carol@example.test", r.key("carol")]));
    r.commit("add carol", bob);
    let report = await verify(r);
    expect(report.protectedWrites[0]).toMatchObject({ allowed: false, principal: "bob@example.test" });
    expect(report.ok).toBe(false);

    r.git(["reset", "-q", "--hard", "main"]);
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, roles: { admin: ["bob@example.test"] } }));
    r.commit("make bob admin", bob);
    report = await verify(r);
    expect(report.protectedWrites[0]).toMatchObject({ allowed: false, paths: [".chant/trust.json"] });

    r.git(["reset", "-q", "--hard", "main"]);
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice], ["bob@example.test", bob], ["carol@example.test", r.key("carol2")]));
    r.commit("add carol", alice);
    report = await verify(r);
    expect(report.ok).toBe(true);
  });

  test("attack: pointing trust.json at another signers file is itself a protected write", async () => {
    const { r, mallory } = baseline("redirect");
    r.write("mine", signers(["mallory@example.test", mallory]));
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, signers: "mine" }));
    r.commit("redirect", mallory);
    const report = await verify(r);
    expect(report.protectedWrites[0]).toMatchObject({ allowed: false, paths: [".chant/trust.json"] });
    expect(report.ok).toBe(false);
  });

  test("deleting the signers file is a protected write", async () => {
    const { r } = baseline("delete");
    r.git(["rm", "-q", ".chant/allowed_signers"]);
    r.commit("turn it off");
    const report = await verify(r);
    expect(report.protectedWrites[0].allowed).toBe(false);
    expect(report.ok).toBe(false);
  });

  test("an unreadable trust.json at base fails closed", async () => {
    const { r, alice, kind } = baseline("bad-trust");
    r.git(["checkout", "-q", "main"]);
    r.write(".chant/trust.json", "{ not json");
    r.commit("oops", alice);
    r.git(["checkout", "-q", "-b", "next"]);
    r.write("records/n2.md", note("n2"));
    r.commit("n2", alice);
    const report = await verify(r);
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toMatch(/cannot be read/);
    expect(level(await records(r, kind), "n2")).toBe("unattested");
  });

  test("a commit range the base policy adopts is adopted", async () => {
    const r = repo("adopted");
    const alice = r.key("alice");
    const kind = writeRecordKind(r);
    r.write("records/n1.md", note("n1"));
    const old = r.commit("history before signing");
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice]));
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, adopted: [{ to: old, note: "before signing" }] }));
    r.commit("start signing", alice);
    const rs = await records(r, kind);
    expect(level(rs, "n1")).toBe("adopted");
  });
});

describe("attestation is opt-in", () => {
  test("without a signers file at base nothing is verified, and every record is unattested", async () => {
    const r = repo("off");
    const kind = writeRecordKind(r);
    r.write("records/n1.md", note("n1"));
    r.commit("n1");
    r.git(["checkout", "-q", "-b", "change"]);
    r.write("records/n2.md", note("n2"));
    r.commit("n2");
    const report = await verify(r);
    expect(report.ok).toBe(true);
    expect(report.commits).toEqual([]);
    expect(report.notes[0]).toMatch(/attestation is off/);
    const doc = await queryRecords({ kind, cwd: r.dir });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.trust).toMatchObject({ active: false, baseFrom: "main" });
    expect(doc.records.every((x) => x.provenance.level === "unattested")).toBe(true);
    // A gate that asks for attested still fails.
    expect((await verify(r, { require: "attested" })).ok).toBe(false);
  });

  test.skipIf(!hasSshKeygen)("a change that adds the first signers file applies only after it merges", async () => {
    const r = repo("first");
    r.write("a.txt", "a");
    r.commit("a");
    r.git(["checkout", "-q", "-b", "change"]);
    const alice = r.key("alice");
    r.write(".chant/allowed_signers", signers(["alice@example.test", alice]));
    r.commit("start signing", alice);
    const report = await verify(r);
    expect(report.ok).toBe(true);
    expect(report.notes.join("\n")).toMatch(/applies to changes made after it is merged/);
  });

  test("outside git every record is unattested", async () => {
    const r = repo("nogit");
    const kind = writeRecordKind(r);
    r.write("records/n1.md", note("n1"));
    execFileSync("rm", ["-rf", `${r.dir}/.git`]);
    const doc = await queryRecords({ kind, cwd: r.dir });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.records[0].provenance).toMatchObject({ level: "unattested", reason: "not in a git repository" });
  });
});
