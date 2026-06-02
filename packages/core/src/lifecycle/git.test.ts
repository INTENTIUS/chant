import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  writeSnapshot,
  readSnapshot,
  readEnvironmentSnapshots,
  listSnapshots,
  getHeadCommit,
  pushLifecycle,
  StaleLifecycleBranchError,
} from "./git";

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  // Need at least one commit so HEAD exists.
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

describe("lifecycle/git", () => {
  test("writeSnapshot creates the orphan branch and writes JSON addressable by readSnapshot", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const json = JSON.stringify({ resources: { bucket: { type: "T", status: "OK" } } });
      const sha = await writeSnapshot("prod", "aws", json, { cwd: dir });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      const out = await readSnapshot("prod", "aws", { cwd: dir });
      expect(out).not.toBeNull();
      expect(JSON.parse(out!)).toEqual(JSON.parse(json));
    });
  });

  test("readSnapshot returns null for missing env/lexicon", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const out = await readSnapshot("prod", "aws", { cwd: dir });
      expect(out).toBeNull();
    });
  });

  test("subsequent writes preserve other env+lexicon entries", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeSnapshot("prod", "aws", JSON.stringify({ a: 1 }), { cwd: dir });
      await writeSnapshot("prod", "gcp", JSON.stringify({ b: 2 }), { cwd: dir });
      await writeSnapshot("staging", "aws", JSON.stringify({ c: 3 }), { cwd: dir });

      expect(await readSnapshot("prod", "aws", { cwd: dir })).toBeTruthy();
      expect(await readSnapshot("prod", "gcp", { cwd: dir })).toBeTruthy();
      expect(await readSnapshot("staging", "aws", { cwd: dir })).toBeTruthy();
    });
  });

  test("re-writing the same env+lexicon updates the entry rather than duplicating", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeSnapshot("prod", "aws", JSON.stringify({ v: 1 }), { cwd: dir });
      await writeSnapshot("prod", "aws", JSON.stringify({ v: 2 }), { cwd: dir });
      const out = await readSnapshot("prod", "aws", { cwd: dir });
      expect(JSON.parse(out!)).toEqual({ v: 2 });
    });
  });

  test("readEnvironmentSnapshots returns all lexicons for an env", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeSnapshot("prod", "aws", JSON.stringify({ a: 1 }), { cwd: dir });
      await writeSnapshot("prod", "gcp", JSON.stringify({ b: 2 }), { cwd: dir });
      const all = await readEnvironmentSnapshots("prod", { cwd: dir });
      expect([...all.keys()].sort()).toEqual(["aws", "gcp"]);
    });
  });

  test("listSnapshots returns commit history of the orphan branch", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeSnapshot("prod", "aws", JSON.stringify({ v: 1 }), { cwd: dir });
      await writeSnapshot("prod", "aws", JSON.stringify({ v: 2 }), { cwd: dir });
      const log = await listSnapshots({ cwd: dir });
      expect(log.length).toBe(2);
      expect(log[0].commit).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  test("getHeadCommit returns the working-branch HEAD sha", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const head = await getHeadCommit({ cwd: dir });
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  // ── Concurrent push rejection (#30) ─────────────────────────────────────────

  /**
   * Build a "remote ↔ clone" pair where `clone` has `remote` configured as
   * `origin`. Returns the clone path; the caller writes snapshots there.
   */
  async function setupClonePair(): Promise<{ clonePath: string; remotePath: string; cleanup: () => Promise<void> }> {
    const remotePath = join(import.meta.dirname ?? "/tmp", `chant-state-remote-${Date.now()}-${Math.random()}`);
    const clonePath = join(import.meta.dirname ?? "/tmp", `chant-state-clone-${Date.now()}-${Math.random()}`);
    const { mkdir, rm } = await import("node:fs/promises");
    await mkdir(remotePath, { recursive: true });
    git(["init", "-q", "--bare", "-b", "main"], remotePath);
    git(["clone", "-q", remotePath, clonePath], import.meta.dirname ?? "/tmp");
    git(["config", "user.email", "test@chant.dev"], clonePath);
    git(["config", "user.name", "Test"], clonePath);
    writeFileSync(join(clonePath, "README.md"), "fixture\n");
    git(["add", "README.md"], clonePath);
    git(["commit", "-q", "-m", "init"], clonePath);
    git(["push", "-q", "origin", "main"], clonePath);
    return {
      clonePath,
      remotePath,
      cleanup: async () => {
        await rm(remotePath, { recursive: true, force: true });
        await rm(clonePath, { recursive: true, force: true });
      },
    };
  }

  test("first push to remote succeeds (no remote ref yet)", async () => {
    const { clonePath, cleanup } = await setupClonePair();
    try {
      await writeSnapshot("prod", "aws", JSON.stringify({ a: 1 }), { cwd: clonePath });
      const ok = await pushLifecycle({ cwd: clonePath });
      expect(ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("subsequent push from same clone (after fetch) succeeds via lease", async () => {
    const { clonePath, cleanup } = await setupClonePair();
    try {
      await writeSnapshot("prod", "aws", JSON.stringify({ a: 1 }), { cwd: clonePath });
      expect(await pushLifecycle({ cwd: clonePath })).toBe(true);

      // Pull the remote ref into local remote-tracking, then commit + push again
      git(["fetch", "-q", "origin", "+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle"], clonePath);
      await writeSnapshot("prod", "aws", JSON.stringify({ a: 2 }), { cwd: clonePath });
      expect(await pushLifecycle({ cwd: clonePath })).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("concurrent write rejected: second push throws StaleLifecycleBranchError", async () => {
    // Simulate two concurrent operators by setting up two clones of the same remote.
    const { clonePath: cloneA, remotePath, cleanup } = await setupClonePair();
    const cloneB = join(import.meta.dirname ?? "/tmp", `chant-state-clone-b-${Date.now()}-${Math.random()}`);
    try {
      git(["clone", "-q", remotePath, cloneB], import.meta.dirname ?? "/tmp");
      git(["config", "user.email", "test@chant.dev"], cloneB);
      git(["config", "user.name", "Test"], cloneB);

      // Operator A writes + pushes first.
      await writeSnapshot("prod", "aws", JSON.stringify({ a: 1 }), { cwd: cloneA });
      expect(await pushLifecycle({ cwd: cloneA })).toBe(true);

      // Operator B writes from the same baseline (chant/lifecycle doesn't exist
      // on cloneB's remote-tracking yet) and tries to push — should fail
      // with StaleLifecycleBranchError because A's push moved the remote ref.
      await writeSnapshot("staging", "gcp", JSON.stringify({ b: 2 }), { cwd: cloneB });
      await expect(pushLifecycle({ cwd: cloneB })).rejects.toBeInstanceOf(StaleLifecycleBranchError);
    } finally {
      await cleanup();
      const { rm } = await import("node:fs/promises");
      await rm(cloneB, { recursive: true, force: true });
    }
  });

  test("StaleLifecycleBranchError carries the expected SHA used as the lease", async () => {
    const err = new StaleLifecycleBranchError(null, "stale info: ...");
    expect(err.name).toBe("StaleLifecycleBranchError");
    expect(err.expected).toBeNull();
    expect(err.message).toContain("moved");
  });
});
