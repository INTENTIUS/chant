import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLease,
  releaseLease,
  readLease,
  stillHoldsLease,
  currentHolderId,
  leaseRef,
  LEASE_REF_PREFIX,
} from "./lease";

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

describe("lifecycle/lease", () => {
  test("leaseRef namespaces under refs/chant/lease/, distinct from the lifecycle branch", () => {
    expect(leaseRef("fountain-converge")).toBe(`${LEASE_REF_PREFIX}fountain-converge`);
    expect(leaseRef("fountain-converge")).not.toMatch(/^refs\/heads\//);
  });

  test("currentHolderId is stable-shaped (host:pid:random) and unique per call", () => {
    const a = currentHolderId();
    const b = currentHolderId();
    expect(a).toMatch(/^.+:\d+:[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  test("readLease on a never-acquired op returns no record", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const { sha, record } = await readLease("no-such-op", { cwd: dir });
      expect(sha).toBeNull();
      expect(record).toBeUndefined();
    });
  });

  describe("acquireLease — single-writer fencing (#1485)", () => {
    test("first acquire succeeds and mints a fresh token", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const result = await acquireLease("fountain-converge", "holder-a", { cwd: dir });
        expect(result.acquired).toBe(true);
        expect(result.lease?.holder).toBe("holder-a");
        expect(result.lease?.token).toMatch(/^[0-9a-f-]{36}$/);
      });
    });

    test("a second holder cannot acquire a live, unexpired lease — the CAS loser stops, not queues", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const first = await acquireLease("fountain-converge", "holder-a", { cwd: dir, ttlMs: 60_000 });
        expect(first.acquired).toBe(true);

        const second = await acquireLease("fountain-converge", "holder-b", { cwd: dir, ttlMs: 60_000 });
        expect(second.acquired).toBe(false);
        expect(second.heldBy?.holder).toBe("holder-a");
        expect(second.heldBy?.token).toBe(first.lease?.token);
      });
    });

    test("the same holder renewing keeps its token but pushes out expiresAt", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const t0 = new Date("2026-01-01T00:00:00.000Z");
        const first = await acquireLease("fountain-converge", "holder-a", { cwd: dir, ttlMs: 60_000, now: () => t0 });

        const t1 = new Date("2026-01-01T00:00:30.000Z");
        const renewed = await acquireLease("fountain-converge", "holder-a", { cwd: dir, ttlMs: 60_000, now: () => t1 });

        expect(renewed.acquired).toBe(true);
        expect(renewed.lease?.token).toBe(first.lease?.token);
        expect(renewed.lease?.acquiredAt).toBe(first.lease?.acquiredAt);
        expect(new Date(renewed.lease!.expiresAt).getTime()).toBeGreaterThan(new Date(first.lease!.expiresAt).getTime());
      });
    });

    test("a new holder can acquire once the previous lease has expired, and mints a new token", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const t0 = new Date("2026-01-01T00:00:00.000Z");
        const first = await acquireLease("fountain-converge", "holder-a", { cwd: dir, ttlMs: 1_000, now: () => t0 });
        expect(first.acquired).toBe(true);

        // holder-a crashes and never renews; holder-b tries after the TTL passes.
        const tExpired = new Date("2026-01-01T00:00:05.000Z");
        const second = await acquireLease("fountain-converge", "holder-b", { cwd: dir, ttlMs: 1_000, now: () => tExpired });

        expect(second.acquired).toBe(true);
        expect(second.lease?.holder).toBe("holder-b");
        expect(second.lease?.token).not.toBe(first.lease?.token);
      });
    });
  });

  describe("stillHoldsLease — the fencing check a tick uses before trusting its own work", () => {
    test("true while the same holder+token is still live", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const acquired = await acquireLease("fountain-converge", "holder-a", { cwd: dir, ttlMs: 60_000 });
        expect(await stillHoldsLease("fountain-converge", "holder-a", acquired.lease!.token, { cwd: dir })).toBe(true);
      });
    });

    test("false once another holder has taken over (stale token refused)", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const t0 = new Date("2026-01-01T00:00:00.000Z");
        const a = await acquireLease("fountain-converge", "holder-a", { cwd: dir, ttlMs: 1_000, now: () => t0 });

        const tExpired = new Date("2026-01-01T00:00:05.000Z");
        await acquireLease("fountain-converge", "holder-b", { cwd: dir, ttlMs: 1_000, now: () => tExpired });

        // holder-a's tick, still carrying its now-stale token, checks in after
        // holder-b has already reclaimed the lease.
        expect(await stillHoldsLease("fountain-converge", "holder-a", a.lease!.token, { cwd: dir })).toBe(false);
      });
    });

    test("false for an op with no lease at all", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await stillHoldsLease("no-such-op", "holder-a", "any-token", { cwd: dir })).toBe(false);
      });
    });
  });

  describe("releaseLease", () => {
    test("releases when holder+token match, and the lease becomes acquirable again immediately", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const acquired = await acquireLease("fountain-converge", "holder-a", { cwd: dir, ttlMs: 60_000 });
        expect(await releaseLease("fountain-converge", "holder-a", acquired.lease!.token, { cwd: dir })).toBe(true);

        const { record } = await readLease("fountain-converge", { cwd: dir });
        expect(record).toBeUndefined();

        const second = await acquireLease("fountain-converge", "holder-b", { cwd: dir, ttlMs: 60_000 });
        expect(second.acquired).toBe(true);
      });
    });

    test("refuses to release a lease held by someone else, or with a stale token — never drops another holder's lease", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const acquired = await acquireLease("fountain-converge", "holder-a", { cwd: dir, ttlMs: 60_000 });

        expect(await releaseLease("fountain-converge", "holder-b", acquired.lease!.token, { cwd: dir })).toBe(false);
        expect(await releaseLease("fountain-converge", "holder-a", "wrong-token", { cwd: dir })).toBe(false);

        const { record } = await readLease("fountain-converge", { cwd: dir });
        expect(record?.holder).toBe("holder-a");
      });
    });

    test("releasing a non-existent lease is a harmless false, not a throw", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await releaseLease("no-such-op", "holder-a", "t", { cwd: dir })).toBe(false);
      });
    });
  });

  // ── Cross-machine contention (#1485 acceptance criterion: "two operators, one remote") ──

  describe("two operators, one remote — the lease arbitrates across clones, not just within one", () => {
    async function setupClonePair(): Promise<{ clonePath: string; remotePath: string; cleanup: () => Promise<void> }> {
      const remotePath = join(tmpdir(), `chant-lease-remote-${Date.now()}-${Math.random()}`);
      const clonePath = join(tmpdir(), `chant-lease-clone-${Date.now()}-${Math.random()}`);
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

    test("operator A acquires and pushes; operator B (a second clone) sees it as held and loses the race", async () => {
      const { clonePath: cloneA, remotePath, cleanup } = await setupClonePair();
      const cloneB = join(tmpdir(), `chant-lease-clone-b-${Date.now()}-${Math.random()}`);
      try {
        git(["clone", "-q", remotePath, cloneB], tmpdir());
        git(["config", "user.email", "test@chant.dev"], cloneB);
        git(["config", "user.name", "Test"], cloneB);

        const a = await acquireLease("fountain-converge", "operator-a", { cwd: cloneA, ttlMs: 60_000 });
        expect(a.acquired).toBe(true);

        // Operator B, on a different clone of the same remote, tries next —
        // acquireLease fetches the ref first, so A's push is visible.
        const b = await acquireLease("fountain-converge", "operator-b", { cwd: cloneB, ttlMs: 60_000 });
        expect(b.acquired).toBe(false);
        expect(b.heldBy?.holder).toBe("operator-a");
      } finally {
        await cleanup();
        const { rm } = await import("node:fs/promises");
        await rm(cloneB, { recursive: true, force: true });
      }
    });
  });
});
