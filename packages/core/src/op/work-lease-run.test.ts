/**
 * #2748 — an Op run under a work item's lease: claimed before the steps it
 * covers, renewed while they run, fenced before the run is recorded, released
 * when it ends, and a lost lease stopping the run. An Op that changes the
 * checkout runs its leased steps in a worktree of its own.
 */
import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import type { OpConfig, StepDefinition } from "./types";
import { runOpLocally, OpRunFailure, type OpRunResult } from "./local-executor";
import { workLeaseOutput, workLeaseProblems, stewardWorkHolder, WORK_LEASE_STEP_ID } from "./work-lease-run";
import { declareSteward } from "./steward";
import { Op, shell } from "./builders";
import { shellCmd } from "./activities/shell";
import { WORK_LEASE_ITEM_PATTERN } from "./work-lease-decl";
import { runOperatorRound } from "./operator";
import { stepOutput, validateStepOutputRefScope } from "./step-output-ref";
import { claimWorkLease, readLeaseHistory, releaseWorkLease, listWorkLeases, WORK_ITEM_ID_PATTERN } from "../lifecycle/work-lease";
import { readRunLedger } from "../lifecycle/run-ledger";

const PROFILES: Record<string, ActivityProfile> = {
  long: { timeout: "30s" },
};

function git(args: string[], cwd: string): { stdout: string; status: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", status: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "index.ts"), "export const hello = 1;\n");
  git(["add", "app/index.ts"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

const step = (fn: string, args: Record<string, unknown> = {}, extra: Partial<StepDefinition> = {}): StepDefinition =>
  ({ kind: "activity", fn, args, ...extra }) as StepDefinition;

function dispatchOp(extra: Partial<OpConfig> = {}, steps: StepDefinition[] = [step("build", { lease: workLeaseOutput() })]): OpConfig {
  return { name: "dispatch", overview: "dispatch fixture", phases: [{ name: "Build", steps }], ...extra };
}

async function run(config: OpConfig, activities: Map<string, ActivityFn>, dir: string, work?: { item?: string; holder?: string }): Promise<OpRunResult> {
  try {
    return await runOpLocally(config, activities, PROFILES, undefined, { cwd: dir, ledger: { cwd: dir }, ...(work ? { work } : {}) });
  } catch (err) {
    if (err instanceof OpRunFailure) return err.result;
    throw err;
  }
}

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("the declaration", () => {
  test("an Op that changes the checkout without a work lease is refused by the executor and by declareSteward", async () => {
    const config = dispatchOp({ changesCheckout: true }, [step("build")]);
    expect(workLeaseProblems(config)[0]).toMatch(/changes the checkout but declares no workLease/);
    await expect(runOpLocally(config, new Map(), PROFILES)).rejects.toThrow(/declares no workLease/);
    expect(() => declareSteward({ name: "box", ops: [config] })).toThrow(/Steward "box": Op "dispatch" changes the checkout/);
  });

  test("a scheduled steward Op must say which item it claims; a bad item, ttl or reserved id is refused", () => {
    expect(() =>
      declareSteward({ name: "box", ops: [dispatchOp({ workLease: {}, schedule: { cron: "* * * * *" } })] }),
    ).toThrow(/scheduled, but its workLease names no item/);
    expect(declareSteward({ name: "box", ops: [dispatchOp({ workLease: {} })] }).ops).toHaveLength(1);
    expect(workLeaseProblems(dispatchOp({ workLease: { item: "../x" } }))[0]).toMatch(/can't key a work lease/);
    expect(workLeaseProblems(dispatchOp({ workLease: { item: "W-1", ttl: "1s" } }))[0]).toMatch(/shorter than 3s/);
    expect(workLeaseProblems(dispatchOp({ workLease: { item: stepOutput("nope", "id") } }))[0]).toMatch(/references step "nope"/);
    expect(workLeaseProblems(dispatchOp({ workLease: { item: "W-1" } }, [step("x", {}, { id: WORK_LEASE_STEP_ID })]))[0]).toMatch(/reserved/);
  });

  test("Op() refuses a bad declaration at build time, with the lease's own id pattern", () => {
    expect(() => Op(dispatchOp({ changesCheckout: true }, [step("build")]))).toThrow(/declares no workLease/);
    expect(WORK_LEASE_ITEM_PATTERN.source).toBe(WORK_ITEM_ID_PATTERN.source);
  });

  test("a step may reference the run's work lease; OPS013's scope check accepts it only when the Op declares one", () => {
    const leased = dispatchOp({ workLease: { item: "W-1" } });
    expect(validateStepOutputRefScope(leased)).toEqual([]);
    expect(validateStepOutputRefScope(dispatchOp())[0].message).toMatch(/unknown step id "workLease"/);
  });

  test("an Op whose lease leaves the item to the run is refused without --work", async () => {
    await expect(runOpLocally(dispatchOp({ workLease: {} }), new Map(), PROFILES)).rejects.toThrow(/--work <id>/);
  });
});

describe("a run under a work lease", () => {
  test("claims before its steps, hands them the lease, releases done, and records the item", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      let seen: Record<string, unknown> | undefined;
      const activities = new Map<string, ActivityFn>([["build", async (args) => { seen = args.lease as Record<string, unknown>; return {}; }]]);
      const result = await run(dispatchOp({ workLease: { item: "W-1" } }), activities, dir, { holder: "box/dispatch@h1" });

      expect(result.status).toBe("ok");
      expect(seen).toMatchObject({ item: "W-1", holder: "box/dispatch@h1", worktree: null, branch: null, ref: "refs/chant/lease/work/W-1" });
      expect(result.records.map((r) => [r.fn, r.status])).toEqual([["workLease:claim", "ok"], ["build", "ok"]]);
      expect(result.workLease).toMatchObject({ item: "W-1", released: true, outcome: "done", lost: null, token: seen!.token });
      expect(result.record.outcomes).toMatchObject({ WorkItem: "W-1" });

      const history = (await readLeaseHistory("W-1", { cwd: dir })).records;
      // The claim, the fence's renewal before the run is recorded, and the release.
      expect(history.map((h) => [h.event, h.outcome ?? null])).toEqual([["claim", null], ["renew", null], ["release", "done"]]);
      expect(new Set(history.map((h) => h.token)).size).toBe(1);
      expect(await listWorkLeases({ cwd: dir, memberPrefix: "" })).toEqual([]);
    });
  });

  test("a second dispatcher is refused by the lease: it claims nothing, runs nothing, and names the holder", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const first = await claimWorkLease("W-1", "other-dispatcher", { cwd: dir, ttlMs: 60_000 });
      expect(first.ok).toBe(true);
      const log: string[] = [];
      const activities = new Map<string, ActivityFn>([["build", async () => { log.push("build"); return {}; }]]);
      const result = await run(dispatchOp({ workLease: { item: "W-1" } }), activities, dir);

      expect(result.status).toBe("ok");
      expect(log).toEqual([]);
      expect(result.records.map((r) => [r.fn, r.status])).toEqual([["workLease:claim", "skipped"], ["build", "skipped"]]);
      expect(result.records[0].refusal).toMatch(/lease-held: W-1 is held by other-dispatcher/);
      expect(result.workLease).toMatchObject({ item: null, released: false, refusal: expect.stringMatching(/other-dispatcher/) });
      expect((await listWorkLeases({ cwd: dir, memberPrefix: "" }))[0]).toMatchObject({ item: "W-1", holder: "other-dispatcher" });
    });
  });

  test("candidates are tried in order, and an item picked by an earlier step is claimed right after it", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await claimWorkLease("W-1", "other", { cwd: dir, ttlMs: 60_000 });
      const activities = new Map<string, ActivityFn>([
        ["pick", async () => ({ ready: ["W-1", "W-2", "W-3"] })],
        ["build", async () => ({})],
      ]);
      const op = dispatchOp({ workLease: { item: stepOutput("pick", "ready") } }, [
        step("pick", {}, { id: "pick" }),
        step("build", { item: workLeaseOutput("item") }),
      ]);
      const result = await run(op, activities, dir);
      expect(result.records.map((r) => r.fn)).toEqual(["pick", "workLease:claim", "build"]);
      expect(result.records[2].args).toEqual({ item: "W-2" });
      expect(result.workLease).toMatchObject({ item: "W-2", released: true });

      const none = await run(op, new Map<string, ActivityFn>([["pick", async () => ({ ready: [] })], ["build", async () => ({})]]), dir);
      expect(none.status).toBe("ok");
      expect(none.records.map((r) => [r.fn, r.status])).toEqual([["pick", "ok"], ["workLease:claim", "skipped"], ["build", "skipped"]]);
      expect(none.workLease?.refusal).toMatch(/nothing to claim/);
    });
  });

  test("a shell pick step that prints JSON hands the lease its candidates, and the next is claimed when the first is held (#2787)", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await claimWorkLease("W-4", "other", { cwd: dir, ttlMs: 60_000 });
      const pick = shell(`echo '["W-4","W-5"]'`, { id: "pick", json: true });
      const op = dispatchOp({ workLease: { item: pick.out.json } }, [pick, step("build", { item: workLeaseOutput("item") })]);
      const activities = new Map<string, ActivityFn>([
        ["shellCmd", shellCmd as unknown as ActivityFn],
        ["build", async () => ({})],
      ]);
      const result = await run(op, activities, dir);
      expect(result.status).toBe("ok");
      expect(result.records.map((r) => r.fn)).toEqual(["shellCmd", "workLease:claim", "build"]);
      expect(result.records[2].args).toEqual({ item: "W-5" });
      expect(result.workLease).toMatchObject({ item: "W-5", released: true });
    });
  });

  test("--work takes the place of the Op's item, and a failed run releases not_done", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const activities = new Map<string, ActivityFn>([["build", async () => { throw new Error("the check fails"); }]]);
      const result = await run(dispatchOp({ workLease: {} }), activities, dir, { item: "W-9" });
      expect(result.status).toBe("fail");
      expect(result.workLease).toMatchObject({ item: "W-9", released: true, outcome: "not_done" });
    });
  });

  test("the heartbeat renews the lease while a long step runs, keeping its token", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      let during: { expiresAt: string; token: string } | undefined;
      const activities = new Map<string, ActivityFn>([
        [
          "build",
          async (args) => {
            const lease = args.lease as { item: string; expiresAt: string; token: string };
            const claimedUntil = lease.expiresAt;
            // Renewed every third of 3s: wait for the ref to move past the claim's expiry.
            await waitFor(async () => {
              const [l] = await listWorkLeases({ cwd: dir, memberPrefix: "" });
              return !!l && l.expiresAt > claimedUntil;
            });
            const [l] = await listWorkLeases({ cwd: dir, memberPrefix: "" });
            during = { expiresAt: l.expiresAt, token: l.token };
            return {};
          },
        ],
      ]);
      const result = await run(dispatchOp({ workLease: { item: "W-1", ttl: "3s" } }, [step("build", { lease: workLeaseOutput() }, { profile: "long" } as never)]), activities, dir);
      expect(result.status).toBe("ok");
      expect(during?.token).toBe(result.workLease?.token);
      const events = (await readLeaseHistory("W-1", { cwd: dir })).records.map((h) => h.event);
      expect(events[0]).toBe("claim");
      expect(events).toContain("renew");
      expect(events.at(-1)).toBe("release");
    });
  }, 30_000);

  test("a lease lost mid-step stops the step and the run, which fails lease-lost and releases nothing", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const log: string[] = [];
      const activities = new Map<string, ActivityFn>([
        [
          "build",
          async (args, signal) => {
            const lease = args.lease as { item: string; holder: string; token: string };
            // The lease runs out from under this run and another worker takes it.
            await releaseWorkLease(lease.item, lease.holder, { cwd: dir, token: lease.token });
            expect((await claimWorkLease(lease.item, "thief", { cwd: dir, ttlMs: 60_000 })).ok).toBe(true);
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(() => reject(new Error("never stopped")), 20_000);
              signal?.addEventListener("abort", () => { clearTimeout(t); log.push("stopped"); reject(new Error("aborted")); }, { once: true });
            });
            return {};
          },
        ],
        ["after", async () => { log.push("after"); return {}; }],
      ]);
      const op = dispatchOp({ workLease: { item: "W-1", ttl: "3s" } }, [
        step("build", { lease: workLeaseOutput() }, { profile: "long" } as never),
        step("after"),
      ]);
      const result = await run(op, activities, dir);

      expect(log).toEqual(["stopped"]);
      expect(result.status).toBe("fail");
      expect(result.records.map((r) => [r.fn, r.status])).toEqual([
        ["workLease:claim", "ok"],
        ["build", "fail"],
        ["after", "skipped"],
        ["workLease:lost", "fail"],
      ]);
      expect(result.records.at(-1)?.error).toMatch(/^lease-lost: W-1 is held by thief/);
      expect(result.workLease).toMatchObject({ released: false, lost: expect.stringMatching(/thief/) });
      // The thief still holds it: a lost lease isn't this run's to give back.
      expect((await listWorkLeases({ cwd: dir, memberPrefix: "" }))[0]).toMatchObject({ holder: "thief", state: "active" });
      expect((await readRunLedger("local", "dispatch", { cwd: dir })).records.at(-1)?.status).toBe("fail");
    });
  }, 30_000);

  test("a run whose lease was lost before it is recorded is never recorded as done", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const activities = new Map<string, ActivityFn>([
        [
          "build",
          async (args) => {
            const lease = args.lease as { item: string; holder: string; token: string };
            await releaseWorkLease(lease.item, lease.holder, { cwd: dir, token: lease.token });
            await claimWorkLease(lease.item, "thief", { cwd: dir, ttlMs: 60_000 });
            return {};
          },
        ],
      ]);
      const result = await run(dispatchOp({ workLease: { item: "W-1" } }), activities, dir);
      expect(result.status).toBe("fail");
      expect(result.records.map((r) => r.fn)).toEqual(["workLease:claim", "build", "workLease:lost"]);
      expect(result.workLease).toMatchObject({ released: false });
      expect((await readRunLedger("local", "dispatch", { cwd: dir })).records.at(-1)?.status).toBe("fail");
    });
  });
});

describe("an Op that changes the checkout", () => {
  test("applies a build on chant/work/<item> in a worktree of its own, and the coding agent's edits and index lock are untouched", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const head = git(["rev-parse", "HEAD"], dir).stdout.trim();
      const edited = "export const hello = 2; // the coding agent's uncommitted edit\n";
      writeFileSync(join(dir, "app", "index.ts"), edited);
      const lock = join(dir, ".git", "index.lock");
      writeFileSync(lock, "");

      let worktree = "";
      const activities = new Map<string, ActivityFn>([
        [
          "applyBuild",
          async (args) => {
            worktree = String(args.worktree);
            // The build the builder pushed, applied and committed in the worktree.
            writeFileSync(join(worktree, "app", "index.ts"), "export const hello = 3; // the build\n");
            writeFileSync(join(worktree, "app", "feature.ts"), "export const feature = true;\n");
            expect(git(["add", "-A"], worktree).status).toBe(0);
            expect(git(["commit", "-q", "-m", "apply W-7"], worktree).status).toBe(0);
            return {};
          },
        ],
      ]);
      const steward = declareSteward({
        name: "box",
        ops: [
          dispatchOp({ workLease: { item: "W-7" }, changesCheckout: true, schedule: { cron: "* * * * *" } }, [
            step("applyBuild", { worktree: workLeaseOutput("worktree"), branch: workLeaseOutput("branch") }),
          ]),
        ],
      });
      const events = await runOperatorRound({ cwd: dir, holder: "h1", steward, activities, profiles: PROFILES, now: () => new Date(2026, 8, 25, 10, 1) });
      expect(events.map((e) => e.kind)).toEqual(["ticked"]);
      const result = (events[0] as { result: OpRunResult }).result;
      expect(result.workLease).toMatchObject({ item: "W-7", branch: "chant/work/W-7", released: true, outcome: "done" });
      expect(result.workLease?.holder).toBe(stewardWorkHolder("box", "dispatch", "h1"));

      // The worktree sat under the git directory and is gone; the branch keeps the build.
      expect(worktree.startsWith(join(dir, ".git"))).toBe(true);
      expect(existsSync(worktree)).toBe(false);
      expect(git(["show", "chant/work/W-7:app/feature.ts"], dir).stdout).toBe("export const feature = true;\n");

      // The coding agent's checkout: its edit, its lock, HEAD and the index, as they were.
      expect(readFileSync(join(dir, "app", "index.ts"), "utf-8")).toBe(edited);
      expect(existsSync(lock)).toBe(true);
      rmSync(lock);
      expect(git(["rev-parse", "HEAD"], dir).stdout.trim()).toBe(head);
      expect(git(["status", "--porcelain"], dir).stdout).toBe(" M app/index.ts\n");
    });
  });
});
