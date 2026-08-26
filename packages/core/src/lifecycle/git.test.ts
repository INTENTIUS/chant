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
  readRefSha,
  updateRefCAS,
  deleteRefCAS,
  writeBlob,
  readBlobBySha,
  pushRef,
  fetchRef,
  fetchRefInto,
  RefCASConflictError,
  StaleLockError,
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

  // ── Concurrent writers (#1959 finding 1) ────────────────────────────────
  //
  // writeBlobToPath's own CAS-guarded ref update (#1485) closed the silent
  // clobber two concurrent local writers used to hit, but replaced it with
  // an outright throw on ANY conflict — breaking every pre-existing caller
  // that never learned to retry the moment a live `chant operator` (or any
  // other concurrent writer) touched the orphan branch in between. These
  // tests pin the fix: a conflict caused by a DIFFERENT path is absorbed
  // internally (every caller — even ones with no retry logic of their own —
  // is safe); a conflict on the SAME path a read-modify-write caller is
  // writing is NOT blindly retried (that would silently drop data), so it
  // still surfaces for a content-aware caller's own retry to handle.
  describe("writeBlobToPath — concurrent writers on the same branch tip (#1959 finding 1)", () => {
    test("two interleaved writers to DIFFERENT paths both survive with no caller-level retry needed", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        // Seed the branch so both writers race against a real, non-null parent tip.
        await writeBlobToPath("_seed", "seed.json", "{}", "seed", { cwd: dir });

        // Two "callers" that — like writeObservationBaseline/writeSnapshot/
        // persistBuildManifest — pass a self-contained `content`, computed
        // before either write starts, and have NO retry loop of their own.
        const [shaA, shaB] = await Promise.all([
          writeBlobToPath("prod", "baseline.json", '{"owner":"A"}', "A's write", { cwd: dir }),
          writeBlobToPath("staging", "baseline.json", '{"owner":"B"}', "B's write", { cwd: dir }),
        ]);
        expect(shaA).toMatch(/^[0-9a-f]{40}$/);
        expect(shaB).toMatch(/^[0-9a-f]{40}$/);

        // Both landed — neither writer's tree update was lost to the other's race.
        expect(await readBlobFromPath("prod", "baseline.json", { cwd: dir })).toBe('{"owner":"A"}');
        expect(await readBlobFromPath("staging", "baseline.json", { cwd: dir })).toBe('{"owner":"B"}');
      });
    });

    test("a caller with no retry loop still throws RefCASConflictError (not a silent clobber) when TWO writers race the exact same path", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await writeBlobToPath("prod", "solo.json", '{"v":0}', "seed", { cwd: dir });

        // Both writers read the SAME starting content and race to replace it —
        // exactly the scenario a bare (non-retrying) caller cannot safely
        // resolve on its own, since neither knows about the other's write.
        const results = await Promise.allSettled([
          writeBlobToPath("prod", "solo.json", '{"v":"A"}', "A", { cwd: dir }),
          writeBlobToPath("prod", "solo.json", '{"v":"B"}', "B", { cwd: dir }),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");
        // At least one must land; if both raced hard enough that one lost,
        // it must fail loudly as a RefCASConflictError, never silently.
        expect(fulfilled.length).toBeGreaterThanOrEqual(1);
        for (const r of rejected) {
          expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RefCASConflictError);
        }
      });
    });

    test("appendReleaseRecordLine: two interleaved writers appending to the SAME env's ledger both survive (#1959 finding 1)", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const recordA = JSON.stringify({ version: 1, component: "svc-a", digest: "sha256:a" });
        const recordB = JSON.stringify({ version: 1, component: "svc-b", digest: "sha256:b" });

        await Promise.all([
          appendReleaseRecordLine("prod", recordA, { cwd: dir }),
          appendReleaseRecordLine("prod", recordB, { cwd: dir }),
        ]);

        const lines = await readReleaseLedgerLines("prod", { cwd: dir });
        expect(lines).toHaveLength(2);
        expect(lines).toContain(recordA);
        expect(lines).toContain(recordB);
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

  // ── Generic ref CAS (#1485) ────────────────────────────────────────────────

  describe("readRefSha / updateRefCAS / deleteRefCAS / writeBlob / readBlobBySha", () => {
    const REF = "refs/chant/lease/test-op";

    test("readRefSha returns null for a ref that doesn't exist", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await readRefSha(REF, { cwd: dir })).toBeNull();
      });
    });

    test("writeBlob + updateRefCAS(old=null) creates a ref pointing at a bare blob (no tree, no commit)", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const blobSha = await writeBlob('{"holder":"a"}', { cwd: dir });
        await updateRefCAS(REF, blobSha, null, { cwd: dir });

        expect(await readRefSha(REF, { cwd: dir })).toBe(blobSha);
        expect(await readBlobBySha(blobSha, { cwd: dir })).toBe('{"holder":"a"}');
      });
    });

    test("updateRefCAS(old=null) fails if the ref already exists — RefCASConflictError, not a silent overwrite", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const first = await writeBlob('{"holder":"a"}', { cwd: dir });
        await updateRefCAS(REF, first, null, { cwd: dir });

        const second = await writeBlob('{"holder":"b"}', { cwd: dir });
        await expect(updateRefCAS(REF, second, null, { cwd: dir })).rejects.toBeInstanceOf(RefCASConflictError);
        // The first writer's value is untouched.
        expect(await readRefSha(REF, { cwd: dir })).toBe(first);
      });
    });

    test("updateRefCAS succeeds when oldValue matches the ref's current value (a correct renewal)", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const first = await writeBlob('{"holder":"a","expiresAt":"t1"}', { cwd: dir });
        await updateRefCAS(REF, first, null, { cwd: dir });

        const renewed = await writeBlob('{"holder":"a","expiresAt":"t2"}', { cwd: dir });
        await updateRefCAS(REF, renewed, first, { cwd: dir });

        expect(await readRefSha(REF, { cwd: dir })).toBe(renewed);
      });
    });

    test("updateRefCAS fails when oldValue is stale — the exact race writeBlobToPath's own final ref update now guards against", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const first = await writeBlob('{"holder":"a"}', { cwd: dir });
        await updateRefCAS(REF, first, null, { cwd: dir });

        // Simulate a second writer who moved the ref concurrently.
        const interloper = await writeBlob('{"holder":"b"}', { cwd: dir });
        await updateRefCAS(REF, interloper, first, { cwd: dir });

        // The first writer, still holding its stale `first` as `oldValue`,
        // tries to write again — must fail loudly, not clobber `interloper`.
        const staleWrite = await writeBlob('{"holder":"a","stale":true}', { cwd: dir });
        await expect(updateRefCAS(REF, staleWrite, first, { cwd: dir })).rejects.toBeInstanceOf(RefCASConflictError);
        expect(await readRefSha(REF, { cwd: dir })).toBe(interloper);
      });
    });

    test("deleteRefCAS removes the ref only when oldValue matches; a mismatch is a conflict, not a silent no-op", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const sha = await writeBlob('{"holder":"a"}', { cwd: dir });
        await updateRefCAS(REF, sha, null, { cwd: dir });

        const wrongSha = await writeBlob("garbage", { cwd: dir });
        await expect(deleteRefCAS(REF, wrongSha, { cwd: dir })).rejects.toBeInstanceOf(RefCASConflictError);
        expect(await readRefSha(REF, { cwd: dir })).toBe(sha); // untouched

        await deleteRefCAS(REF, sha, { cwd: dir });
        expect(await readRefSha(REF, { cwd: dir })).toBeNull();
      });
    });

    test("readBlobBySha returns null for a sha that was never written", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await readBlobBySha("0".repeat(40), { cwd: dir })).toBeNull();
      });
    });
  });

  // ── Failure classification (#1959 finding 2) ────────────────────────────
  //
  // Before this fix, updateRefCAS/deleteRefCAS turned ANY nonzero git exit
  // into RefCASConflictError. That's wrong for at least two other real
  // failure modes git itself distinguishes: a stale `.lock` file (what a
  // killed process leaves behind — the exact crash this feature must
  // recover from) and an outright bad ref name. These tests pin the
  // corrected classification.
  describe("updateRefCAS / deleteRefCAS — classifying real git failures, not just any nonzero exit (#1959 finding 2)", () => {
    test("a stale .lock file is reported as StaleLockError, never as RefCASConflictError", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const ref = "refs/chant/lease/stale-lock-op";
        const blobSha = await writeBlob('{"holder":"a"}', { cwd: dir });
        await updateRefCAS(ref, blobSha, null, { cwd: dir });

        // Simulate a `chant operator` killed mid-write: git's own
        // lockfile-then-rename never completed, so the `.lock` file it
        // created is still sitting there.
        const { mkdirSync, writeFileSync: write } = await import("node:fs");
        mkdirSync(join(dir, ".git", "refs", "chant", "lease"), { recursive: true });
        write(join(dir, ".git", "refs", "chant", "lease", "stale-lock-op.lock"), "");

        const renewed = await writeBlob('{"holder":"a","renewed":true}', { cwd: dir });
        const err = await updateRefCAS(ref, renewed, blobSha, { cwd: dir }).catch((e) => e);
        expect(err).toBeInstanceOf(StaleLockError);
        expect(err).not.toBeInstanceOf(RefCASConflictError);
        expect((err as StaleLockError).lockPath).toContain("stale-lock-op.lock");
        expect((err as StaleLockError).message).toContain("stale-lock-op.lock");

        // The ref itself is untouched — the write never happened.
        expect(await readRefSha(ref, { cwd: dir })).toBe(blobSha);
      });
    });

    test("deleteRefCAS also reports a stale .lock file as StaleLockError", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const ref = "refs/chant/lease/stale-lock-delete-op";
        const blobSha = await writeBlob('{"holder":"a"}', { cwd: dir });
        await updateRefCAS(ref, blobSha, null, { cwd: dir });

        const { mkdirSync, writeFileSync: write } = await import("node:fs");
        mkdirSync(join(dir, ".git", "refs", "chant", "lease"), { recursive: true });
        write(join(dir, ".git", "refs", "chant", "lease", "stale-lock-delete-op.lock"), "");

        const err = await deleteRefCAS(ref, blobSha, { cwd: dir }).catch((e) => e);
        expect(err).toBeInstanceOf(StaleLockError);
        expect(err).not.toBeInstanceOf(RefCASConflictError);
      });
    });

    test("a genuine value mismatch is still RefCASConflictError (no lock file involved)", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const ref = "refs/chant/lease/mismatch-op";
        const first = await writeBlob('{"holder":"a"}', { cwd: dir });
        await updateRefCAS(ref, first, null, { cwd: dir });
        const interloper = await writeBlob('{"holder":"b"}', { cwd: dir });
        await updateRefCAS(ref, interloper, first, { cwd: dir });

        const staleWrite = await writeBlob('{"holder":"a","stale":true}', { cwd: dir });
        const err = await updateRefCAS(ref, staleWrite, first, { cwd: dir }).catch((e) => e);
        expect(err).toBeInstanceOf(RefCASConflictError);
        expect(err).not.toBeInstanceOf(StaleLockError);
      });
    });

    test("a bad ref name is a plain Error, not RefCASConflictError or StaleLockError — the ref's value never actually diverged from oldValue", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const badRef = "refs/chant/lease/bad..name";
        const blobSha = await writeBlob('{"holder":"a"}', { cwd: dir });

        const err = await updateRefCAS(badRef, blobSha, null, { cwd: dir }).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(RefCASConflictError);
        expect(err).not.toBeInstanceOf(StaleLockError);
      });
    });
  });

  describe("pushRef / fetchRef — a lease ref survives a round trip through a shared remote", () => {
    test("pushRef pushes a non-branch ref; a second clone sees it via fetchRef", async () => {
      const { clonePath: cloneA, remotePath, cleanup } = await setupClonePair();
      const cloneB = join(tmpdir(), `chant-lease-clone-b-${Date.now()}-${Math.random()}`);
      try {
        git(["clone", "-q", remotePath, cloneB], tmpdir());

        const ref = "refs/chant/lease/fountain-converge";
        const blobSha = await writeBlob('{"holder":"a","token":"t1"}', { cwd: cloneA });
        await updateRefCAS(ref, blobSha, null, { cwd: cloneA });
        expect(await pushRef(ref, { cwd: cloneA })).toBe(true);

        expect(await fetchRef(ref, { cwd: cloneB })).toBe(true);
        expect(await readRefSha(ref, { cwd: cloneB })).toBe(blobSha);
        expect(await readBlobBySha(blobSha, { cwd: cloneB })).toBe('{"holder":"a","token":"t1"}');
      } finally {
        await cleanup();
        const { rm } = await import("node:fs/promises");
        await rm(cloneB, { recursive: true, force: true });
      }
    });

    test("pushRef / fetchRef return false (never throw) when no remote is configured", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const ref = "refs/chant/lease/local-only";
        const blobSha = await writeBlob('{"holder":"a"}', { cwd: dir });
        await updateRefCAS(ref, blobSha, null, { cwd: dir });
        expect(await pushRef(ref, { cwd: dir })).toBe(false);
        expect(await fetchRef(ref, { cwd: dir })).toBe(false);
      });
    });

    test("fetchRefInto lands the remote's value under a DIFFERENT local ref name, leaving the same-named local ref (if any) untouched (#1959 finding 3)", async () => {
      const { clonePath: cloneA, remotePath, cleanup } = await setupClonePair();
      const cloneB = join(tmpdir(), `chant-lease-clone-b-${Date.now()}-${Math.random()}`);
      try {
        git(["clone", "-q", remotePath, cloneB], tmpdir());

        const ref = "refs/chant/lease/fountain-converge";
        const remoteBlobSha = await writeBlob('{"holder":"a","token":"t1"}', { cwd: cloneA });
        await updateRefCAS(ref, remoteBlobSha, null, { cwd: cloneA });
        expect(await pushRef(ref, { cwd: cloneA })).toBe(true);

        // cloneB already has its OWN local value at `ref` — simulating a
        // just-acquired, not-yet-pushed local lease. fetchRefInto must not
        // touch it.
        const localBlobSha = await writeBlob('{"holder":"b","token":"t2"}', { cwd: cloneB });
        await updateRefCAS(ref, localBlobSha, null, { cwd: cloneB });

        const trackingRef = "refs/chant/lease-remote/fountain-converge";
        expect(await fetchRefInto(ref, trackingRef, { cwd: cloneB })).toBe(true);

        // The tracking ref reflects the remote's value...
        expect(await readRefSha(trackingRef, { cwd: cloneB })).toBe(remoteBlobSha);
        // ...but cloneB's own local `ref` is completely untouched.
        expect(await readRefSha(ref, { cwd: cloneB })).toBe(localBlobSha);
      } finally {
        await cleanup();
        const { rm } = await import("node:fs/promises");
        await rm(cloneB, { recursive: true, force: true });
      }
    });
  });

  test("RefCASConflictError carries the ref and expected value", () => {
    const err = new RefCASConflictError("refs/chant/lease/x", "abc123", "stale info");
    expect(err.name).toBe("RefCASConflictError");
    expect(err.ref).toBe("refs/chant/lease/x");
    expect(err.expected).toBe("abc123");
    expect(err.message).toContain("moved concurrently");
  });
});
