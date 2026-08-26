import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSnapshot,
  readSnapshot,
  readSnapshotAt,
  readEnvironmentSnapshots,
  listSnapshots,
  getHeadCommit,
  pushLifecycle,
  StaleLifecycleBranchError,
  appendReleaseRecordLine,
  readReleaseLedgerLines,
  listLedgerEnvironments,
  writeBlobToPath,
  readBlobFromPath,
  listFilesInDir,
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

  test("readSnapshotAt reads a snapshot at a historical orphan-branch commit (#822)", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await writeSnapshot("prod", "aws", JSON.stringify({ resources: { vpc: { type: "T", status: "OK" } } }), { cwd: dir });
      await writeSnapshot("prod", "aws", JSON.stringify({ resources: { vpc: { type: "T", status: "OK" }, subnet: { type: "S", status: "OK" } } }), { cwd: dir });
      const snaps = await listSnapshots({ cwd: dir }); // newest-first
      expect(snaps.length).toBeGreaterThanOrEqual(2);
      const older = await readSnapshotAt("prod", "aws", snaps[1].commit, { cwd: dir });
      const newer = await readSnapshotAt("prod", "aws", snaps[0].commit, { cwd: dir });
      expect(Object.keys(JSON.parse(older!).resources)).toEqual(["vpc"]);
      expect(Object.keys(JSON.parse(newer!).resources).sort()).toEqual(["subnet", "vpc"]);
      expect(await readSnapshotAt("prod", "gcp", snaps[0].commit, { cwd: dir })).toBeNull();
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

  // ── Generic blob helpers used by ./build-ledger-store.ts (#609) ────────────

  describe("writeBlobToPath / readBlobFromPath / listFilesInDir (generic, non-env namespaces)", () => {
    test("writes/reads a blob under an arbitrary top-level directory, not just an env", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const sha = await writeBlobToPath("_builds", "sha256_abc.json", '{"a":1}', "Build manifest", { cwd: dir });
        expect(sha).toMatch(/^[0-9a-f]{40}$/);

        const out = await readBlobFromPath("_builds", "sha256_abc.json", { cwd: dir });
        expect(JSON.parse(out!)).toEqual({ a: 1 });
      });
    });

    test("readBlobFromPath returns null for a missing directory/file", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await readBlobFromPath("_builds", "missing.json", { cwd: dir })).toBeNull();
      });
    });

    test("listFilesInDir lists every file directly under a directory", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await writeBlobToPath("_builds", "a.json", "{}", "m", { cwd: dir });
        await writeBlobToPath("_builds", "b.json", "{}", "m", { cwd: dir });
        const files = await listFilesInDir("_builds", { cwd: dir });
        expect(files.sort()).toEqual(["a.json", "b.json"]);
      });
    });

    test("listFilesInDir returns empty for a directory that doesn't exist yet", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await listFilesInDir("_builds", { cwd: dir })).toEqual([]);
      });
    });

    test("a non-env top-level directory (_builds) coexists with per-env snapshot/release directories", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await writeSnapshot("prod", "aws", JSON.stringify({ a: 1 }), { cwd: dir });
        await writeBlobToPath("_builds", "sha256_abc.json", '{"b":2}', "Build manifest", { cwd: dir });

        expect(await readSnapshot("prod", "aws", { cwd: dir })).toBeTruthy();
        const out = await readBlobFromPath("_builds", "sha256_abc.json", { cwd: dir });
        expect(JSON.parse(out!)).toEqual({ b: 2 });
      });
    });
  });

  // ── Backslash-escape content round-trips byte-identical (#1936) ────────────
  //
  // writeBlobToPath used to shell out to `sh -c "echo '<content>' | git
  // hash-object -w --stdin"`. sh's `echo` reinterprets backslash-escape
  // sequences (`\n`, `\t`, `\\`, ...) in single-quoted content, so any content
  // embedding a literal two-character `\n` (as opposed to an actual newline
  // byte) — e.g. a serialized `kubectl.kubernetes.io/last-applied-configuration`
  // annotation, which is itself JSON whose string values are JSON-escaped —
  // got silently corrupted in the stored blob. Content is now written
  // directly to spawn's stdin, with no shell in the loop.
  describe("writeBlobToPath preserves literal backslash-escape sequences (#1936)", () => {
    test("literal \\n, \\t, \\\\ two-character sequences survive the write/read round trip", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const content = String.raw`before\nmiddle\ttab\\backslash\nafter`;
        await writeBlobToPath("prod", "raw.txt", content, "raw content", { cwd: dir });
        const out = await readBlobFromPath("prod", "raw.txt", { cwd: dir });
        expect(out).toBe(content);
      });
    });

    test("single quotes combined with backslash sequences survive the round trip", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const content = String.raw`it's a \path\to\thing with 'nested' quotes and \n \t escapes`;
        await writeBlobToPath("prod", "mixed.txt", content, "mixed content", { cwd: dir });
        const out = await readBlobFromPath("prod", "mixed.txt", { cwd: dir });
        expect(out).toBe(content);
      });
    });

    test("a realistic last-applied-configuration-style JSON payload survives byte-identical", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        // The annotation value is itself JSON-serialized, so a multi-line
        // shell script embedded in the manifest shows up as literal `\n`
        // and `\t` two-character sequences in the annotation string — the
        // exact shape that `sh`'s `echo` used to mangle.
        const innerManifest = {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "test-cm", namespace: "default" },
          data: { "init.sh": "#!/bin/sh\necho 'hello world'\ncd /tmp\n\techo done" },
        };
        const manifest = {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name: "test-cm",
            namespace: "default",
            annotations: {
              "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify(innerManifest),
            },
          },
        };
        const content = JSON.stringify(manifest);
        // Sanity-check the fixture actually contains literal backslash-n /
        // backslash-t sequences (the corruption trigger), not real newlines.
        expect(content).toContain("\\n");
        expect(content).toContain("\\t");

        const sha = await writeBlobToPath("prod", "annotation.json", content, "annotated manifest", { cwd: dir });
        expect(sha).toMatch(/^[0-9a-f]{40}$/);

        const out = await readBlobFromPath("prod", "annotation.json", { cwd: dir });
        expect(out).toBe(content);
        expect(JSON.parse(out!)).toEqual(manifest);

        // Cross-check via git plumbing directly (not just the readBlobFromPath
        // helper), to rule out corruption in the stored blob itself.
        const catFile = git(["cat-file", "-p", `chant/lifecycle:prod/annotation.json`], dir);
        expect(catFile.exitCode).toBe(0);
        expect(catFile.stdout).toBe(content);
      });
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
    // These land in the OS temp dir, never under `import.meta.dirname` — that
    // would put live git repos inside `packages/core/src`, which other suites
    // walk recursively while this one creates and deletes them (update.test.ts
    // -> copyTypeFiles hit ENOENT mid-walk that way).
    const remotePath = join(tmpdir(), `chant-state-remote-${Date.now()}-${Math.random()}`);
    const clonePath = join(tmpdir(), `chant-state-clone-${Date.now()}-${Math.random()}`);
    const { mkdir, rm } = await import("node:fs/promises");
    await mkdir(remotePath, { recursive: true });
    git(["init", "-q", "--bare", "-b", "main"], remotePath);
    git(["clone", "-q", remotePath, clonePath], tmpdir());
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
    const cloneB = join(tmpdir(), `chant-state-clone-b-${Date.now()}-${Math.random()}`);
    try {
      git(["clone", "-q", remotePath, cloneB], tmpdir());
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

  // ── Release ledger plumbing (#568) ──────────────────────────────────────

  describe("release ledger plumbing", () => {
    test("appendReleaseRecordLine creates the orphan branch and is readable via readReleaseLedgerLines", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const sha = await appendReleaseRecordLine("prod", '{"v":1}', { cwd: dir });
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        const lines = await readReleaseLedgerLines("prod", { cwd: dir });
        expect(lines).toEqual(['{"v":1}']);
      });
    });

    test("readReleaseLedgerLines returns [] for an environment with no ledger", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await readReleaseLedgerLines("prod", { cwd: dir })).toEqual([]);
      });
    });

    test("appendReleaseRecordLine appends rather than overwrites", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await appendReleaseRecordLine("prod", '{"v":1}', { cwd: dir });
        await appendReleaseRecordLine("prod", '{"v":2}', { cwd: dir });
        await appendReleaseRecordLine("prod", '{"v":3}', { cwd: dir });
        expect(await readReleaseLedgerLines("prod", { cwd: dir })).toEqual(['{"v":1}', '{"v":2}', '{"v":3}']);
      });
    });

    test("release ledger and snapshot files coexist under the same env directory", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await writeSnapshot("prod", "aws", JSON.stringify({ a: 1 }), { cwd: dir });
        await appendReleaseRecordLine("prod", '{"v":1}', { cwd: dir });
        // Both must survive — the release ledger uses a different filename
        // ("releases.jsonl") than any lexicon snapshot ("<lexicon>.json").
        expect(await readSnapshot("prod", "aws", { cwd: dir })).toBeTruthy();
        expect(await readReleaseLedgerLines("prod", { cwd: dir })).toEqual(['{"v":1}']);
      });
    });

    test("listLedgerEnvironments finds every env with a release ledger, ignoring envs that only have snapshots", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await writeSnapshot("dev", "aws", JSON.stringify({ a: 1 }), { cwd: dir }); // snapshot only, no ledger
        await appendReleaseRecordLine("staging", '{"v":1}', { cwd: dir });
        await appendReleaseRecordLine("prod", '{"v":1}', { cwd: dir });

        expect(await listLedgerEnvironments({ cwd: dir })).toEqual(["prod", "staging"]);
      });
    });

    test("listLedgerEnvironments returns [] when the orphan branch doesn't exist yet", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await listLedgerEnvironments({ cwd: dir })).toEqual([]);
      });
    });
  });
});
