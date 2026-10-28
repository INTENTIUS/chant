/**
 * #4552: row leases on the resource lock grain, `_locks/rows/<gate>.json` at
 * the root of `chant/lifecycle`, in terragucci's format: all-or-nothing
 * takes, stale takeover, the stack row's cover, and the member prefix left out.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackRowKey, urnRowKey, type LockRow } from "./lock-rows";
import {
  DEFAULT_LOCK_STALE_SECONDS,
  describeHeldLockRows,
  forgeLockLiveness,
  heldLockRowsIn,
  leaseLockRows,
  lockRowsPath,
  lockStaleSeconds,
  parseLockRows,
  readLockRows,
  releaseLockRows,
  renderLockRows,
  takeLockRows,
  withRowsReleased,
  withRowsTaken,
  type LockRowHolder,
  type LockRowsFile,
} from "./resource-lock";

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

function initRepo(): string {
  const dir = tmp("chant-resource-lock-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@chant.dev");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# t\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const run = (id: string, at = "2026-10-27T10:00:00.000Z"): LockRowHolder => ({ run: id, at });
const row = (key: string, target = "e01"): LockRow => ({ key, target, address: key.split(" ").slice(2).join(" ") || key });
const alive = async () => "alive" as const;
const URN = "urn:pulumi:dev::site::aws:s3/bucket:Bucket::logs";

describe("the rows file", () => {
  test("parses terragucci's version 1 file and drops a row whose holder is missing", () => {
    const text = JSON.stringify({ version: 1, holders: { "11": run("11") }, rows: { "estate e01 a.b": "11", "estate e01 c.d": "12" } });
    expect(parseLockRows(text)).toEqual({ version: 1, holders: { "11": run("11") }, rows: { "estate e01 a.b": "11" } });
    expect(parseLockRows("nope")).toEqual({ version: 1, holders: {}, rows: {} });
    expect(parseLockRows(null)).toEqual({ version: 1, holders: {}, rows: {} });
  });

  test("renders keys sorted, so the same rows are the same blob", () => {
    const a: LockRowsFile = { version: 1, holders: { b: run("b"), a: run("a") }, rows: { y: "a", x: "b" } };
    const b: LockRowsFile = { version: 1, holders: { a: run("a"), b: run("b") }, rows: { x: "b", y: "a" } };
    expect(renderLockRows(a)).toBe(renderLockRows(b));
  });

  test("lives at the ledger root, one file per gate", () => {
    expect(lockRowsPath("pr-apply")).toBe("_locks/rows/pr-apply.json");
  });

  test("a take drops every row of a run that is gone; a release drops the holder once it holds nothing", () => {
    const file: LockRowsFile = { version: 1, holders: { old: run("old"), keep: run("keep") }, rows: { a: "old", b: "old", c: "keep" } };
    const taken = withRowsTaken(file, ["a"], run("me"), ["old"]);
    expect(taken.rows).toEqual({ a: "me", c: "keep" });
    expect(Object.keys(taken.holders).sort()).toEqual(["keep", "me"]);
    const released = withRowsReleased(taken, ["a"], "me");
    expect(released.rows).toEqual({ c: "keep" });
    expect(Object.keys(released.holders)).toEqual(["keep"]);
  });

  test("a stack row is held by a run holding one of the stack's URNs, and the other way round", async () => {
    const file: LockRowsFile = { version: 1, holders: { r1: run("r1") }, rows: { [urnRowKey(URN)]: "r1" } };
    const { live } = await heldLockRowsIn(file, [stackRowKey("site", "dev")], "me", alive);
    expect(live).toEqual([{ key: urnRowKey(URN), wanted: stackRowKey("site", "dev"), holder: run("r1") }]);
    const other: LockRowsFile = { version: 1, holders: { r1: run("r1") }, rows: { [stackRowKey("site", "dev")]: "r1" } };
    expect((await heldLockRowsIn(other, [urnRowKey(URN)], "me", alive)).live).toHaveLength(1);
    expect((await heldLockRowsIn(other, [stackRowKey("site", "prod")], "me", alive)).live).toEqual([]);
  });

  test("names the runs and what of this apply they hold", () => {
    const text = describeHeldLockRows([{ key: "estate e01 a.b", wanted: "estate e01 a.b", holder: { run: "77", at: "t", url: "https://forge/runs/77" } }], [row("estate e01 a.b")]);
    expect(text).toBe("run 77 (https://forge/runs/77) is applying e01: a.b");
  });
});

describe("liveness", () => {
  test("CHANT_LOCK_STALE sets the lease, TG_LOCK_STALE is its alias, and the default is two hours", () => {
    expect(lockStaleSeconds({})).toBe(DEFAULT_LOCK_STALE_SECONDS);
    expect(lockStaleSeconds({ TG_LOCK_STALE: "60" })).toBe(60);
    expect(lockStaleSeconds({ CHANT_LOCK_STALE: "30", TG_LOCK_STALE: "60" })).toBe(30);
    expect(lockStaleSeconds({ CHANT_LOCK_STALE: "zero" })).toBe(DEFAULT_LOCK_STALE_SECONDS);
  });

  test("a lease older than the stale time is gone; with no token the forge is not asked and the run counts as alive", async () => {
    const now = () => Date.parse("2026-10-27T13:00:00.000Z");
    const fetch = async () => {
      throw new Error("not asked");
    };
    const liveness = forgeLockLiveness({}, fetch, now);
    expect(await liveness(run("1", "2026-10-27T10:00:00.000Z"))).toBe("dead");
    expect(await liveness(run("1", "2026-10-27T12:30:00.000Z"))).toBe("alive");
  });

  test("the forge's finished run is gone", async () => {
    const now = () => Date.parse("2026-10-27T10:05:00.000Z");
    const fetch = async () => ({ ok: true, json: async () => ({ status: "completed" }) });
    const liveness = forgeLockLiveness({ CHANT_FORGE_TOKEN: "t", GITHUB_SERVER_URL: "https://forge", GITHUB_REPOSITORY: "o/r" }, fetch, now);
    expect(await liveness(run("9"))).toBe("dead");
  });
});

describe("leases in one clone", () => {
  test("a run takes free rows in one commit; another is refused and writes nothing; a release frees them", async () => {
    const cwd = initRepo();
    const first = await takeLockRows("pr-apply", [row("estate e01 a.b"), row("object i-1")], run("1"), { cwd, alive });
    expect(first).toEqual({ ok: true, tookOver: [], pushed: false });
    expect(JSON.parse(git(cwd, "show", "chant/lifecycle:_locks/rows/pr-apply.json")).rows).toEqual({ "estate e01 a.b": "1", "object i-1": "1" });

    const tip = git(cwd, "rev-parse", "chant/lifecycle");
    const second = await takeLockRows("pr-apply", [row("estate e01 c.d"), row("object i-1")], run("2"), { cwd, alive });
    expect(second).toMatchObject({ ok: false, held: [{ key: "object i-1", holder: { run: "1" } }] });
    expect(git(cwd, "rev-parse", "chant/lifecycle")).toBe(tip);

    expect(await releaseLockRows("pr-apply", ["estate e01 a.b", "object i-1"], "1", { cwd })).toBe(true);
    expect((await readLockRows("pr-apply", { cwd })).rows).toEqual({});
    expect(await takeLockRows("pr-apply", [row("object i-1")], run("2"), { cwd, alive })).toMatchObject({ ok: true });
  });

  test("the rows of a run that is gone are taken over, all of them", async () => {
    const cwd = initRepo();
    await takeLockRows("pr-apply", [row("a"), row("b")], run("old"), { cwd, alive });
    const gone = async (h: LockRowHolder) => (h.run === "old" ? ("dead" as const) : ("alive" as const));
    const taken = await takeLockRows("pr-apply", [row("a")], run("new"), { cwd, alive: gone });
    expect(taken).toMatchObject({ ok: true, tookOver: [{ run: "old" }] });
    expect((await readLockRows("pr-apply", { cwd })).rows).toEqual({ a: "new" });
  });

  test("a lease holds nothing without rows, and lets go of what it took", async () => {
    const cwd = initRepo();
    const empty = await leaseLockRows("pr-apply", [], { cwd, alive, holder: run("1") });
    expect(empty).toMatchObject({ ok: true, lease: { keys: [] } });
    const held = await leaseLockRows("pr-apply", [row("a")], { cwd, alive, holder: run("1") });
    expect(held.ok).toBe(true);
    const refused = await leaseLockRows("pr-apply", [row("a")], { cwd, alive, holder: run("2") });
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/run 1 is applying/) });
    if (held.ok) expect(await held.lease.release()).toBe(true);
    expect((await readLockRows("pr-apply", { cwd })).rows).toEqual({});
  });

  test("the take writes one file at the ledger root, under _locks/rows", async () => {
    const cwd = initRepo();
    await takeLockRows("pr-apply", [row("a")], run("1"), { cwd, alive });
    expect(git(cwd, "ls-tree", "-r", "--name-only", "chant/lifecycle")).toBe("_locks/rows/pr-apply.json");
  });
});
