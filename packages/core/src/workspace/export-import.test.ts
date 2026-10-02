/**
 * #2552: export, import and hosted return.
 *
 * A host workspace exports a member that travels into its export member,
 * with a host-bound value switched. The export is copied into a repository
 * of its own, where someone the host never saw signs new work. Import brings
 * it back with host values restored, records the return with the commits the
 * work was made in, and the work reads as attested-unverifiable-here until an
 * admin admits the signer, then as attested by that signer.
 */

import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { exportWorkspace, readManifestAt } from "./export";
import { importWorkspace } from "./import";
import { fileEntries, fileHash, LOCK_FILE, readLock, renderLock, type Lineage } from "./lineage-lock";
import { queryRecords, type RecordView } from "./records-cli";
import { admitReturn, buildOrigin, parseReturn, verifyOrigin } from "./returns";
import { emptyPolicy, returnedPolicy } from "./trust/policy";
import { checkRecordSeal, sealRecord } from "./trust/seal";
import { hasSshKeygen, note, TestRepo, writeRecordKind, type Key } from "./trust/test-repo";

const repos: TestRepo[] = [];
function repo(label: string): TestRepo {
  const r = new TestRepo(label);
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

const HOST_DOMAIN = "studio.example.test";

function declaration(extra: Record<string, unknown>[] = []): string {
  return JSON.stringify(
    {
      name: "acme",
      schema: 1,
      records: [{ kind: "kinds/note.kind.mjs" }],
      members: [
        { name: "app", dir: "app", kind: "other", because: "a server", travel: true, links: [{ member: "ops", output: "url" }] },
        { name: "ops", dir: "ops", kind: "other", because: "stays home", outputs: ["url"] },
        { name: "out", dir: "out", kind: "workspace", roles: ["export"] },
        ...extra,
      ],
    },
    null,
    2,
  );
}

/** The host: app with a member lock whose `domain` parameter is host-bound, ops, and records. */
function host(r: TestRepo, admin?: Key): void {
  // The signer set comes first: a commit is judged by the set in effect before it (#2553).
  if (admin) {
    r.write(".chant/allowed_signers", `alice@example.test ${admin.pub}\n`);
    r.commit("signers", admin);
  }
  r.write("chant.workspace.json", declaration());
  r.write("app/server.txt", "hello\n");
  r.write("app/config.txt", `domain=${HOST_DOMAIN}\n`);
  r.write("ops/run.txt", "ops\n");
  writeRecordKind(r);
  r.write("records/n-1.md", note("n-1", "from the host"));
  const files = new Map([
    ["server.txt", Buffer.from("hello\n")],
    ["config.txt", Buffer.from(`domain=${HOST_DOMAIN}\n`)],
  ]);
  const lineage: Lineage = {
    kind: "template",
    template: "github.com/acme/starter",
    source: { type: "git", repo: "github.com/acme/starter", url: "https://github.com/acme/starter" },
    ref: "v1.0.0",
    address: { digest: `sha256:${"0".repeat(64)}` },
    parameters: { domain: HOST_DOMAIN },
    hostBound: { domain: ["config.txt"] },
    migrations: [],
    files: fileEntries(files),
    manualSteps: [],
  };
  r.write(`app/${LOCK_FILE}`, renderLock({ lockVersion: 1, scopes: { ".": lineage } }));
  r.commit("host", admin);
}

function changedOutside(r: TestRepo): string[] {
  return r
    .git(["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3));
}

describe("export (#2552)", () => {
  test("writes the members that travel into the export member, with host values switched", async () => {
    const r = repo("export");
    host(r);
    const res = await exportWorkspace({ root: r.dir, params: { domain: "copy.example.test" } });
    expect(res.member).toBe("out");
    expect(res.manifest.members).toEqual(["app"]);
    expect(res.manifest.whole).toBe(true);
    expect(res.manifest.dirs).toEqual(["kinds", "records"]);
    expect(res.switched).toEqual(["app/config.txt"]);
    // Only the export member was written.
    expect(changedOutside(r).every((p) => p.startsWith("out/"))).toBe(true);
    expect(readFileSync(join(r.dir, "out/app/config.txt"), "utf-8")).toBe("domain=copy.example.test\n");
    expect(readFileSync(join(r.dir, "app/config.txt"), "utf-8")).toBe(`domain=${HOST_DOMAIN}\n`);
    expect(existsSync(join(r.dir, "out/ops"))).toBe(false);
    // The export is a workspace: its declaration lists app, without the link to ops.
    const decl = JSON.parse(readFileSync(join(r.dir, "out/chant.workspace.json"), "utf-8"));
    expect(decl.members.map((m: { name: string }) => m.name)).toEqual(["app"]);
    expect(decl.members[0].links).toBeUndefined();
    expect(decl.records).toEqual([{ kind: "kinds/note.kind.mjs" }]);
    expect(res.manifest.dropped.links).toEqual([{ member: "app", to: "ops" }]);
    // The lock records the export's value, and the unedited file keeps a matching hash.
    const lock = readLock(join(r.dir, "out/app"))!;
    expect(lock.scopes["."].parameters).toEqual({ domain: "copy.example.test" });
    expect(lock.scopes["."].files["config.txt"].sha256).toBe(fileHash("domain=copy.example.test\n"));
    expect(res.manifest.hostValues[`app/${LOCK_FILE}#.`]).toEqual({ domain: { host: HOST_DOMAIN, export: "copy.example.test" } });
    expect(readManifestAt(join(r.dir, "out"))!.id).toBe(res.manifest.id);
    // Records go byte for byte.
    expect(readFileSync(join(r.dir, "out/records/n-1.md"), "utf-8")).toBe(readFileSync(join(r.dir, "records/n-1.md"), "utf-8"));
  });

  test("refuses a member that does not travel, a parameter no lineage binds, and a full export member it did not write", async () => {
    const r = repo("refuse");
    host(r);
    await expect(exportWorkspace({ root: r.dir, members: ["ops"] })).rejects.toThrow(/does not set travel/);
    await expect(exportWorkspace({ root: r.dir, params: { nope: "x" } })).rejects.toThrow(/no exported lineage has a host-bound parameter/);
    r.write("out/mine.txt", "not an export\n");
    await expect(exportWorkspace({ root: r.dir })).rejects.toThrow(/holds files no export wrote/);
  });

  test("never writes into another member", async () => {
    const r = repo("nested");
    r.write(
      "chant.workspace.json",
      JSON.stringify({ name: "acme", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "x", travel: true }, { name: "out", dir: "app/out", kind: "workspace", roles: ["export"] }] }),
    );
    r.write("app/a.txt", "a\n");
    r.commit("nested");
    await expect(exportWorkspace({ root: r.dir })).rejects.toThrow(/inside member app/);
  });
});

describe("import (#2552)", () => {
  test("brings changes back, restores host values, and writes the export member again", async () => {
    const r = repo("import");
    host(r);
    await exportWorkspace({ root: r.dir, params: { domain: "copy.example.test" } });
    r.commit("export");
    writeFileSync(join(r.dir, "out/app/server.txt"), "hello from the copy\n");
    writeFileSync(join(r.dir, "out/app/config.txt"), "domain=copy.example.test\nport=8080\n");
    const res = await importWorkspace({ root: r.dir });
    expect(res.conflicts).toEqual([]);
    expect(res.written.sort()).toEqual(["app/config.txt", "app/server.txt"]);
    expect(res.hostValues).toEqual(["app/config.txt"]);
    expect(readFileSync(join(r.dir, "app/server.txt"), "utf-8")).toBe("hello from the copy\n");
    expect(readFileSync(join(r.dir, "app/config.txt"), "utf-8")).toBe(`domain=${HOST_DOMAIN}\nport=8080\n`);
    expect(res.member).toMatchObject({ name: "out", action: "regenerated" });
    expect(readFileSync(join(r.dir, "out/app/config.txt"), "utf-8")).toBe("domain=copy.example.test\nport=8080\n");
    const ret = parseReturn(readFileSync(join(r.dir, res.returnRecord!), "utf-8"), "return");
    expect(Object.keys(ret.paths).sort()).toEqual(["app/config.txt", "app/server.txt"]);
    // The copy was not a repository of its own, so nothing carries an origin.
    expect(ret.head).toBeNull();
  });

  test("refuses a conflict or a file outside the members that went, and writes nothing", async () => {
    const r = repo("conflict");
    host(r);
    await exportWorkspace({ root: r.dir, params: { domain: "copy.example.test" } });
    r.commit("export");
    writeFileSync(join(r.dir, "out/app/server.txt"), "copy\n");
    writeFileSync(join(r.dir, "app/server.txt"), "host\n");
    const res = await importWorkspace({ root: r.dir });
    expect(res.conflicts.map((c) => c.path)).toEqual(["app/server.txt"]);
    expect(res.applied).toBe(false);
    expect(readFileSync(join(r.dir, "app/server.txt"), "utf-8")).toBe("host\n");

    r.git(["checkout", "--", "app/server.txt"]);
    r.write("out/ops/sneak.txt", "into another member\n");
    const out = await importWorkspace({ root: r.dir });
    expect(out.outside).toEqual(["ops/sneak.txt"]);
    expect(existsSync(join(r.dir, "ops/sneak.txt"))).toBe(false);
  });

  test("--remove removes the export member and its declaration entry", async () => {
    const r = repo("remove");
    host(r);
    await exportWorkspace({ root: r.dir, params: { domain: "copy.example.test" } });
    writeFileSync(join(r.dir, "out/app/server.txt"), "changed\n");
    const res = await importWorkspace({ root: r.dir, remove: true });
    expect(res.member).toMatchObject({ name: "out", action: "removed" });
    expect(existsSync(join(r.dir, "out"))).toBe(false);
    const decl = JSON.parse(readFileSync(join(r.dir, "chant.workspace.json"), "utf-8"));
    expect(decl.members.map((m: { name: string }) => m.name)).toEqual(["app", "ops"]);
  });
});

describe.runIf(hasSshKeygen)("hosted return (#2552)", () => {
  async function records(r: TestRepo): Promise<RecordView[]> {
    const doc = await queryRecords({ kind: "kinds/note.kind.mjs", cwd: r.dir, base: "main" });
    if ("error" in doc) throw new Error(doc.error.message);
    return doc.records;
  }

  test("returned work is unverifiable until an admin admits its signer, and keeps its original signature", async () => {
    const r = repo("hosted");
    const alice = r.key("alice");
    host(r, alice);
    await exportWorkspace({ root: r.dir, params: { domain: "copy.example.test" } });
    r.commit("export", alice);

    // The copy lives in a repository of its own, where bob, whom the host never saw, works.
    const copy = repo("copy");
    const bob = copy.key("bob");
    cpSync(join(r.dir, "out"), copy.dir, { recursive: true });
    const bobEnv = { GIT_COMMITTER_EMAIL: "bob@example.test", GIT_AUTHOR_EMAIL: "bob@example.test" };
    copy.commit("as exported", bob, bobEnv);
    copy.write("records/n-2.md", note("n-2", "made outside"));
    copy.write("app/server.txt", "bob was here\n");
    const made = copy.commit("outside work", bob, bobEnv);

    const res = await importWorkspace({ root: r.dir, from: copy.dir });
    expect(res.conflicts).toEqual([]);
    expect(res.written.sort()).toEqual(["app/server.txt", "records/n-2.md"]);
    const ret = res.return!;
    expect(ret.head).toBe(made);
    expect(ret.paths["records/n-2.md"].origin!.commit).toBe(made);
    expect(ret.signers).toHaveLength(1);
    expect(ret.signers[0]).toMatchObject({ key: bob.pub, principal: "bob@example.test", commits: [made] });
    // The record's bytes are the copy's, and its origin ties them to bob's signed commit.
    const bytes = readFileSync(join(r.dir, "records/n-2.md"));
    expect(bytes.equals(readFileSync(join(copy.dir, "records/n-2.md")))).toBe(true);
    expect(verifyOrigin(ret.paths["records/n-2.md"].origin!, "records/n-2.md", bytes)).toEqual({ ok: true });
    expect(verifyOrigin(ret.paths["records/n-2.md"].origin!, "records/n-2.md", Buffer.from("forged\n")).ok).toBe(false);

    r.commit("import", alice);
    let rs = await records(r);
    const n2 = rs.find((x) => x.id === "n-2")!;
    expect(n2.provenance.level).toBe("attested-unverifiable-here");
    expect(n2.provenance.returned).toMatchObject({ id: ret.id, commit: made });
    expect(n2.provenance.reason).toContain(`chant workspace admit ${ret.id}`);
    // The host's own record is still judged by the host's own commit.
    expect(rs.find((x) => x.id === "n-1")!.provenance).toMatchObject({ level: "attested", principal: "alice@example.test" });

    // An admin admits bob for this return; it counts once merged at base.
    const admitted = admitReturn(r.dir, ret, { note: "returned from the copy" });
    expect(admitted.added).toEqual([{ principal: "bob@example.test", key: bob.pub }]);
    r.commit("admit", alice);
    rs = await records(r);
    expect(rs.find((x) => x.id === "n-2")!.provenance).toMatchObject({ level: "attested", principal: "bob@example.test", returned: { id: ret.id } });
    // The admitted key never vouches for a commit made here.
    r.write("records/n-3.md", note("n-3"));
    r.commit("bob signs here", bob);
    rs = await records(r);
    expect(rs.find((x) => x.id === "n-3")!.provenance.level).toBe("unattested");
  });

  test("an origin is only built for bytes the commit holds", () => {
    const copy = repo("origin");
    copy.write("a/b.txt", "one\n");
    copy.commit("one");
    expect(buildOrigin(copy.dir, "a/b.txt", Buffer.from("one\n"))).toBeDefined();
    copy.write("a/b.txt", "two\n");
    expect(buildOrigin(copy.dir, "a/b.txt", Buffer.from("two\n"))).toBeUndefined();
  });

  test("a returned seal by a signer nobody admitted is unverifiable, and verifies once admitted", () => {
    const r = repo("seal");
    const alice = r.key("alice");
    const bob = r.key("bob");
    const seal = sealRecord(bob.file, { record: "n-2", digest: "d".repeat(64), author: "bob", state: "closed" });
    const policy = { ...emptyPolicy("x".repeat(40)), active: true, signers: [{ principal: "alice", key: alice.pub, line: 1 }] };
    const subject = { record: "n-2", digest: "d".repeat(64), author: "bob", authorField: "decided_by", state: "closed", seal };
    expect(checkRecordSeal(policy, subject)).toMatchObject({ attested: false, code: "seal-signer-unlisted" });
    expect(checkRecordSeal(returnedPolicy(policy, "ret-0123456789ab"), subject)).toMatchObject({ attested: null, code: "seal-unverifiable" });
    const admittedPolicy = { ...policy, admitted: { "ret-0123456789ab": [{ principal: "bob", key: bob.pub, line: 0 }] } };
    expect(checkRecordSeal(returnedPolicy(admittedPolicy, "ret-0123456789ab"), subject)).toMatchObject({ attested: true });
  });
});
