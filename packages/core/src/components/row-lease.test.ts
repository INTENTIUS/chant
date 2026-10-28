/**
 * #4594: every apply path takes the row lease on the resource lock grain.
 *
 * The capabilities here are fakes. `fake-res` plans one root, says it is on
 * the resource grain unless told otherwise, and names one row per root,
 * `row <root>`. `fake-group` plans and applies its members as one (ws-107).
 * The lease port is in memory: it records each take and release, and
 * refuses a row named in `held`. The rows file itself, and the count that
 * keeps a row two steps of one run share until both end, run against a
 * local git repository at the end.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { CapabilityRegistry, type CapabilityGroupOutcome, type CapabilityPlan, type DeployContext, type GroupMember, type GroupRun, type PlannedOutputs } from "./capability";
import { DriverRunFailure, failedRunExitCode, runComponentDeploy, runInterpretDriver, type DriverComponent, type DriverRunResult } from "./driver";
import { planFanOut } from "./fan-out";
import { runFanOut } from "./fan-out-run";
import { componentSetFanOut, groupFanOut, planAndRunComponentGroup, planComponentGroup, runComponentGroup } from "./groups";
import { applyPrSet, approvalOf, decidePrGate, planPrSet, readOnlyLedger, type PrPlanSet } from "./pr-run";
import { ledgerRowLease, leaseCapabilityStep, LockRowsHeldError, isLockRowsHeldError, type RowLeasePort } from "./row-lease";
import { memoryGateLedgerPort } from "../op/gate";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { lockGrainBeforePlan, type LockGrain, type LockRow } from "../lifecycle/lock-rows";
import { readLockRows } from "../lifecycle/resource-lock";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";

interface RootInput {
  root: string;
  vars?: Record<string, unknown>;
  lockGrain?: LockGrain;
}

const NOW = "2026-10-27T10:00:00Z";
const LATER = "2026-10-27T11:00:00Z";

const step = (kind: string, name: string, vars?: Record<string, unknown>) => ({ kind, root: name, ...(vars ? { vars } : {}) });
const comp = (kind: string, name: string, dependsOn: string[] = [], vars?: Record<string, unknown>): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [step(kind, name, vars)] }],
});
const res = (name: string, dependsOn: string[] = [], vars?: Record<string, unknown>) => comp("fake-res", name, dependsOn, vars);
const so = (stack: string, name: string) => ({ stackOutput: { stack, name } });

/** An in-memory lease port: each take and release, in order, and the rows another run holds. */
function memoryPort(held: string[] = []) {
  const log = { takes: [] as Array<{ label: string; keys: string[] }>, releases: [] as string[], live: new Set<string>() };
  const port: RowLeasePort = {
    async take(rows: readonly LockRow[], label: string) {
      const keys = rows.map((r) => r.key).sort();
      const hit = keys.filter((k) => held.includes(k));
      if (hit.length > 0) throw new LockRowsHeldError(`${label}: run 4711 is applying ${hit.join(", ")}, so nothing of it was applied`);
      log.takes.push({ label, keys });
      for (const k of keys) log.live.add(k);
      return {
        async release() {
          log.releases.push(label);
          for (const k of keys) log.live.delete(k);
          return true;
        },
      };
    },
  };
  return { port, log };
}

function world(opts: { grain?: LockGrain; refuse?: boolean } = {}) {
  const w = {
    registry: new CapabilityRegistry(),
    planned: [] as string[],
    applied: [] as string[],
    /** Whether each root applied a plan it was handed, and whether its row was held while it did. */
    fromPlan: {} as Record<string, boolean>,
    heldWhileApplying: {} as Record<string, boolean>,
    versions: {} as Record<string, string>,
    state: {} as Record<string, Record<string, unknown>>,
    predict: {} as Record<string, () => PlannedOutputs | undefined>,
    live: undefined as Set<string> | undefined,
  };
  const planOf = (input: RootInput): CapabilityPlan => {
    w.planned.push(input.root);
    const version = w.versions[input.root] ?? "v1";
    const planDigest = computePlanDigest("fake-res", { root: input.root, version, vars: input.vars ?? null });
    const outputs = w.predict[input.root]?.();
    return {
      member: input.root,
      planDigest,
      artifact: { planDigest },
      ...(outputs ? { outputs } : {}),
      changeSet: {
        member: { member: input.root, lexicon: "terraform", planner: "choudoufu", status: "planned", planDigest, holes: [] },
        entries: [{ member: input.root, lexicon: "terraform", planner: "choudoufu", address: "res.x", type: "res", action: "update", attributes: [{ path: "version", before: "v0", after: version }] }],
      },
    };
  };
  const hooks = {
    defaultLockGrain: () => opts.grain ?? ("resource" as const),
    lockGrainRefusal: (_input: RootInput, grain: LockGrain) => (opts.refuse && grain === "resource" ? "fake-res keeps the target grain" : undefined),
    lockRows: (_input: RootInput, plan: CapabilityPlan): LockRow[] => [{ key: `row ${plan.member}`, target: plan.member, address: "res.x" }],
  };
  const applyOne = (ctx: DeployContext, input: RootInput) => {
    w.fromPlan[input.root] = ctx.plans?.[input.root] !== undefined;
    w.heldWhileApplying[input.root] = w.live?.has(`row ${input.root}`) ?? false;
    w.applied.push(input.root);
    w.state[input.root] = { id: `${input.root}-${w.versions[input.root] ?? "v1"}` };
    return { outputs: { ...w.state[input.root] } };
  };
  w.registry.register({
    kind: "fake-res",
    ...hooks,
    async plan(_ctx: DeployContext, input: RootInput) {
      return planOf(input);
    },
    async outputs(_ctx: DeployContext, input: RootInput) {
      return { ...(w.state[input.root] ?? {}) };
    },
    async run(ctx: DeployContext, input: RootInput) {
      return applyOne(ctx, input);
    },
  } as never);
  w.registry.register({
    kind: "fake-group",
    ...hooks,
    async plan(_ctx: DeployContext, input: RootInput) {
      return planOf(input);
    },
    async run(ctx: DeployContext, input: RootInput) {
      return applyOne(ctx, input);
    },
    async planGroup(_ctx: unknown, members: readonly GroupMember<RootInput>[]) {
      return { digest: computePlanDigest("fake-group", members.map((m) => m.component)), members: Object.fromEntries(members.map((m) => [m.component, planOf(m.input!)])) };
    },
    async runGroup(_ctx: unknown, _run: GroupRun, members: readonly GroupMember<RootInput>[]): Promise<CapabilityGroupOutcome> {
      return { members: Object.fromEntries(members.map((m) => [m.component, { status: "applied" as const, outputs: applyOne(m.ctx, m.input!).outputs }])) };
    },
  } as never);
  return w;
}

async function interpret(components: DriverComponent[], w: ReturnType<typeof world>, options: Partial<Parameters<typeof runInterpretDriver>[2]> = {}): Promise<DriverRunResult> {
  try {
    return await runInterpretDriver(components, w.registry, { env: "prod", gates: memoryGateLedgerPort(), ...options });
  } catch (err) {
    if (err instanceof DriverRunFailure) return err.result;
    throw err;
  }
}

describe("a step on the resource grain leases its rows (run --components, promote)", () => {
  test("plans, takes the rows of that plan, applies the plan it leased for, and lets go", async () => {
    const w = world();
    const { port, log } = memoryPort();
    w.live = log.live;
    const run = await interpret([res("net"), res("dns")], w, { rowLease: port });
    expect(run.status).toBe("ok");
    // One wave: the two steps lease side by side, so their order is not fixed.
    expect([...log.takes].sort((a, b) => a.label.localeCompare(b.label))).toEqual([
      { label: "dns", keys: ["row dns"] },
      { label: "net", keys: ["row net"] },
    ]);
    expect(w.fromPlan).toEqual({ net: true, dns: true });
    expect(w.heldWhileApplying).toEqual({ net: true, dns: true });
    expect([...log.releases].sort()).toEqual(["dns", "net"]);
    expect(log.live.size).toBe(0);
  });

  test("a row another run holds fails the step before it applies, marked held, and the run exits 5", async () => {
    const w = world();
    const { port } = memoryPort(["row net"]);
    const run = await interpret([res("net"), res("app", ["net"], { upstream: so("net", "id") })], w, { rowLease: port });
    expect(run.status).toBe("fail");
    expect(w.applied).toEqual([]);
    const record = run.results.find((r) => r.component === "net")!.records[0]!;
    expect(record).toMatchObject({ status: "fail", held: true });
    expect(record.error).toContain("run 4711 is applying row net");
    expect(failedRunExitCode(run.results)).toBe(5);
  });

  test("a declared target grain takes no lease and applies as before, without planning first", async () => {
    const w = world();
    const { port, log } = memoryPort();
    const run = await interpret([res("net")], w, { rowLease: port, lockGrain: "target" });
    expect(run.status).toBe("ok");
    expect(log.takes).toEqual([]);
    expect(w.planned).toEqual([]);
    expect(w.fromPlan).toEqual({ net: false });
  });

  test("a step's own lockGrain wins over the declared grain", async () => {
    const w = world({ grain: "target" });
    const { port, log } = memoryPort();
    const run = await interpret([{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "fake-res", root: "net", lockGrain: "resource" }] }] }], w, { rowLease: port, lockGrain: "target" });
    expect(run.status).toBe("ok");
    expect(log.takes).toEqual([{ label: "net", keys: ["row net"] }]);
  });

  test("a grain the lexicon refuses fails the step with the lexicon's reason, and nothing applies", async () => {
    const w = world({ refuse: true });
    const { port } = memoryPort();
    const run = await interpret([res("net")], w, { rowLease: port, lockGrain: "resource" });
    expect(run.status).toBe("fail");
    expect(run.results[0]!.records[0]!.error).toContain("fake-res keeps the target grain");
    expect(w.applied).toEqual([]);
    expect(failedRunExitCode(run.results)).toBe(1);
  });

  test("without a lease port nothing changes: no plan, no take", async () => {
    const w = world();
    const run = await interpret([res("net")], w);
    expect(run.status).toBe("ok");
    expect(w.planned).toEqual([]);
    expect(w.fromPlan).toEqual({ net: false });
  });

  test("a step handed a plan leases nothing itself: its caller leased what it planned", async () => {
    const w = world();
    const { port, log } = memoryPort();
    const ctx: DeployContext = { env: "prod", component: "net", rowLease: port, plans: { net: { planDigest: "x" } } };
    const result = await runComponentDeploy(res("net"), ctx, w.registry, {}, undefined, { port: memoryGateLedgerPort() });
    expect(result.status).toBe("ok");
    expect(log.takes).toEqual([]);
  });

  test("leaseCapabilityStep and lockGrainBeforePlan read the grain by the same order as a pull request's plan", async () => {
    const w = world({ grain: "target" });
    const cap = w.registry.resolve("fake-res");
    expect(await lockGrainBeforePlan(cap, { root: "net" }, undefined)).toBe("target");
    expect(await lockGrainBeforePlan(cap, { root: "net" }, "resource")).toBe("resource");
    expect(await lockGrainBeforePlan(cap, { root: "net", lockGrain: "repo" }, "resource")).toBe("repo");
    const { port, log } = memoryPort();
    const leased = await leaseCapabilityStep(cap, { env: "prod", component: "net", rowLease: port, lockGrain: "resource" }, { root: "net" });
    expect(leased.ctx.plans).toEqual({ net: { planDigest: expect.any(String) } });
    expect(log.takes).toEqual([{ label: "net", keys: ["row net"] }]);
    await leased.lease.release();
    expect(log.releases).toEqual(["net"]);
  });

  test("isLockRowsHeldError reads the mark, so a copy from another bundle counts", () => {
    expect(isLockRowsHeldError(new LockRowsHeldError("x"))).toBe(true);
    expect(isLockRowsHeldError({ lockRowsHeld: true })).toBe(true);
    expect(isLockRowsHeldError(new Error("x"))).toBe(false);
  });
});

describe("a group planned as one carries and leases its members' rows (ws-107)", () => {
  const GROUP = { capability: "fake-group", components: ["a", "b"] };
  const MEMBERS = [comp("fake-group", "a"), comp("fake-group", "b", ["a"], { upstream: so("a", "id") })];
  const byName = new Map(MEMBERS.map((c) => [c.name, c]));

  test("planComponentGroup gives each member its grain and rows, as a component planned alone has them", async () => {
    const w = world();
    const planned = await planComponentGroup({ group: GROUP, components: byName, registry: w.registry, env: "prod", ctxOf: (name) => ({ env: "prod", component: name }), outputs: {} });
    const locks = planned.plans.map((p) => ("error" in p ? p.error : p.locks));
    expect(locks).toEqual([
      { a: { grain: "resource", source: "lexicon", rows: [{ key: "row a", target: "a", address: "res.x" }] } },
      { b: { grain: "resource", source: "lexicon", rows: [{ key: "row b", target: "b", address: "res.x" }] } },
    ]);
  });

  test("a pull request's plan of a group lists the members' locks, so pr-apply leases them", async () => {
    const w = world();
    const plan = groupFanOut(componentSetFanOut(MEMBERS), MEMBERS, { groups: [GROUP], fallbacks: [] });
    const set = await planPrSet({ components: MEMBERS, plan, registry: w.registry, env: "prod" });
    expect(Object.keys(set.locks ?? {}).sort()).toEqual(["a", "b"]);
    expect(set.locks?.a).toMatchObject({ component: "a", grain: "resource", rows: [{ key: "row a" }] });
  });

  test("a group that plans in its wave takes every member's rows in one take, then lets go", async () => {
    const w = world();
    const { port, log } = memoryPort();
    w.live = log.live;
    const ran = await planAndRunComponentGroup({ group: GROUP, components: byName, registry: w.registry, env: "prod", ctxOf: (name) => ({ env: "prod", component: name, rowLease: port }), componentOutputs: {} });
    expect(ran.outcomes).toEqual({ a: "applied", b: "applied" });
    expect(log.takes).toEqual([{ label: "the group a, b", keys: ["row a", "row b"] }]);
    expect(w.heldWhileApplying).toEqual({ a: true, b: true });
    expect(log.releases).toEqual(["the group a, b"]);
  });

  test("a held row leaves every member not started, marked held, and the run exits 5", async () => {
    const w = world();
    const { port } = memoryPort(["row b"]);
    const planned = await planComponentGroup({ group: GROUP, components: byName, registry: w.registry, env: "prod", ctxOf: (name) => ({ env: "prod", component: name }), outputs: {} });
    const ran = await runComponentGroup({ group: GROUP, components: byName, registry: w.registry, env: "prod", ctxOf: (name) => ({ env: "prod", component: name, rowLease: port }), run: planned.run, componentOutputs: {} });
    expect(ran.notStarted).toEqual(["a", "b"]);
    expect(ran.outcomes).toEqual({ a: "not-started", b: "not-started" });
    expect(ran.results.every((r) => r.records[0]!.held === true)).toBe(true);
    expect(w.applied).toEqual([]);
    expect(failedRunExitCode(ran.results)).toBe(5);
  });

  test("a group applied without a lease port takes none, as a pull request's apply runs it", async () => {
    const w = world();
    const planned = await planComponentGroup({ group: GROUP, components: byName, registry: w.registry, env: "prod", ctxOf: (name) => ({ env: "prod", component: name }), outputs: {} });
    const ran = await runComponentGroup({ group: GROUP, components: byName, registry: w.registry, env: "prod", ctxOf: (name) => ({ env: "prod", component: name }), run: planned.run, componentOutputs: {} });
    expect(ran.outcomes).toEqual({ a: "applied", b: "applied" });
  });
});

describe("components fan-out leases on the resource grain", () => {
  const ESTATE = [res("net"), res("app", ["net"], { upstream: so("net", "id") })];

  test("without a wave gate each component's step leases its own rows", async () => {
    const w = world();
    const { port, log } = memoryPort();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const result = await runFanOut(plan, ESTATE, w.registry, { env: "prod", gates: memoryGateLedgerPort(), rowLease: port });
    expect(result.status).toBe("ok");
    expect(log.takes).toEqual([
      { label: "net", keys: ["row net"] },
      { label: "app", keys: ["row app"] },
    ]);
  });

  test("a held row fails its component, blocks what depends on it, and the fan-out exits 5", async () => {
    const w = world();
    const { port } = memoryPort(["row net"]);
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const result = await runFanOut(plan, ESTATE, w.registry, { env: "prod", gates: memoryGateLedgerPort(), rowLease: port });
    expect(result.status).toBe("fail");
    expect(result.failed).toEqual(["net"]);
    expect(result.blocked.map((b) => b.component)).toEqual(["app"]);
    expect(failedRunExitCode(result.results)).toBe(5);
  });

  test("under a wave gate the wave leases the rows its approved plans lock, once, and its steps take none of their own", async () => {
    const w = world();
    const { port, log } = memoryPort();
    w.live = log.live;
    const plan = planFanOut({ components: [res("net")], changed: ["net"] });
    const ledgerOf = (pending: PendingGateRecord[] = [], resolutions: Array<Partial<GateResolutionRecord>> = []) =>
      memoryGateLedgerPort({ pending, resolutions: resolutions.map((r) => ({ version: 1 as const, kind: "resolution" as const, op: "fan-out", gate: "release-wave-1", resolvedBy: "ana", timestamp: LATER, ...r })) });
    const options = { env: "prod", now: NOW, waveGate: { op: "fan-out", gate: "release" }, rowLease: port };
    const first = await runFanOut(plan, [res("net")], w.registry, { ...options, gates: ledgerOf() });
    expect(first.status).toBe("gated");
    expect(log.takes).toEqual([]);
    const approved = await runFanOut(plan, [res("net")], w.registry, { ...options, gates: ledgerOf([first.gate!], [{ planDigest: first.gate!.planDigest! }]) });
    expect(approved.status).toBe("ok");
    expect(log.takes).toEqual([{ label: "wave 1", keys: ["row net"] }]);
    expect(w.heldWhileApplying).toEqual({ net: true });
    expect(w.fromPlan).toEqual({ net: true });
    expect(log.releases).toEqual(["wave 1"]);
  });

  test("under a wave gate a held row fails the wave's components and exits 5", async () => {
    const w = world();
    const { port } = memoryPort(["row net"]);
    const plan = planFanOut({ components: [res("net")], changed: ["net"] });
    const resolutions = (digest: string) => [{ version: 1 as const, kind: "resolution" as const, op: "fan-out", gate: "release-wave-1", resolvedBy: "ana", timestamp: LATER, planDigest: digest }];
    const first = await runFanOut(plan, [res("net")], w.registry, { env: "prod", now: NOW, waveGate: { op: "fan-out", gate: "release" }, gates: memoryGateLedgerPort() });
    const held = await runFanOut(plan, [res("net")], w.registry, {
      env: "prod",
      now: NOW,
      waveGate: { op: "fan-out", gate: "release" },
      rowLease: port,
      gates: memoryGateLedgerPort({ pending: [first.gate!], resolutions: resolutions(first.gate!.planDigest!) }),
    });
    expect(held.status).toBe("fail");
    expect(held.waves?.at(-1)).toMatchObject({ wave: 1, status: "failed" });
    expect(w.applied).toEqual([]);
    expect(failedRunExitCode(held.results)).toBe(5);
  });

  test("a fan-out handed plans made beforehand refuses a lease port: its caller leases those rows", async () => {
    const w = world();
    const { port } = memoryPort();
    const plan = planFanOut({ components: [res("net")], changed: ["net"] });
    await expect(runFanOut(plan, [res("net")], w.registry, { env: "prod", plans: { net: {} }, rowLease: port })).rejects.toThrow(/takes no row lease/);
  });
});

describe("a later pr-apply round is leased again", () => {
  /** net, and app reading its id, which net's plan knows only after apply. */
  const ESTATE = [res("net"), res("app", ["net"], { upstream: so("net", "id") })];
  const plan = () => planFanOut({ components: ESTATE, changed: ["net"] });
  const approveRound = async ({ gate, set }: { gate: string; set: PrPlanSet }) => {
    const ledger = memoryGateLedgerPort({ resolutions: [{ version: 1, kind: "resolution", op: "pr-12", gate, resolvedBy: "github:rev", timestamp: LATER, planDigest: set.doc.digest }] });
    const check = await decidePrGate(readOnlyLedger(ledger), { op: "pr-12", gate, digest: set.doc.digest, now: NOW });
    return { satisfied: check.satisfied, approval: approvalOf(check) };
  };

  const setUp = async () => {
    const w = world();
    w.versions.net = "v2";
    w.predict.net = () => ({ known: {}, unknown: ["id"] });
    const set = await planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
    return { w, set };
  };

  test("round 2 leases the rows its own plan locks before it applies, and lets go after", async () => {
    const { w, set } = await setUp();
    const rounds: Array<{ round: number; keys: string[] }> = [];
    let released = 0;
    const applied = await applyPrSet({
      components: ESTATE,
      plan: plan(),
      registry: w.registry,
      env: "prod",
      set,
      decideRound: approveRound,
      leaseRound: async ({ round, set: roundSet }) => {
        rounds.push({ round, keys: Object.values(roundSet.locks ?? {}).flatMap((l) => l.rows.map((r) => r.key)) });
        return { release: async () => ((released += 1), true) };
      },
    });
    expect(applied.status).toBe("applied");
    expect(rounds).toEqual([{ round: 2, keys: ["row app"] }]);
    expect(released).toBe(1);
    expect(w.applied).toEqual(["net", "app"]);
  });

  test("a round whose rows another run holds does not apply: the round says held and the result names the run", async () => {
    const { w, set } = await setUp();
    const applied = await applyPrSet({
      components: ESTATE,
      plan: plan(),
      registry: w.registry,
      env: "prod",
      set,
      decideRound: approveRound,
      leaseRound: async () => ({ held: "run 4711 is applying app: res.x, so nothing of round 2 was applied" }),
    });
    expect(w.applied).toEqual(["net"]);
    expect(applied.status).toBe("waiting");
    expect(applied.held).toContain("run 4711");
    expect(applied.rounds?.map((r) => [r.round, r.status, r.message])).toEqual([[2, "held", "run 4711 is applying app: res.x, so nothing of round 2 was applied"]]);
  });

  test("a round whose rows file cannot be written fails the apply with the reason", async () => {
    const { w, set } = await setUp();
    const applied = await applyPrSet({
      components: ESTATE,
      plan: plan(),
      registry: w.registry,
      env: "prod",
      set,
      decideRound: approveRound,
      leaseRound: async () => ({ failed: "could not hold the rows round 2 changes in pr-apply" }),
    });
    expect(applied.status).toBe("failed");
    expect(applied.leaseFailed).toContain("round 2");
    expect(applied.rounds?.[0]?.status).toBe("failed");
  });
});

describe("the ledger port", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repo = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-row-lease-")));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@chant.dev");
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "README.md"), "# t\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "init");
    return dir;
  };
  const row = (key: string): LockRow => ({ key, target: "e01", address: key });
  const quiet = () => undefined;

  test("two steps of one run that share a row keep it until both end", async () => {
    const cwd = repo();
    const port = ledgerRowLease("pr-apply", { cwd, holder: { run: "100", at: NOW }, alive: async () => "alive", log: quiet });
    const one = await port.take([row("object vpc-1"), row("estate e01 a")], "net");
    const two = await port.take([row("object vpc-1"), row("estate e01 b")], "app");
    expect(Object.keys((await readLockRows("pr-apply", { cwd })).rows).sort()).toEqual(["estate e01 a", "estate e01 b", "object vpc-1"]);
    await one.release();
    expect(Object.keys((await readLockRows("pr-apply", { cwd })).rows).sort()).toEqual(["estate e01 b", "object vpc-1"]);
    await two.release();
    expect((await readLockRows("pr-apply", { cwd })).rows).toEqual({});
  });

  test("another live run's row refuses the take with a held error naming that run", async () => {
    const cwd = repo();
    const other = ledgerRowLease("pr-apply", { cwd, holder: { run: "200", at: NOW, url: "https://forge.example/runs/200" }, alive: async () => "alive", log: quiet });
    await other.take([row("estate e01 a")], "net");
    const mine = ledgerRowLease("pr-apply", { cwd, holder: { run: "300", at: NOW }, alive: async () => "alive", log: quiet });
    const err = await mine.take([row("estate e01 a")], "net").catch((e: unknown) => e);
    expect(isLockRowsHeldError(err)).toBe(true);
    expect((err as Error).message).toContain("run 200 (https://forge.example/runs/200)");
  });
});
