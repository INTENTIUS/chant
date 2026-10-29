/**
 * The ruling for ci-products (2026-10-28), "Ledger lock": a stock Pulumi
 * stack or a Terraform root waits for its row on chant's ledger, oldest
 * commit first, up to the job's timeout, and plunge stacks on the resource
 * grain lease their resource rows and never wait on another stack.
 *
 * Each test has a bare remote and one clone per writer, as two pushes'
 * wave jobs have on a forge. The waits use a pause the test drives, so the
 * order of reads is fixed and nothing sleeps.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootRowKey, stackRowKey, urnRowKey, type LockRow } from "./lock-rows";
import {
  leaseLockRows,
  lockWaitSeconds,
  DEFAULT_LOCK_WAIT_SECONDS,
  parseLockRows,
  readLockRows,
  renderLockRows,
  waiterBefore,
  withWaiter,
  withRowsTaken,
  type LockRowHolder,
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

/** A bare remote with one commit on main, and `n` clones of it, each a writer. */
function writers(n: number): { remote: string; clones: string[] } {
  const remote = tmp("chant-lock-wait-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("chant-lock-wait-seed-");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "seed@chant.dev");
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "commit.gpgsign", "false");
  writeFileSync(join(seed, "README.md"), "# t\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  const clones: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = tmp(`chant-lock-wait-clone-${i}-`);
    git(c, "clone", "-q", remote, ".");
    git(c, "config", "user.email", `w${i}@chant.dev`);
    git(c, "config", "user.name", `Writer ${i}`);
    git(c, "config", "commit.gpgsign", "false");
    clones.push(c);
  }
  return { remote, clones };
}

const holder = (run: string, sha?: string): LockRowHolder => ({ run, at: new Date().toISOString(), ...(sha ? { sha } : {}) });
const alive = async () => "alive" as const;
const stackRow = (stack: string): LockRow => ({ key: stackRowKey("shop", stack), target: `shop/${stack}`, address: `shop/${stack}` });
const urnRow = (stack: string, name: string): LockRow => {
  const urn = `urn:pulumi:${stack}::shop::aws:sqs/queue:Queue::${name}`;
  return { key: urnRowKey(urn), target: `shop/${stack}`, address: urn };
};

/** A promise and its resolver. */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const promise = new Promise<void>((r) => (fire = r));
  return { promise, fire };
}

describe("the queue in the rows file", () => {
  test("a waiter round-trips, and the file leaves `waiting` out when nobody waits", () => {
    const empty = parseLockRows(null);
    expect(renderLockRows(empty)).not.toContain("waiting");
    const queued = withWaiter(empty, { run: "12", at: "2026-10-28T10:00:00.000Z", keys: ["stack shop/staging"], commitAt: "2026-10-28T09:59:00Z" });
    const back = parseLockRows(renderLockRows(queued));
    expect(back.waiting).toEqual({ "12": { run: "12", at: "2026-10-28T10:00:00.000Z", keys: ["stack shop/staging"], commitAt: "2026-10-28T09:59:00Z" } });
    // Taking the rows takes the run out of the queue.
    const took = withRowsTaken(back, ["stack shop/staging"], holder("12"), []);
    expect(took.waiting).toBeUndefined();
    expect(took.rows).toEqual({ "stack shop/staging": "12" });
  });

  test("the older commit goes first, then the lower run id, then the commit sha; no commit time goes last", () => {
    expect(waiterBefore({ run: "20", commitAt: "2026-10-28T10:00:00Z" }, { run: "9", commitAt: "2026-10-28T10:05:00Z" })).toBe(true);
    expect(waiterBefore({ run: "9", commitAt: "2026-10-28T10:00:00Z" }, { run: "20", commitAt: "2026-10-28T10:00:00Z" })).toBe(true);
    expect(waiterBefore({ run: "20", commitAt: "2026-10-28T10:00:00Z" }, { run: "9", commitAt: "2026-10-28T10:00:00Z" })).toBe(false);
    expect(waiterBefore({ run: "local:a:1", commitAt: "2026-10-28T10:00:00Z" }, { run: "local:b:1", commitAt: "2026-10-28T10:00:00Z" })).toBe(true);
    expect(waiterBefore({ run: "7", commitAt: "2026-10-28T10:00:00Z", sha: "aaa" }, { run: "7", commitAt: "2026-10-28T10:00:00Z", sha: "bbb" })).toBe(true);
    expect(waiterBefore({ run: "1" }, { run: "2", commitAt: "2026-10-28T10:00:00Z" })).toBe(false);
  });

  test("CHANT_LOCK_WAIT sets the wait; the default sits under a Forgejo runner's three hours", () => {
    expect(lockWaitSeconds({ CHANT_LOCK_WAIT: "600" })).toBe(600);
    expect(lockWaitSeconds({})).toBe(DEFAULT_LOCK_WAIT_SECONDS);
    expect(DEFAULT_LOCK_WAIT_SECONDS).toBeLessThan(3 * 3600);
  });

  test("a root row is the root's key, apart from a choudoufu root's resource rows", () => {
    expect(rootRowKey("stacks/net")).toBe("root stacks/net");
  });
});

describe("two writers on a bare-remote ledger", () => {
  test("the second writer waits for the stack row the first holds, then takes it once the first lets go", async () => {
    const { remote, clones } = writers(2);
    const [a, b] = clones as [string, string];
    const first = await leaseLockRows("pr-apply", [stackRow("staging")], { cwd: a, alive, holder: holder("101") });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const lines: string[] = [];
    let pauses = 0;
    let queuedOnRemote: unknown;
    const second = await leaseLockRows("pr-apply", [stackRow("staging")], {
      cwd: b,
      alive,
      holder: holder("102"),
      wait: {
        deadline: Date.now() + 60_000,
        pollMs: 0,
        commitAt: "2026-10-28T10:05:00Z",
        log: (l) => lines.push(l),
        sleep: async () => {
          pauses++;
          if (pauses === 1) {
            // While B waits, the remote's file names it in the queue, behind A's hold.
            queuedOnRemote = parseLockRows(git(remote, "show", "chant/lifecycle:_locks/rows/pr-apply.json")).waiting;
            expect(await first.lease.release()).toBe(true);
          }
        },
      },
    });
    expect(second.ok).toBe(true);
    expect(pauses).toBe(1);
    expect(queuedOnRemote).toMatchObject({ "102": { run: "102", keys: ["stack shop/staging"], commitAt: "2026-10-28T10:05:00Z" } });
    expect(lines.join("\n")).toContain("run 101 is applying shop/staging");
    const now = await readLockRows("pr-apply", { cwd: a });
    expect(now.rows).toEqual({ "stack shop/staging": "102" });
    expect(now.waiting).toBeUndefined();
  });

  test("two plunge stacks on the resource grain lease their URN rows side by side and never wait", async () => {
    const { clones } = writers(2);
    const [a, b] = clones as [string, string];
    // Two pushes on one plunge stack that change disjoint resources (pw-disjoint), and a second stack beside them.
    const events = await leaseLockRows("pr-apply", [urnRow("dev", "events")], { cwd: a, alive, holder: holder("201") });
    const worker = await leaseLockRows("pr-apply", [urnRow("dev", "worker-3"), urnRow("prod-us", "orders")], { cwd: b, alive, holder: holder("202") });
    expect(events.ok).toBe(true);
    expect(worker.ok).toBe(true);
    const now = await readLockRows("pr-apply", { cwd: a });
    expect(Object.values(now.rows).sort()).toEqual(["201", "202", "202"]);
    expect(now.waiting).toBeUndefined();
    // A resource-grain take on a URN another run holds is refused at once, held, with no wait.
    const clash = await leaseLockRows("pr-apply", [urnRow("dev", "events")], { cwd: b, alive, holder: holder("203") });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.timedOut).toBeUndefined();
  });

  test("a wait that reaches the job's deadline fails by name and leaves the queue", async () => {
    const { clones } = writers(2);
    const [a, b] = clones as [string, string];
    const first = await leaseLockRows("pr-apply", [stackRow("prod-eu")], { cwd: a, alive, holder: holder("301") });
    expect(first.ok).toBe(true);
    let clock = 1_000_000;
    let pauses = 0;
    const second = await leaseLockRows("pr-apply", [stackRow("prod-eu")], {
      cwd: b,
      alive,
      holder: holder("302"),
      wait: {
        deadline: clock + 30_000,
        pollMs: 10_000,
        now: () => clock,
        sleep: async (ms) => {
          pauses++;
          clock += ms;
        },
      },
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.timedOut).toBe(true);
    expect(second.message).toMatch(/^waited 30s for stack shop\/prod-eu of pr-apply and gave up at the job's deadline: run 301 is applying shop\/prod-eu/);
    expect(pauses).toBe(3);
    const now = await readLockRows("pr-apply", { cwd: a });
    expect(now.rows).toEqual({ "stack shop/prod-eu": "301" });
    expect(now.waiting).toBeUndefined();
  });

  test("of two waiters, the older commit takes the row first, whichever joined the queue first", async () => {
    const { clones } = writers(3);
    const [a, b, c] = clones as [string, string, string];
    const holding = await leaseLockRows("pr-apply", [stackRow("staging")], { cwd: a, alive, holder: holder("401") });
    expect(holding.ok).toBe(true);
    if (!holding.ok) return;

    const order: string[] = [];
    const cJoined = signal();
    const aReleased = signal();
    const bSawC = signal();
    const cTook = signal();
    const cReleased = signal();
    const bLines: string[] = [];
    let bPauses = 0;
    let cPauses = 0;
    let older: Promise<Awaited<ReturnType<typeof leaseLockRows>>> | undefined;

    const startOlder = () =>
      leaseLockRows("pr-apply", [stackRow("staging")], {
        cwd: c,
        alive,
        holder: holder("403"),
        wait: {
          deadline: Date.now() + 60_000,
          pollMs: 0,
          commitAt: "2026-10-28T10:00:00Z",
          sleep: async () => {
            cPauses++;
            if (cPauses === 1) {
              cJoined.fire();
              await aReleased.promise;
              // C reads again only once B has read the free row and stayed behind C.
              await bSawC.promise;
            }
          },
        },
      });

    // B, the newer commit, joins the queue first.
    const newer = leaseLockRows("pr-apply", [stackRow("staging")], {
      cwd: b,
      alive,
      holder: holder("402"),
      wait: {
        deadline: Date.now() + 60_000,
        pollMs: 0,
        commitAt: "2026-10-28T10:05:00Z",
        log: (l) => bLines.push(l),
        sleep: async () => {
          bPauses++;
          if (bPauses === 1) {
            older = startOlder().then((r) => {
              order.push("403");
              cTook.fire();
              return r;
            });
            await cJoined.promise;
            expect(await holding.lease.release()).toBe(true);
            aReleased.fire();
          } else if (bPauses === 2) {
            bSawC.fire();
            await cTook.promise;
          } else if (bPauses === 3) {
            await cReleased.promise;
          }
        },
      },
    }).then((r) => {
      order.push("402");
      return r;
    });

    await cTook.promise;
    const c1 = await older!;
    expect(c1.ok).toBe(true);
    if (c1.ok) expect(await c1.lease.release()).toBe(true);
    cReleased.fire();
    const b1 = await newer;
    expect(b1.ok).toBe(true);
    expect(order).toEqual(["403", "402"]);
    expect(bLines.join("\n")).toContain("run 403 waits ahead of it with an older commit");
    const now = await readLockRows("pr-apply", { cwd: a });
    expect(now.rows).toEqual({ "stack shop/staging": "402" });
    expect(now.waiting).toBeUndefined();
  });
});
