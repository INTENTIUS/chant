/**
 * Gated waves on a fan-out (#3049): one gate per wave, each bound to the
 * wave's set digest, each wave planned once the waves before it applied.
 *
 * The capability here stands in for `terraform-apply`: `plan` returns the
 * root and a digest over what it would write (its own `version` and every
 * input), `run` applies, records what it applied and exposes an output.
 */

import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type DeployContext } from "./capability";
import { memoryGateLedgerPort } from "../op/gate";
import { planFanOut } from "./fan-out";
import { EarlierWaveNotAppliedError, runFanOut, type FanOutRunOptions } from "./fan-out-run";
import { computePlanDigest } from "../lifecycle/plan-digest";
import type { DriverComponent } from "./driver";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";

interface RootInput {
  root: string;
  version?: string;
  vars?: Record<string, unknown>;
}

/** A component deploying one root. `vars` may wire another root's output. */
const root = (name: string, dependsOn?: string[], vars?: Record<string, unknown>): DriverComponent => ({
  name,
  deploy: [{ phase: "Apply", steps: [{ kind: "fake-root", root: name, ...(vars ? { vars } : {}) }] }],
  ...(dependsOn ? { dependsOn } : {}),
});

/** net → a, b; app reads a's output. */
const ESTATE: DriverComponent[] = [
  root("net"),
  root("a", ["net"]),
  root("b", ["net"]),
  root("app", ["a"], { upstream: { stackOutput: { stack: "a", name: "id" } } }),
];

interface World {
  registry: CapabilityRegistry;
  /** Roots applied, in order. */
  applied: string[];
  /** Each plan call: the root and the inputs it planned with. */
  planned: Array<{ root: string; vars?: Record<string, unknown> }>;
  /** Each apply: whether it applied the wave's own plan. */
  fromPlan: Record<string, boolean>;
  /** What each root would write: change one to "change a root". */
  versions: Record<string, string>;
  failing: Set<string>;
}

function world(): World {
  const w: World = {
    registry: new CapabilityRegistry(),
    applied: [],
    planned: [],
    fromPlan: {},
    versions: {},
    failing: new Set(),
  };
  const digestOf = (input: RootInput) =>
    computePlanDigest("fake-root", { root: input.root, version: w.versions[input.root] ?? "v1", vars: input.vars ?? null });
  w.registry.register({
    kind: "fake-root",
    async plan(_ctx: DeployContext, input: RootInput) {
      w.planned.push({ root: input.root, ...(input.vars ? { vars: input.vars } : {}) });
      const planDigest = digestOf(input);
      return { member: input.root, planDigest, artifact: { planDigest } };
    },
    async run(ctx: DeployContext, input: RootInput) {
      w.fromPlan[input.root] = ctx.plans?.[input.root] !== undefined;
      if (w.failing.has(input.root)) throw new Error(`${input.root} failed`);
      w.applied.push(input.root);
      return { outputs: { id: `${input.root}-id-${w.versions[input.root] ?? "v1"}` } };
    },
  } as never);
  return w;
}

const NOW = "2026-10-03T00:00:00Z";
const LATER = "2026-10-03T01:00:00Z";

/** A ledger that has seen `pending` and then the approvals in `resolutions`, as `chant approve` writes them. */
function ledger(pending: PendingGateRecord[] = [], resolutions: Array<Partial<GateResolutionRecord>> = []) {
  return memoryGateLedgerPort({
    pending,
    resolutions: resolutions.map((r) => ({
      version: 1 as const,
      kind: "resolution" as const,
      op: "fan-out",
      gate: "release-wave-1",
      resolvedBy: "ana",
      timestamp: LATER,
      ...r,
    })),
  });
}

const waveOptions = (gates: ReturnType<typeof memoryGateLedgerPort>, extra: Partial<FanOutRunOptions> = {}): FanOutRunOptions => ({
  env: "test",
  gates,
  now: NOW,
  waveGate: { op: "fan-out", gate: "release" },
  ...extra,
});

describe("binding: each wave's gate names that wave's set digest", () => {
  test("an unapproved first wave stops the run with its digest pending, and nothing applies", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const gates = ledger();

    const result = await runFanOut(plan, ESTATE, w.registry, waveOptions(gates));

    expect(result.status).toBe("gated");
    expect(w.applied).toEqual([]);
    // Only wave 1 was planned: later waves read outputs it has not written.
    expect(w.planned.map((p) => p.root)).toEqual(["net"]);
    expect(result.gate?.gate).toBe("release-wave-1");
    expect(result.gate?.planDigest).toBe(result.waves?.[0]?.digest);
    expect(result.waves).toMatchObject([{ wave: 1, status: "gated", members: [{ member: "net" }] }]);
  });

  test("an approval with no digest, or with another wave's, does not let the wave through", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const first = await runFanOut(plan, ESTATE, w.registry, waveOptions(ledger()));
    const pending = [first.gate!];

    const noDigest = await runFanOut(plan, ESTATE, w.registry, waveOptions(ledger(pending, [{}])));
    expect(noDigest.status).toBe("gated");

    const otherWave = "jcs1-sha256:" + "9".repeat(64);
    const wrong = await runFanOut(plan, ESTATE, w.registry, waveOptions(ledger(pending, [{ planDigest: otherWave }])));
    expect(wrong.status).toBe("gated");
    expect(wrong.waves?.[0]?.approved).toBe(otherWave);

    // Wave 1's digest approved under wave 2's gate does not answer wave 1 either.
    const misfiled = await runFanOut(
      plan,
      ESTATE,
      w.registry,
      waveOptions(ledger(pending, [{ gate: "release-wave-2", planDigest: first.gate!.planDigest! }])),
    );
    expect(misfiled.status).toBe("gated");
    expect(w.applied).toEqual([]);
  });

  test("approving wave 1's digest applies wave 1, then stops at wave 2 with its own digest", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const first = await runFanOut(plan, ESTATE, w.registry, waveOptions(ledger()));

    const result = await runFanOut(
      plan,
      ESTATE,
      w.registry,
      waveOptions(ledger([first.gate!], [{ planDigest: first.gate!.planDigest! }])),
    );

    expect(w.applied).toEqual(["net"]);
    expect(w.fromPlan.net).toBe(true);
    expect(result.status).toBe("gated");
    expect(result.completed).toEqual(["net"]);
    expect(result.gate?.gate).toBe("release-wave-2");
    expect(result.waves?.map((r) => [r.wave, r.status])).toEqual([[1, "applied"], [2, "gated"]]);
    expect(result.waves?.[1]?.digest).not.toBe(result.waves?.[0]?.digest);
  });
});

describe("changed set: approve wave 1, change a root, re-run", () => {
  test("the run stops naming the approved digest and the new one, and applies nothing", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const first = await runFanOut(plan, ESTATE, w.registry, waveOptions(ledger()));
    const approved = first.gate!.planDigest!;

    w.versions.net = "v2";
    const result = await runFanOut(plan, ESTATE, w.registry, waveOptions(ledger([first.gate!], [{ planDigest: approved }])));

    expect(result.status).toBe("gated");
    expect(w.applied).toEqual([]);
    const wave = result.waves![0]!;
    expect(wave.approved).toBe(approved);
    expect(wave.digest).not.toBe(approved);
    // The new plan is recorded pending, so the next `chant approve` approves what will run.
    expect(result.gate?.planDigest).toBe(wave.digest);
  });
});

/**
 * A ledger where every pending wave is approved for exactly the digest it was
 * recorded with: each wave stops once, the next attempt passes it.
 */
function approvingLedger() {
  const gates = memoryGateLedgerPort();
  return {
    ...gates,
    async read() {
      const { pending } = await gates.read("fan-out");
      return {
        pending,
        resolutions: pending.map((p) => ({
          version: 1 as const,
          kind: "resolution" as const,
          op: p.op,
          gate: p.gate,
          resolvedBy: "ana",
          timestamp: LATER,
          planDigest: p.planDigest!,
        })),
      };
    },
  };
}

/** Re-run until the fan-out stops gating, carrying progress and outputs the way `--resume` does. */
async function runToEnd(w: World, plan: ReturnType<typeof planFanOut>, components: DriverComponent[]) {
  const gates = approvingLedger();
  let outputs: Record<string, Record<string, unknown>> = {};
  let result;
  for (let i = 0; i < 8; i++) {
    result = await runFanOut(plan, components, w.registry, {
      ...waveOptions(memoryGateLedgerPort()),
      gates,
      progress: { completed: [...w.applied] },
      componentOutputs: outputs,
    });
    outputs = result.componentOutputs;
    if (result.status !== "gated") break;
  }
  return result!;
}

describe("planned at the wave", () => {
  test("a root that reads an upstream output plans with the value the upstream wave wrote", async () => {
    const w = world();
    w.versions.a = "v7";
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });

    const result = await runToEnd(w, plan, ESTATE);

    expect(result.status).toBe("ok");
    const appPlans = w.planned.filter((p) => p.root === "app");
    expect(appPlans.length).toBeGreaterThan(0);
    expect(appPlans.every((p) => p.vars?.upstream === "a-id-v7")).toBe(true);
  });

  test("each wave is planned after the wave before it applied, never up front", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const events: string[] = [];
    const registry = w.registry;
    const capability = registry.resolve("fake-root") as unknown as {
      plan: (ctx: DeployContext, input: RootInput) => Promise<unknown>;
      run: (ctx: DeployContext, input: RootInput) => Promise<unknown>;
    };
    const plan0 = capability.plan.bind(capability);
    const run0 = capability.run.bind(capability);
    capability.plan = async (ctx, input) => (events.push(`plan ${input.root}`), plan0(ctx, input));
    capability.run = async (ctx, input) => (events.push(`apply ${input.root}`), run0(ctx, input));

    const result = await runToEnd(w, plan, ESTATE);

    expect(result.status).toBe("ok");
    expect(w.applied).toEqual(["net", "a", "b", "app"]);
    const first = (e: string) => events.indexOf(e);
    expect(first("plan a")).toBeGreaterThan(first("apply net"));
    expect(first("plan b")).toBeGreaterThan(first("apply net"));
    expect(first("plan app")).toBeGreaterThan(first("apply a"));
  });
});

describe("canary", () => {
  test("a canary list is wave 1 and is gated first; the remaining waves follow the graph", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"], canary: ["b"] });
    expect(plan.waves).toEqual([["b"], ["net"], ["a"], ["app"]]);

    const result = await runFanOut(plan, ESTATE, w.registry, waveOptions(ledger()));
    expect(result.gate?.gate).toBe("release-wave-1");
    expect(result.waves?.[0]?.members.map((m) => m.member)).toEqual(["b"]);
  });
});

describe("resume", () => {
  test("a run stopped at wave 2's gate resumes there and never re-applies wave 1", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const first = await runFanOut(plan, ESTATE, w.registry, waveOptions(ledger()));
    const second = await runFanOut(
      plan,
      ESTATE,
      w.registry,
      waveOptions(ledger([first.gate!], [{ planDigest: first.gate!.planDigest! }])),
    );
    expect(second.gate?.gate).toBe("release-wave-2");
    expect(w.applied).toEqual(["net"]);

    const third = await runFanOut(
      plan,
      ESTATE,
      w.registry,
      waveOptions(
        ledger([first.gate!, second.gate!], [
          { planDigest: first.gate!.planDigest! },
          { gate: "release-wave-2", planDigest: second.gate!.planDigest! },
        ]),
        { progress: { completed: second.completed } },
      ),
    );
    // Wave 2 ran; wave 1 did not run again. Wave 3 is next.
    expect(w.applied).toEqual(["net", "a", "b"]);
    expect(third.gate?.gate).toBe("release-wave-3");
    expect(third.waves?.map((r) => r.wave)).toEqual([2, 3]);
  });

  test("after a failed root, the retry applies only what is left, and its dependents wait for it", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    w.failing.add("a");

    const failed = await runToEnd(w, plan, ESTATE);
    expect(failed.status).toBe("fail");
    expect(w.applied).toEqual(["net", "b"]);
    expect(failed.blocked).toEqual([{ component: "app", reason: "blocked", blockedBy: "a" }]);
    expect(failed.waves?.find((r) => r.wave === 2)).toMatchObject({ status: "failed", failed: [{ component: "a" }] });

    w.failing.clear();
    const retried = await runToEnd(w, plan, ESTATE);
    expect(retried.status).toBe("ok");
    // net and b did not apply a second time.
    expect(w.applied).toEqual(["net", "b", "a", "app"]);
  });
});

describe("one wave per CI job", () => {
  test("--wave 2 refuses while wave 1 has work left, and runs only wave 2 once it has applied", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    await expect(
      runFanOut(plan, ESTATE, w.registry, { ...waveOptions(ledger()), waveGate: { op: "fan-out", gate: "release", only: 2 } }),
    ).rejects.toThrow(EarlierWaveNotAppliedError);

    const result = await runFanOut(plan, ESTATE, w.registry, {
      ...waveOptions(ledger()),
      waveGate: { op: "fan-out", gate: "release", only: 2 },
      progress: { completed: ["net"] },
    });
    expect(result.gate?.gate).toBe("release-wave-2");
    expect(result.waves?.map((r) => r.wave)).toEqual([2]);
    expect(w.planned.map((p) => p.root).sort()).toEqual(["a", "b"]);
  });
});

describe("both modes", () => {
  test("a run takes one gate over the set or one per wave, not both", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    await expect(
      runFanOut(plan, ESTATE, w.registry, { ...waveOptions(ledger()), gate: { op: "fan-out", gate: "release" } }),
    ).rejects.toThrow(/not both/);
  });

  test("a component with no plannable step is a member under its composition digest", async () => {
    const w = world();
    w.registry.register({ kind: "plain", async run() { return {}; } } as never);
    const estate: DriverComponent[] = [{ name: "svc", deploy: [{ phase: "Deploy", steps: [{ kind: "plain" }] }] }];
    const plan = planFanOut({ components: estate, changed: ["svc"] });
    const result = await runFanOut(plan, estate, w.registry, waveOptions(ledger()));
    expect(result.waves?.[0]?.members.map((m) => m.member)).toEqual(["svc"]);
    expect(result.waves?.[0]?.members[0]?.planDigest).toMatch(/^jcs1-sha256:/);
  });
});

describe("carried state (#3459): what a step keeps for its member reaches the next attempt", () => {
  function carryingRegistry(seen: Array<unknown>, failing: Set<string>) {
    const registry = new CapabilityRegistry();
    registry.register({
      kind: "fake-root",
      async plan(_ctx: DeployContext, input: RootInput) {
        return { member: input.root, planDigest: `d-${input.root}`, artifact: {} };
      },
      async run(ctx: DeployContext, input: RootInput) {
        seen.push(ctx.carried?.[input.root]);
        ctx.carry?.(input.root, { attempt: (ctx.carried?.[input.root] as { attempt?: number } | undefined)?.attempt ?? 0 });
        if (failing.has(input.root)) throw new Error(`${input.root} failed`);
        return { outputs: {} };
      },
    } as never);
    return registry;
  }

  /** Wave 1 over `net` alone, approved for the digest it plans to. */
  async function approvedNet() {
    const components = [root("net")];
    const plan = planFanOut({ components, changed: ["net"] });
    const first = await runFanOut(plan, components, carryingRegistry([], new Set()), waveOptions(ledger()));
    expect(first.status).toBe("gated");
    const gates = () => ledger([first.gate!], [{ planDigest: first.gate!.planDigest! }]);
    return { components, plan, gates };
  }

  test("a failed root's carried value is kept, and handed back on the next attempt", async () => {
    const { components, plan, gates } = await approvedNet();
    const seen: unknown[] = [];
    const kept: Record<string, unknown> = {};

    const failed = await runFanOut(plan, components, carryingRegistry(seen, new Set(["net"])), waveOptions(gates(), { onCarry: (m, v) => (kept[m] = v) }));
    expect(failed.status).toBe("fail");
    expect(seen).toEqual([undefined]);
    expect(kept).toEqual({ net: { attempt: 0 } });

    const retried = await runFanOut(plan, components, carryingRegistry(seen, new Set()), waveOptions(gates(), { carried: { net: { attempt: 1 } } }));
    expect(retried.status).toBe("ok");
    expect(seen).toEqual([undefined, { attempt: 1 }]);
  });

  test("without onCarry a step gets no carry, and runs as before", async () => {
    const { components, plan, gates } = await approvedNet();
    const result = await runFanOut(plan, components, carryingRegistry([], new Set()), waveOptions(gates()));
    expect(result.status).toBe("ok");
  });
});
