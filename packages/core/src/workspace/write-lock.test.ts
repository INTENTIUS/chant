/**
 * The working tree's write lock and write journal (#3173, ws-089): where the
 * lock lives, that writes in one process and across a batch serialise, that a
 * dead or expired holder is broken, that a waiter is refused naming the
 * holder, and that the journal names a record's last writer only while the
 * file holds what that write left.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, repo, scratchDir } from "./__fixtures__/contract-repo";
import writeLockSchema from "./write-lock.schema.json";
import { workspaceLock } from "./write-lock-cli";
import {
  gitDirOf,
  lastWriteReader,
  noteWrites,
  WRITE_LOCK_ENV,
  WRITE_LOCK_WAIT_ENV,
  withWriteLock,
  withWriteLockSync,
  WriteLockError,
  writeLockHolder,
  writeLockPath,
} from "./write-lock";

afterAll(cleanScratch);
afterEach(() => {
  delete process.env[WRITE_LOCK_ENV];
  delete process.env[WRITE_LOCK_WAIT_ENV];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lockDoc = contract(writeLockSchema);

/** Put a lock in place as another process would have left it. */
function plant(start: string, over: Record<string, unknown>): string {
  const lock = writeLockPath(start);
  mkdirSync(lock);
  const now = Date.now();
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ token: "f".repeat(32), pid: process.pid, host: hostname(), verb: "records amend", by: "alice", agent: null, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), ...over }),
  );
  return lock;
}

describe("where the lock lives", () => {
  test("in the working tree's git directory, the linked worktree's own for a worktree, and under tmp outside git", () => {
    const root = repo({ "a.txt": "a\n" }, true);
    expect(gitDirOf(root)).toBe(join(root, ".git"));
    expect(writeLockPath(join(root))).toBe(join(root, ".git", "chant-write.lock"));
    const wt = join(scratchDir(), "wt");
    git(root, "worktree", "add", "-q", wt);
    expect(writeLockPath(wt)).toBe(join(root, ".git", "worktrees", "wt", "chant-write.lock"));
    const bare = scratchDir();
    expect(writeLockPath(bare).startsWith(tmpdir())).toBe(true);
    expect(writeLockPath(bare)).toMatch(/chant-write-[0-9a-f]{16}\.lock$/);
  });
});

describe("withWriteLock", () => {
  test("serialises two writes this process runs at once, and lets a write inside a write through", async () => {
    const root = repo({});
    const order: string[] = [];
    const one = withWriteLock(root, { verb: "records amend", by: "alice" }, false, async () => {
      order.push("one in");
      expect(writeLockHolder(root).holder).toMatchObject({ verb: "records amend", by: "alice", pid: process.pid });
      // Re-entrant: work evidence amends inside its own write.
      await withWriteLock(root, { verb: "records amend" }, false, async () => void order.push("nested"));
      await sleep(80);
      order.push("one out");
    });
    await sleep(10);
    const two = withWriteLock(root, { verb: "records amend", by: "bob" }, false, async () => void order.push("two"));
    await Promise.all([one, two]);
    expect(order).toEqual(["one in", "nested", "one out", "two"]);
    expect(existsSync(writeLockPath(root))).toBe(false);
  });

  test("a dry run takes no lock", async () => {
    const root = repo({});
    plant(root, {});
    expect(await withWriteLock(root, { verb: "records amend" }, true, async () => "ran")).toBe("ran");
  });

  test("a waiter is refused with write-lock-timeout naming the holder, and the lock is released after a failure", async () => {
    const root = repo({});
    plant(root, {});
    process.env[WRITE_LOCK_WAIT_ENV] = "100";
    const err = await withWriteLock(root, { verb: "records review" }, false, async () => "no").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteLockError);
    expect((err as WriteLockError).code).toBe("write-lock-timeout");
    expect((err as WriteLockError).message).toMatch(/records amend \(alice\)/);
    expect((err as WriteLockError).holder?.by).toBe("alice");

    const other = repo({});
    await expect(withWriteLock(other, { verb: "records new" }, false, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(writeLockPath(other))).toBe(false);
  });

  test("breaks a lock whose process has exited, or that has expired", async () => {
    const dead = repo({});
    plant(dead, { pid: 2 ** 22 + 12345 });
    expect(await withWriteLock(dead, { verb: "records amend" }, false, async () => "took it")).toBe("took it");
    const expired = repo({});
    plant(expired, { pid: null, verb: "batch", expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await withWriteLock(expired, { verb: "records amend" }, false, async () => "took it")).toBe("took it");
    expect(writeLockHolder(expired).holder).toBeNull();
  });

  test("the sync form refuses at once while this process's own async write holds the lock", async () => {
    const root = repo({});
    let inner: unknown;
    const outer = withWriteLock(root, { verb: "records amend" }, false, async () => {
      await sleep(30);
    });
    await sleep(5);
    try {
      withWriteLockSync(root, { verb: "box listing set" }, false, () => "no");
    } catch (e) {
      inner = e;
    }
    await outer;
    expect((inner as WriteLockError).code).toBe("write-lock-timeout");
    expect(withWriteLockSync(root, { verb: "box listing set" }, false, () => "yes")).toBe("yes");
  });
});

describe("a batch held across chant calls (lock acquire)", () => {
  test("its token lets each write through while others wait, and a released token is refused", async () => {
    const root = repo({});
    const acquired = await workspaceLock({ cwd: root, verb: "acquire", holder: "hud:alice", ttl: "30s" });
    lockDoc.expectValid(acquired);
    if ("error" in acquired) throw new Error(acquired.error.message);
    expect(acquired.holder).toMatchObject({ verb: "batch", by: "hud:alice", pid: null });
    expect(acquired.token).toMatch(/^[0-9a-f]{32}$/);

    const status = await workspaceLock({ cwd: root, verb: undefined });
    lockDoc.expectValid(status);
    expect(status).not.toHaveProperty("token");
    expect(status.holder).toMatchObject({ by: "hud:alice" });

    // Another writer, without the token, waits and is refused.
    process.env[WRITE_LOCK_WAIT_ENV] = "60";
    await expect(withWriteLock(root, { verb: "records amend" }, false, async () => "no")).rejects.toMatchObject({ code: "write-lock-timeout" });
    // The batch's own writes go ahead.
    process.env[WRITE_LOCK_ENV] = acquired.token!;
    expect(await withWriteLock(root, { verb: "records amend" }, false, async () => "batch write")).toBe("batch write");
    expect(writeLockHolder(root).holder?.verb).toBe("batch");

    const released = await workspaceLock({ cwd: root, verb: "release", token: acquired.token });
    lockDoc.expectValid(released);
    expect(released).toMatchObject({ verb: "release", holder: null });
    await expect(withWriteLock(root, { verb: "records amend" }, false, async () => "no")).rejects.toMatchObject({ code: "write-lock-not-held" });
    const again = await workspaceLock({ cwd: root, verb: "release", token: acquired.token });
    lockDoc.expectValid(again);
    expect(again).toMatchObject({ error: { code: "write-lock-not-held" } });
  });

  test("usage is refused with write-usage-invalid", async () => {
    const root = repo({});
    for (const req of [{ verb: "acquire" }, { verb: "acquire", holder: "x", ttl: "1h" }, { verb: "release" }, { verb: "steal" }, { verb: undefined, token: "x" }]) {
      const doc = await workspaceLock({ cwd: root, ...req });
      lockDoc.expectValid(doc);
      expect(doc).toMatchObject({ error: { code: "write-usage-invalid" } });
    }
  });
});

describe("the write journal", () => {
  test("names the last chant write of a file while the file holds the text it left", () => {
    const root = repo({});
    noteWrites(root, [{ path: "decisions/ws-001.md", text: "one\n" }], { verb: "records amend", by: null, agent: "app-agent" });
    const read = lastWriteReader(root);
    expect(read("decisions/ws-001.md", "one\n")).toMatchObject({ verb: "records amend", by: null, agent: "app-agent" });
    expect(read("decisions/ws-001.md", "edited by hand\n")).toBeNull();
    expect(read("decisions/ws-002.md", "one\n")).toBeNull();
    expect(JSON.parse(readFileSync(join(root, ".git", "chant-writes.json"), "utf-8")).version).toBe(1);
  });

  test("is not kept outside git", () => {
    const bare = scratchDir();
    noteWrites(bare, [{ path: "a.md", text: "a" }], { verb: "records new" });
    expect(lastWriteReader(bare)("a.md", "a")).toBeNull();
  });
});
