/**
 * #3172 — work in progress under refs/chant/wip/<branch>: snapshots that
 * leave the index and the branch alone, restore that checkpoints first, and
 * replication to a remote under the box's policy, down to a box that is lost
 * and replaced.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parseDeclaration } from "./declaration";
import { cleanScratch, commitAll, contract, declaration, git, repo, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { readReplicatePolicy, replicaRef, replicationState, wipFetch, wipPush, wipRestore, wipSave, workspaceWip, type WipWriteDocument } from "./wip";
import wipSchema from "./wip.schema.json";
import wipWriteSchema from "./wip-write.schema.json";
import statusSchema from "./status.schema.json";
import { workspaceStatus } from "./status";

afterAll(cleanScratch);

const read = contract(wipSchema);
const write = contract(wipWriteSchema);

function ok<A extends string>(doc: WipWriteDocument, action: A): Extract<WipWriteDocument, { action: A; branch?: unknown }> & Record<string, unknown> {
  write.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  expect(doc.action).toBe(action);
  return doc as never;
}

function refused(doc: WipWriteDocument): string {
  write.expectValid(doc);
  if (!("error" in doc)) throw new Error(`expected a refusal, got ${JSON.stringify(doc)}`);
  return doc.error.code;
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A workspace on branch chant/work/W-001 with one committed file. */
function box(extraDecl: Record<string, unknown> = {}, replicate?: Record<string, unknown>): string {
  const root = repo({
    "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app", box: replicate === undefined ? {} : { replicate } }], extraDecl),
    "app/server.mjs": "export const port = 8080;\n",
    ".gitignore": "node_modules/\n",
  });
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  commitAll(root, "the app");
  git(root, "checkout", "-q", "-b", "chant/work/W-001");
  return root;
}

describe("the replicate policy on the box block (#3172)", () => {
  const decl = (box: unknown, more: unknown[] = []) => JSON.stringify({ name: "w", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "x", box }, ...more] });

  test("parses with every default filled in, in the closed lists' order", () => {
    expect(parseDeclaration(decl({ replicate: {} }), "chant.workspace.json").members[0].box!.replicate).toEqual({
      remote: "origin",
      refs: ["work", "kept", "wip", "ledger"],
      on: ["save", "release"],
      every: null,
      pointer: "/members/0/box/replicate",
    });
    expect(parseDeclaration(decl({ replicate: { remote: "mirror", refs: ["wip", "kept"], on: [], every: "10m" } }), "chant.workspace.json").members[0].box!.replicate).toMatchObject({
      remote: "mirror",
      refs: ["kept", "wip"],
      on: [],
      every: "10m",
    });
    expect(parseDeclaration(decl({}), "chant.workspace.json").members[0].box!.replicate).toBeNull();
  });

  test("a workspace has one policy, and the schema refuses what it doesn't know", () => {
    const two = decl({ replicate: {} }, [{ name: "b", dir: "b", kind: "other", because: "x", box: { replicate: {} } }]);
    expect(() => parseDeclaration(two, "chant.workspace.json")).toThrow(/both declare replicate/);
    expect(() => parseDeclaration(decl({ replicate: { refs: ["everything"] } }), "chant.workspace.json")).toThrow();
    expect(() => parseDeclaration(decl({ replicate: { on: ["write"] } }), "chant.workspace.json")).toThrow();
    expect(() => parseDeclaration(decl({ replicate: { every: "soon" } }), "chant.workspace.json")).toThrow();
    expect(() => parseDeclaration(decl({ replicate: { remote: "https://example.com/x.git" } }), "chant.workspace.json")).toThrow();
  });
});

describe("wip save (#3172)", () => {
  test("snapshots staged, unstaged and untracked files without touching the index, HEAD or the branch", () => {
    const root = box();
    writeFiles(root, { "app/server.mjs": "export const port = 9090;\n", "app/staged.mjs": "staged\n", "decisions/fix-001.md": "uncommitted record\n", "node_modules/x.js": "ignored\n" });
    git(root, "add", "app/staged.mjs");
    const index = sha(join(root, ".git", "index"));
    const head = git(root, "rev-parse", "HEAD");
    const statusBefore = git(root, "status", "--porcelain");

    const doc = ok(wipSave({ cwd: root, label: "turn:1", by: "github:alex" }), "save");
    expect(doc).toMatchObject({ branch: "chant/work/W-001", ref: "refs/chant/wip/chant/work/W-001", created: true, replication: null });
    expect(doc.snapshot).toMatchObject({ branch: "chant/work/W-001", head, kind: "save", label: "turn:1", by: "github:alex" });
    expect(sha(join(root, ".git", "index"))).toBe(index);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "status", "--porcelain")).toBe(statusBefore);
    const files = git(root, "ls-tree", "-r", "--name-only", doc.snapshot.commit).split("\n");
    expect(files).toEqual(expect.arrayContaining(["app/server.mjs", "app/staged.mjs", "decisions/fix-001.md"]));
    expect(files).not.toContain("node_modules/x.js");
    expect(git(root, "show", `${doc.snapshot.commit}:app/server.mjs`)).toBe("export const port = 9090;");
    // The snapshot's last parent is HEAD, so pushing the ref carries the branch's commits.
    expect(git(root, "rev-parse", `${doc.snapshot.commit}^1`)).toBe(head);
  });

  test("the same tree, head, label and principal take no new snapshot; anything else chains onto the last", () => {
    const root = box();
    writeFiles(root, { "a.txt": "1\n" });
    const first = ok(wipSave({ cwd: root }), "save");
    const again = ok(wipSave({ cwd: root }), "save");
    expect(again.created).toBe(false);
    expect(again.snapshot.commit).toBe(first.snapshot.commit);
    const labelled = ok(wipSave({ cwd: root, label: "turn:2" }), "save");
    expect(labelled.created).toBe(true);
    writeFiles(root, { "a.txt": "2\n" });
    const third = ok(wipSave({ cwd: root, label: "turn:3" }), "save");
    expect(git(root, "rev-parse", `${third.snapshot.commit}^1`)).toBe(labelled.snapshot.commit);

    const list = workspaceWip({ cwd: root });
    read.expectValid(list);
    if ("error" in list) throw new Error(list.error.message);
    expect(list.checkout.branch).toBe("chant/work/W-001");
    expect(list.branches).toHaveLength(1);
    expect(list.branches[0].tip).toBe(third.snapshot.commit);
    expect(list.branches[0].snapshots.map((s) => s.label)).toEqual(["turn:3", "turn:2", null]);
    expect(list.replication).toBeNull();
    expect(workspaceWip({ cwd: root, branch: "other" })).toMatchObject({ branches: [] });
  });

  test("refuses a detached HEAD, a branch with no commit and a label that isn't one line", () => {
    const root = box();
    git(root, "checkout", "-q", "--detach");
    expect(refused(wipSave({ cwd: root }))).toBe("wip-no-branch");
    const empty = repo({ "x.txt": "x\n" });
    expect(refused(wipSave({ cwd: empty }))).toBe("wip-no-branch");
    git(root, "checkout", "-q", "chant/work/W-001");
    expect(refused(wipSave({ cwd: root, label: "two\nlines" }))).toBe("write-usage-invalid");
    expect(refused(wipSave({ cwd: scratchDir() }))).toBe("not-a-git-repository");
  });

  test("--by is held to the identity rule at base (ws-080)", () => {
    const root = box({ identity: { attribution: "identified" } });
    expect(refused(wipSave({ cwd: root, by: "alex" }))).toBe("principal-unidentified");
    ok(wipSave({ cwd: root, by: "github:alex" }), "save");
  });
});

describe("wip restore (#3172)", () => {
  test("puts the working tree back exactly, after a checkpoint of how it was, and the checkpoint undoes it", () => {
    const root = box();
    writeFiles(root, { "app/server.mjs": "export const port = 1;\n", "decisions/fix-001.md": "kept\n" });
    const saved = ok(wipSave({ cwd: root, label: "turn:1" }), "save");
    // The next turn breaks things: edits, deletes the record, adds a file, stages one.
    writeFiles(root, { "app/server.mjs": "broken\n", "junk.txt": "junk\n" });
    rmSync(join(root, "decisions/fix-001.md"));
    git(root, "add", "junk.txt");

    const doc = ok(wipRestore({ cwd: root, snapshot: saved.snapshot.commit }), "restore");
    expect(doc.paths).toEqual(["app/server.mjs", "decisions/fix-001.md", "junk.txt"]);
    expect(doc.headMoved).toBe(false);
    expect(doc.checkpoint.created).toBe(true);
    expect(doc.checkpoint.snapshot).toMatchObject({ kind: "pre-restore", label: `before ${saved.snapshot.commit.slice(0, 12)}` });
    expect(readFileSync(join(root, "app/server.mjs"), "utf-8")).toBe("export const port = 1;\n");
    expect(readFileSync(join(root, "decisions/fix-001.md"), "utf-8")).toBe("kept\n");
    expect(existsSync(join(root, "junk.txt"))).toBe(false);
    // The index is HEAD's: everything restored reads as uncommitted.
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");

    const undo = ok(wipRestore({ cwd: root, snapshot: doc.checkpoint.snapshot.commit }), "restore");
    expect(undo.paths).toEqual(["app/server.mjs", "decisions/fix-001.md", "junk.txt"]);
    expect(readFileSync(join(root, "app/server.mjs"), "utf-8")).toBe("broken\n");
    expect(existsSync(join(root, "decisions/fix-001.md"))).toBe(false);
  });

  test("restores the branch's latest by default, over a HEAD that has moved on, and refuses what it can't", () => {
    const root = box();
    expect(refused(wipRestore({ cwd: root }))).toBe("wip-none");
    writeFiles(root, { "a.txt": "a\n" });
    const saved = ok(wipSave({ cwd: root }), "save");
    commitAll(root, "a commit after the snapshot");
    writeFiles(root, { "a.txt": "changed\n" });
    const doc = ok(wipRestore({ cwd: root }), "restore");
    expect(doc.snapshot.commit).toBe(saved.snapshot.commit);
    expect(doc.headMoved).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("a\n");

    expect(refused(wipRestore({ cwd: root, snapshot: "HEAD" }))).toBe("wip-snapshot-unknown");
    expect(refused(wipRestore({ cwd: root, snapshot: "no-such-rev" }))).toBe("wip-snapshot-unknown");
    git(root, "checkout", "-q", "-b", "chant/work/W-002");
    expect(refused(wipRestore({ cwd: root, snapshot: saved.snapshot.commit }))).toBe("wip-branch-other");
  });
});

describe("replication (#3172)", () => {
  /** A bare remote, and a box cloned from it with the policy declared. */
  function boxWithRemote(replicate: Record<string, unknown> = {}): { remote: string; root: string } {
    const remote = scratchDir("chant-wip-remote-");
    git(remote, "init", "-q", "--bare");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    const root = box({}, replicate);
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "origin", "main", "chant/work/W-001");
    return { remote, root };
  }

  test("save pushes the snapshot, the work branch, kept attempts and the ledger, never forced, and status reports where each stands", async () => {
    const { remote, root } = boxWithRemote();
    expect(readReplicatePolicy(root)).toEqual({ box: "app", remote: "origin", refs: ["work", "kept", "wip", "ledger"], on: ["save", "release"], every: null });
    writeFiles(root, { "app/more.mjs": "more\n" });
    commitAll(root, "unpushed work");
    git(root, "update-ref", "refs/chant/kept/W-001/tok-1", "HEAD");
    git(root, "branch", "chant/lifecycle");
    writeFiles(root, { "decisions/fix-001.md": "uncommitted record\n" });

    const before = replicationState(root, readReplicatePolicy(root)!);
    expect(before.replicated).toBe(false);
    expect(before.refs.find((r) => r.ref === "refs/heads/chant/work/W-001")).toMatchObject({ replicated: false, ahead: 1 });

    const doc = ok(wipSave({ cwd: root, label: "turn:1" }), "save");
    expect(doc.replication?.rejected).toEqual([]);
    expect(doc.replication?.pushed.map((p) => p.ref).sort()).toEqual([
      "refs/chant/kept/W-001/tok-1",
      "refs/chant/wip/chant/work/W-001",
      "refs/heads/chant/lifecycle",
      "refs/heads/chant/work/W-001",
    ]);
    expect(git(remote, "rev-parse", "refs/chant/wip/chant/work/W-001")).toBe(doc.snapshot.commit);
    expect(git(root, "rev-parse", replicaRef("origin", "refs/chant/wip/chant/work/W-001"))).toBe(doc.snapshot.commit);

    const status = await workspaceStatus({ cwd: root, env: "dev" });
    contract(statusSchema).expectValid(status);
    if ("error" in status) throw new Error(status.error.message);
    expect(status.replication).toMatchObject({ remoteConfigured: true, replicated: true });
    expect(status.members[0].box?.replicate).toEqual({ remote: "origin", refs: ["work", "kept", "wip", "ledger"], on: ["save", "release"], every: null });

    // A push that would rewrite the remote is refused, never forced.
    git(root, "update-ref", "refs/chant/kept/W-001/tok-1", "HEAD~1");
    const push = ok(wipPush({ cwd: root }), "push");
    expect(push.replication.rejected.map((r) => r.ref)).toEqual(["refs/chant/kept/W-001/tok-1"]);
    expect(git(remote, "rev-parse", "refs/chant/kept/W-001/tok-1")).toBe(git(root, "rev-parse", "HEAD"));
  });

  test("a policy that leaves save out doesn't push on save; push and fetch need a policy and a remote", () => {
    const { root } = boxWithRemote({ on: ["release"] });
    writeFiles(root, { "a.txt": "a\n" });
    expect(ok(wipSave({ cwd: root }), "save").replication).toBeNull();
    const none = box();
    expect(refused(wipPush({ cwd: none }))).toBe("wip-policy-none");
    expect(refused(wipFetch({ cwd: none }))).toBe("wip-policy-none");
    const noRemote = box({}, { remote: "mirror" });
    expect(refused(wipPush({ cwd: noRemote }))).toBe("wip-remote-unknown");
    writeFiles(noRemote, { "a.txt": "a\n" });
    const saved = ok(wipSave({ cwd: noRemote }), "save");
    expect(saved.replication?.pushed).toEqual([]);
    expect(saved.replication?.rejected[0].reason).toMatch(/no git remote named mirror/);
  });

  test("a box lost mid-work: a replacement fetches and restores every uncommitted record and kept attempt", () => {
    const { remote, root } = boxWithRemote();
    writeFiles(root, { "app/half.mjs": "half\n" });
    commitAll(root, "half the work, committed");
    git(root, "update-ref", "refs/chant/kept/W-001/tok-1", "HEAD");
    writeFiles(root, { "decisions/fix-001.md": "a decision, proposed and not committed\n", "app/server.mjs": "export const port = 7070;\n" });
    rmSync(join(root, ".gitignore"));
    const saved = ok(wipSave({ cwd: root, label: "turn:9" }), "save");
    expect(saved.replication?.rejected).toEqual([]);
    rmSync(root, { recursive: true, force: true });

    // A new box: a clone of the remote, on its default branch, whose declaration states the policy.
    const fresh = scratchDir("chant-wip-replacement-");
    git(fresh, "clone", "-q", remote, ".");
    const fetched = ok(wipFetch({ cwd: fresh }), "fetch");
    expect(fetched.failed).toBeNull();
    expect(fetched.refs.map((r) => [r.ref, r.result])).toEqual([
      ["refs/chant/kept/W-001/tok-1", "created"],
      ["refs/chant/wip/chant/work/W-001", "created"],
      ["refs/heads/chant/work/W-001", "created"],
    ]);
    git(fresh, "checkout", "-q", "chant/work/W-001");
    const restored = ok(wipRestore({ cwd: fresh }), "restore");
    expect(restored.snapshot.commit).toBe(saved.snapshot.commit);
    expect(restored.headMoved).toBe(false);
    expect(readFileSync(join(fresh, "decisions/fix-001.md"), "utf-8")).toBe("a decision, proposed and not committed\n");
    expect(readFileSync(join(fresh, "app/server.mjs"), "utf-8")).toBe("export const port = 7070;\n");
    expect(existsSync(join(fresh, ".gitignore"))).toBe(false);
    expect(git(fresh, "rev-parse", "refs/chant/kept/W-001/tok-1")).toBe(git(fresh, "rev-parse", "HEAD"));
    // Fetching again moves nothing: the restore's own checkpoint left the local snapshot ref ahead of the remote's.
    expect(ok(wipFetch({ cwd: fresh }), "fetch").refs.map((r) => [r.ref, r.result])).toEqual([
      ["refs/chant/kept/W-001/tok-1", "up-to-date"],
      ["refs/chant/wip/chant/work/W-001", "ahead"],
      ["refs/heads/chant/work/W-001", "up-to-date"],
    ]);
  });
});
