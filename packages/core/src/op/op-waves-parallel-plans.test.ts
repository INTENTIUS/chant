/**
 * A step wave's runs planned `parallelism` at once (#4864), as they apply,
 * with the wave's serial section on each run's context
 * (`DeployContext.serial`). A fake capability with a delay per root records
 * how many plans, applies and serial sections are in flight; the wave's
 * digest, members, plan files, run hooks and after-plan runs must come out
 * as one at a time makes them.
 */

import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { opWavePlanPath, runOpWave, type OpWaveShowAtBase } from "./op-waves-run";
import type { OpWavesSpec } from "./op-waves";
import type { OpWaveRunHooks } from "./op-waves-run-hooks";
import type { OpWaveAfterPlanHook } from "./op-waves-after-plan";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability, type CapabilityPlan, type DeployContext } from "../components/capability";
import { keyedSerial } from "../parallelism";

const ROOTS = ["a", "b", "c", "d"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A gauge of how many of something are in flight, and the most there ever were. */
function gauge() {
  const g = { now: 0, most: 0 };
  return {
    g,
    async in<T>(fn: () => Promise<T>): Promise<T> {
      g.now++;
      g.most = Math.max(g.most, g.now);
      try {
        return await fn();
      } finally {
        g.now--;
      }
    },
  };
}

/**
 * A capability whose plan takes an "init" through `ctx.serial` under one key,
 * then plans; the first root plans slowest, so plans at once finish in the
 * other order. `fail` roots throw from their plan after `failAfterMs`.
 */
function capability(opts: { fail?: Record<string, number> } = {}) {
  const plans = gauge();
  const inits = gauge();
  const applies = gauge();
  const seen = { serial: [] as boolean[], planned: [] as string[] };
  const delay = (root: string) => (ROOTS.length - ROOTS.indexOf(root)) * 15;
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(ctx: DeployContext, input) {
      const root = String(input.root);
      seen.serial.push(typeof ctx.serial === "function");
      const init = () => inits.in(() => sleep(10));
      await (ctx.serial ? ctx.serial("plugin-cache", init) : init());
      return plans.in(async (): Promise<CapabilityPlan> => {
        const failAfter = opts.fail?.[root];
        if (failAfter !== undefined) {
          await sleep(failAfter);
          throw new Error(`${root} broke`);
        }
        await sleep(delay(root));
        seen.planned.push(root);
        const planDigest = `sha256:${String(ROOTS.indexOf(root) + 1).repeat(64)}`;
        return { member: root, planDigest, artifact: { root }, changeSet: { member: { member: root, lexicon: "terraform", planner: "chant", status: "planned", planDigest, holes: [] }, entries: [{ member: root, lexicon: "terraform", planner: "chant", address: `x.${root}`, type: "x", action: "create", attributes: [] }] } };
      });
    },
    async run(ctx: DeployContext, input) {
      const root = String(input.root);
      const init = () => inits.in(() => sleep(5));
      await (ctx.serial ? ctx.serial("plugin-cache", init) : init());
      return applies.in(async () => {
        await sleep(delay(root));
        return { applied: root };
      });
    },
  };
  return { registry: new CapabilityRegistry().register(cap), plans: plans.g, inits: inits.g, applies: applies.g, seen };
}

const spec = (parallelism: number | undefined): OpWavesSpec => ({
  name: "roots",
  op: "tf-apply",
  ...(parallelism !== undefined ? { parallelism } : {}),
  step: { kind: "fake-apply", root: "{target}" },
  waves: [{ name: "dev", runs: ROOTS.map((target) => ({ target })), gate: "never" }],
});

async function wave(s: OpWavesSpec, registry: CapabilityRegistry, o: { runHooks?: OpWaveRunHooks; afterPlan?: OpWaveAfterPlanHook } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-par-plans-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(s) });
  const log: string[] = [];
  try {
    const result = await runOpWave({ spec: s, specFile: "waves.json", wave: 1, cwd, show, gates: memoryGateLedgerPort(), capabilities: registry, log: (l) => log.push(l), ...o });
    const files = ROOTS.map((r) => {
      const f = join(cwd, opWavePlanPath(s, 1, r));
      return existsSync(f) ? readFileSync(f, "utf-8") : undefined;
    });
    return { result, files, log };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("a step wave's runs planned at once (#4864)", () => {
  test("up to parallelism plans run at once, and the serial section keeps the inits to one at a time", async () => {
    const c = capability();
    const { result } = await wave(spec(3), c.registry);
    expect(result).toMatchObject({ exitCode: 0, applied: ROOTS });
    expect(c.plans.most).toBe(3);
    expect(c.applies.most).toBe(3);
    expect(c.inits.most).toBe(1);
    expect(c.seen.serial).toEqual([true, true, true, true]);
    // The first root plans slowest, so it is not the first to finish.
    expect(c.seen.planned[0]).not.toBe("a");
  });

  test("the digest, members, plan files, run hooks and after-plan runs come out as one at a time makes them", async () => {
    const take = async (parallelism: number | undefined) => {
      const c = capability();
      const before: string[] = [];
      const after: string[] = [];
      const runHooks: OpWaveRunHooks = { name: "product", beforePlan: (r) => void before.push(r.target) };
      const afterPlan: OpWaveAfterPlanHook = { name: "report", run: (p) => void after.push(`${p.target} ${p.planDigest}`) };
      const got = await wave(spec(parallelism), c.registry, { runHooks, afterPlan });
      return { c, got, before, after };
    };
    const one = await take(undefined);
    const many = await take(4);
    expect(one.c.plans.most).toBe(1);
    expect(many.c.plans.most).toBe(4);
    expect(many.got.result.decision?.digest).toBe(one.got.result.decision?.digest);
    expect(many.got.result.decision?.members).toEqual(one.got.result.decision?.members);
    expect(many.got.result.decision?.members.map((m) => m.member)).toEqual(ROOTS);
    expect(many.got.files).toEqual(one.got.files);
    expect(many.got.files.every((f) => f !== undefined)).toBe(true);
    expect(many.after).toEqual(one.after);
    expect([...many.before].sort()).toEqual(one.before);
    expect(many.got.result.applied).toEqual(one.got.result.applied);
    // One at a time, a run's context has no serial section.
    expect(one.c.seen.serial).toEqual([false, false, false, false]);
  });

  test("a failing plan fails the wave with the first failing run in the wave's order, though a later one failed first", async () => {
    const c = capability({ fail: { b: 40, c: 1 } });
    // c's init takes its turn after b's and fails at once; b fails later, and it is the one one at a time stops at.
    await expect(wave(spec(4), c.registry)).rejects.toThrow(/^planning b through fake-apply failed: b broke$/);
  });

  test("a plan that fails starts no more plans", async () => {
    const c = capability({ fail: { a: 1 } });
    await expect(wave(spec(2), c.registry)).rejects.toThrow(/planning a through fake-apply failed/);
    // a fails beside b, which finishes; c and d never start.
    expect(c.seen.planned).toEqual(["b"]);
  });
});

describe("keyedSerial (#4864)", () => {
  test("one call per key at a time, other keys beside it, and a failure is the call's own", async () => {
    const serial = keyedSerial();
    const same = gauge();
    const order: string[] = [];
    const call = (key: string, name: string, ms: number, fail = false) =>
      serial(key, () =>
        same.in(async () => {
          await sleep(ms);
          order.push(name);
          if (fail) throw new Error(name);
          return name;
        }),
      );
    const other = serial("other", async () => {
      order.push("other");
      return "other";
    });
    const got = await Promise.allSettled([call("k", "k1", 30, true), call("k", "k2", 5), other]);
    expect(got.map((g) => g.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(order).toEqual(["other", "k1", "k2"]);
    expect(same.g.most).toBe(1);
  });
});
