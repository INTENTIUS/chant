/**
 * #4293: target locks a pull request holds, `_locks/<gate>.json` on
 * `chant/lifecycle`, in one clone and across clones through a bare remote.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeHeldTargetLocks,
  heldTargetLocks,
  parseTargetLocks,
  readTargetLocks,
  releaseTargetLocks,
  renderTargetLocks,
  takeTargetLocks,
  targetLockGateProblem,
  targetLockPath,
  type TargetLock,
} from "./target-lock";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configure(dir: string): void {
  git(dir, "config", "user.email", "test@chant.dev");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
}

function initRepo(): string {
  const dir = tmp("chant-target-lock-");
  git(dir, "init", "-q", "-b", "main");
  configure(dir);
  writeFileSync(join(dir, "README.md"), "# t\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const holder = (pr: number, stage: TargetLock["stage"], by = "alice"): TargetLock => ({ pr, by, at: "2026-10-22T10:00:00.000Z", stage, head: "a".repeat(40) });

describe("the lock file", () => {
  test("parses a version 1 file and drops malformed entries; anything else holds no locks", () => {
    const text = JSON.stringify({ version: 1, locks: { web: holder(1, "plan"), bad: { pr: "x" }, api: { pr: 2, by: "b", at: "t", stage: "nope" } } });
    expect(parseTargetLocks(text)).toEqual({ version: 1, locks: { web: holder(1, "plan") } });
    expect(parseTargetLocks("not json")).toEqual({ version: 1, locks: {} });
    expect(parseTargetLocks(JSON.stringify({ version: 2, locks: {} }))).toEqual({ version: 1, locks: {} });
    expect(parseTargetLocks(null)).toEqual({ version: 1, locks: {} });
  });

  test("renders targets sorted, so the same locks are the same blob", () => {
    const a = renderTargetLocks({ version: 1, locks: { web: holder(1, "plan"), api: holder(2, "lock") } });
    const b = renderTargetLocks({ version: 1, locks: { api: holder(2, "lock"), web: holder(1, "plan") } });
    expect(a).toBe(b);
    expect(Object.keys(JSON.parse(a).locks)).toEqual(["api", "web"]);
  });

  test("the path is _locks/<gate>.json under the member prefix, and a gate name must be a file name", () => {
    expect(targetLockPath("pr-apply")).toBe("_locks/pr-apply.json");
    expect(targetLockPath("pr-apply", "_members/api/")).toBe("_members/api/_locks/pr-apply.json");
    expect(targetLockGateProblem("pr-apply")).toBeNull();
    expect(targetLockGateProblem("../x")).toMatch(/not a lock file name/);
  });

  test("describes held locks by pull request, with how they were taken", () => {
    const text = describeHeldTargetLocks([
      { target: "api", ...holder(7, "plan", "bob") },
      { target: "web", ...holder(7, "plan", "bob") },
      { target: "db", ...holder(9, "lock", "carol") },
    ], (n) => `merge request !${n}`);
    expect(text).toBe("api, web are locked by merge request !7 (planned by bob); db is locked by merge request !9 (locked with chant lock by carol)");
  });
});

describe("target locks in one clone", () => {
  test("a pull request takes free targets; another is refused with the holder named; unlock frees them", async () => {
    const cwd = initRepo();
    const first = await takeTargetLocks("pr-apply", ["web", "api"], holder(1, "plan"), { cwd });
    expect(first).toEqual({ ok: true, taken: ["api", "web"], released: [], expired: [], pushed: false });
    expect(JSON.parse(git(cwd, "show", "chant/lifecycle:_locks/pr-apply.json")).locks.web.pr).toBe(1);

    const second = await takeTargetLocks("pr-apply", ["web", "db"], holder(2, "plan", "bob"), { cwd });
    expect(second).toEqual({ ok: false, held: [{ target: "web", ...holder(1, "plan") }] });
    // Nothing of the refused pull request was written.
    expect(Object.keys((await readTargetLocks("pr-apply", { cwd })).locks)).toEqual(["api", "web"]);

    expect(await heldTargetLocks("pr-apply", ["web", "db"], 2, { cwd })).toHaveLength(1);
    expect(await heldTargetLocks("pr-apply", ["web", "db"], 1, { cwd })).toEqual([]);
    expect(await heldTargetLocks("pr-apply", ["web"], null, { cwd })).toHaveLength(1);

    expect(await releaseTargetLocks("pr-apply", 1, { cwd, targets: ["api"] })).toEqual({ released: ["api"], pushed: false });
    expect(await releaseTargetLocks("pr-apply", 1, { cwd })).toEqual({ released: ["web"], pushed: false });
    expect(await releaseTargetLocks("pr-apply", 1, { cwd })).toEqual({ released: [], pushed: false });
    expect(await takeTargetLocks("pr-apply", ["web", "db"], holder(2, "plan", "bob"), { cwd })).toMatchObject({ ok: true, taken: ["db", "web"] });
  });

  test("a lock whose pull request merged or closed is taken over and dropped", async () => {
    const cwd = initRepo();
    await takeTargetLocks("pr-apply", ["web", "api"], holder(1, "plan"), { cwd });
    const isOpen = async (pr: number) => pr !== 1;
    const taken = await takeTargetLocks("pr-apply", ["web"], holder(2, "lock", "bob"), { cwd, isOpen });
    expect(taken).toMatchObject({ ok: true, taken: ["web"], expired: ["api", "web"] });
    expect((await readTargetLocks("pr-apply", { cwd })).locks).toEqual({ web: holder(2, "lock", "bob") });
    expect(await heldTargetLocks("pr-apply", ["web"], 3, { cwd, isOpen: async () => false })).toEqual([]);
  });

  test("a plan keeps the pull request's own lock and apply locks; an apply takes over its plan locks", async () => {
    const cwd = initRepo();
    await takeTargetLocks("pr-apply", ["web"], holder(1, "lock"), { cwd });
    await takeTargetLocks("pr-apply", ["web", "api"], holder(1, "plan"), { cwd });
    let locks = (await readTargetLocks("pr-apply", { cwd })).locks;
    expect(locks.web.stage).toBe("lock");
    expect(locks.api.stage).toBe("plan");
    await takeTargetLocks("pr-apply", ["api"], holder(1, "apply"), { cwd });
    locks = (await readTargetLocks("pr-apply", { cwd })).locks;
    expect(locks.api.stage).toBe("apply");
  });

  test("a plan with releaseStalePlan drops its plan locks on targets the head no longer reaches", async () => {
    const cwd = initRepo();
    await takeTargetLocks("pr-apply", ["web", "api"], holder(1, "plan"), { cwd });
    await takeTargetLocks("pr-apply", ["db"], holder(1, "lock"), { cwd });
    const again = await takeTargetLocks("pr-apply", ["web"], holder(1, "plan"), { cwd, releaseStalePlan: true });
    expect(again).toMatchObject({ ok: true, taken: ["web"], released: ["api"] });
    expect(Object.keys((await readTargetLocks("pr-apply", { cwd })).locks)).toEqual(["db", "web"]);
  });

  test("each gate keeps its own file", async () => {
    const cwd = initRepo();
    await takeTargetLocks("pr-apply", ["web"], holder(1, "plan"), { cwd });
    expect(await takeTargetLocks("staging-apply", ["web"], holder(2, "plan"), { cwd })).toMatchObject({ ok: true });
    expect(git(cwd, "ls-tree", "--name-only", "chant/lifecycle", "_locks/").split("\n").sort()).toEqual(["_locks/pr-apply.json", "_locks/staging-apply.json"]);
  });
});

describe("target locks across clones, through a bare remote", () => {
  function setup(): { root: string; remote: string; a: string; b: string } {
    const root = tmp("chant-target-lock-remote-");
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    const a = join(root, "a");
    git(root, "clone", "-q", remote, a);
    configure(a);
    writeFileSync(join(a, "README.md"), "# t\n");
    git(a, "add", "README.md");
    git(a, "commit", "-q", "-m", "init");
    git(a, "push", "-q", "origin", "main");
    const b = join(root, "b");
    git(root, "clone", "-q", remote, b);
    configure(b);
    return { root, remote, a, b };
  }

  test("a lock reaches the remote, the other clone is refused, and an unlock there frees it", async () => {
    const { remote, a, b } = setup();
    expect(await takeTargetLocks("pr-apply", ["web"], holder(1, "plan"), { cwd: a })).toMatchObject({ ok: true, pushed: true });
    expect(JSON.parse(git(remote, "show", "chant/lifecycle:_locks/pr-apply.json")).locks.web.pr).toBe(1);
    expect(await takeTargetLocks("pr-apply", ["web"], holder(2, "plan"), { cwd: b })).toMatchObject({ ok: false, held: [{ target: "web", pr: 1 }] });
    expect(await releaseTargetLocks("pr-apply", 1, { cwd: b })).toEqual({ released: ["web"], pushed: true });
    expect(await takeTargetLocks("pr-apply", ["web"], holder(2, "plan"), { cwd: a })).toMatchObject({ ok: true, taken: ["web"], pushed: true });
  });

  test("a push the remote refuses is dropped and decided again: two clones can't both lock one target", async () => {
    const { root, remote, a, b } = setup();
    // A writes its lock locally only, with no remote, then pushes it from B's pre-push hook,
    // so B's first push lands after A's and is refused.
    git(a, "remote", "remove", "origin");
    expect(await takeTargetLocks("pr-apply", ["web"], holder(1, "plan"), { cwd: a })).toMatchObject({ ok: true, pushed: false });
    git(a, "remote", "add", "origin", remote);
    const marker = join(root, "raced");
    const hook = join(b, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\nif [ ! -e "${marker}" ]; then touch "${marker}"; git -C "${a}" push -q origin chant/lifecycle:chant/lifecycle; fi\nexit 0\n`);
    chmodSync(hook, 0o755);

    const lost = await takeTargetLocks("pr-apply", ["web", "api"], holder(2, "plan", "bob"), { cwd: b });
    expect(lost).toEqual({ ok: false, held: [{ target: "web", ...holder(1, "plan") }] });
    // B's refused commit is gone: its branch is the remote's, which holds only A's lock.
    expect(git(b, "rev-parse", "chant/lifecycle")).toBe(git(remote, "rev-parse", "chant/lifecycle"));
    expect(Object.keys(JSON.parse(git(remote, "show", "chant/lifecycle:_locks/pr-apply.json")).locks)).toEqual(["web"]);
  });
});
