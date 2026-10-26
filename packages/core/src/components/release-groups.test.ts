/**
 * Composed runs at promote, fan-out and `run --components` (ws-107, #4465),
 * against a fake capability: `fake-stack` creates one resource and exposes an
 * `id` known only after it applies. With `group` it declares `planGroup` and
 * `runGroup`; without, it plans and applies component by component, as
 * before. The pull-request run's groups are in `pr-run.test.ts`.
 */

import { describe, expect, test } from "vitest";
import {
  CapabilityRegistry,
  type CapabilityGroupOutcome,
  type DeployContext,
  type GroupContext,
  type GroupMember,
  type GroupRun,
  type PlannedOutputs,
} from "./capability";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { isEmptyChangeSet } from "../change-set";
import { makeRelease, type Release } from "../lifecycle/release-store";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import { memoryGateLedgerPort } from "../op/gate";
import { runInterpretDriver, type DriverComponent, type DriverRunResult, type ReleaseGateBinding } from "./driver";
import { remainingFanOut } from "./fan-out";
import { runFanOut } from "./fan-out-run";
import { componentSetFanOut, formRunGroups, planAndRunComponentGroup, regroupRemaining, WAVE_GATE_FALLBACK } from "./groups";
import { runPromotion, type PromotionPlan } from "./promote";
import { runPromotionInRounds } from "./promote-rounds";
import { planReleaseSet } from "./release-gate";
import { renderRunGroups, runGroupsReport } from "./run-groups";

interface StackInput {
  root: string;
  vars?: Record<string, unknown>;
}

const so = (stack: string, name: string) => ({ stackOutput: { stack, name } });
const sha = (c: string) => `sha256:${c.repeat(64)}`;

const stack = (name: string, dependsOn: string[] = [], vars?: Record<string, unknown>): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "fake-stack", root: name, ...(vars ? { vars } : {}) }] }],
});
/** a; b reads a's new id; c reads b's. */
const ABC = [stack("a"), stack("b", ["a"], { upstream: so("a", "id") }), stack("c", ["b"], { upstream: so("b", "id") })];

function world(opts: { group?: boolean } = {}) {
  const w = {
    registry: new CapabilityRegistry(),
    planned: [] as string[],
    applied: [] as string[],
    planGroupCalls: [] as string[][],
    runGroupCalls: [] as Array<{ components: string[]; run: GroupRun }>,
    outcome: undefined as ((members: readonly GroupMember[]) => CapabilityGroupOutcome) | undefined,
  };
  const planOf = (input: StackInput) => {
    const planDigest = computePlanDigest("fake-stack", { root: input.root, vars: input.vars ?? null });
    const outputs: PlannedOutputs = { known: {}, unknown: ["id"] };
    return {
      member: input.root,
      planDigest,
      artifact: { planDigest },
      outputs,
      changeSet: {
        member: { member: input.root, lexicon: "test", planner: "tofu" as const, status: "planned" as const, planDigest, holes: [] },
        entries: [{ member: input.root, lexicon: "test", planner: "tofu" as const, address: "res.x", type: "res", action: "create" as const, attributes: [] }],
      },
    };
  };
  w.registry.register({
    kind: "fake-stack",
    async plan(_ctx: DeployContext, input: StackInput) {
      w.planned.push(input.root);
      return planOf(input);
    },
    async run(_ctx: DeployContext, input: StackInput) {
      w.applied.push(input.root);
      return { outputs: { id: `${input.root}-id` } };
    },
    ...(opts.group
      ? {
          async planGroup(_ctx: GroupContext, members: readonly GroupMember<StackInput>[]) {
            w.planGroupCalls.push(members.map((m) => m.component));
            return {
              members: Object.fromEntries(members.map((m) => [m.component, planOf(m.input!)])),
              digest: computePlanDigest("fake-composition", members.map((m) => m.component)),
              artifact: { composed: members.map((m) => m.component) },
            };
          },
          async runGroup(_ctx: GroupContext, run: GroupRun, members: readonly GroupMember<StackInput>[]) {
            w.runGroupCalls.push({ components: members.map((m) => m.component), run });
            if (w.outcome) return w.outcome(members);
            return { members: Object.fromEntries(members.map((m) => [m.component, { status: "applied" as const, outputs: { id: `${m.component}-id` } }])) };
          },
        }
      : {}),
  } as never);
  return w;
}

const release = (): Release =>
  makeRelease({
    member: null,
    commit: "a".repeat(40),
    artifactDigests: [],
    targets: [{ env: "prod", templates: [], params: [] }],
  });

const source = (component: string): ReleaseRecord => ({
  version: 1,
  component,
  env: "staging",
  digest: sha("d"),
  gitSha: "a".repeat(40),
  runId: "run-1",
  timestamp: "2026-10-01T00:00:00.000Z",
  actor: "ci",
});

const promotion = (components: readonly DriverComponent[]): PromotionPlan => ({
  from: "staging",
  to: "prod",
  items: components.map((c) => ({ component: c.name, digest: sha("d"), source: source(c.name) })),
  notPromoted: [],
});

async function grouped(components: DriverComponent[], registry: CapabilityRegistry, waveGate = false) {
  return formRunGroups({ components, plan: componentSetFanOut(components), registry, env: "prod", ...(waveGate ? { waveGate: true } : {}) });
}

async function planned(components: DriverComponent[], registry: CapabilityRegistry, waveGate = false) {
  const plan = await grouped(components, registry, waveGate);
  const set = await planReleaseSet({ release: release(), env: "prod", components, digests: new Map(), registry, current: new Map(), grouped: plan });
  return { plan, set };
}

const binding = (digest: string): ReleaseGateBinding => ({ op: "release", planDigest: digest, releaseDigest: sha("r") });

describe("promote --release plans a group as one (#4465)", () => {
  test("A, B reading A and C reading B: one planGroup call, the group digest in every member's part, no planned outputs between members", async () => {
    const w = world({ group: true });
    const { plan, set } = await planned(ABC, w.registry);
    expect(plan.groups).toEqual([{ capability: "fake-stack", components: ["a", "b", "c"] }]);
    expect(w.planGroupCalls).toEqual([["a", "b", "c"]]);
    expect(w.planned).toEqual([]);
    const digest = set.groups?.[0]?.digest;
    expect(digest).toEqual(expect.stringMatching(/^jcs1-sha256:[0-9a-f]{64}$/));
    expect(set.groups?.[0]?.run?.digest).toBe(digest);
    // The release gate's change set names the group (its digest) on each of its members, and what each reads inside it.
    expect(set.doc.members.map((m) => [m.member, m.status, m.group])).toEqual([
      ["a", "planned", { digest, reads: [] }],
      ["b", "planned", { digest, reads: ["a.id"] }],
      ["c", "planned", { digest, reads: ["b.id"] }],
    ]);
    expect(isEmptyChangeSet(set.doc)).toBe(false);
    // A read of a group-mate is no planned output and no unknown input, so the promote runs no round for it.
    expect(set.plannedOutputs).toBeUndefined();
    expect(set.unknownInputs).toBeUndefined();
  });

  test("without the group pair it plans component by component, as before", async () => {
    const w = world();
    const { plan, set } = await planned(ABC, w.registry);
    expect(plan.groups).toBeUndefined();
    expect(w.planGroupCalls).toEqual([]);
    expect(w.planned).toEqual(["a", "b", "c"]);
    expect(set.groups).toBeUndefined();
    expect(set.doc.members.every((m) => m.group === undefined)).toBe(true);
    expect(set.unknownInputs).toEqual({ b: ["a.id"], c: ["b.id"] });
  });

  test("with --wave-gate no group forms: each member falls back as wave-gate and plans by itself", async () => {
    const w = world({ group: true });
    const { plan, set } = await planned(ABC, w.registry, true);
    expect(plan.groups).toBeUndefined();
    expect(plan.waves).toEqual([["a"], ["b"], ["c"]]);
    expect(plan.fallbacks?.map((f) => [f.component, f.kind])).toEqual([
      ["a", WAVE_GATE_FALLBACK],
      ["b", WAVE_GATE_FALLBACK],
      ["c", WAVE_GATE_FALLBACK],
    ]);
    expect(w.planGroupCalls).toEqual([]);
    expect(w.planned).toEqual(["a", "b", "c"]);
    expect(set.fallbacks).toEqual(plan.fallbacks);
  });
});

describe("promote --release applies a group as one (#4465)", () => {
  test("one runGroup call with the plan the release gate bound, and no round", async () => {
    const w = world({ group: true });
    const { plan, set } = await planned(ABC, w.registry);
    const groupRuns = (set.groups ?? []).map((g) => g.run!);
    const runs: string[][] = [];
    const result = await runPromotionInRounds({
      components: ABC,
      outputs: {},
      binding: binding(set.doc.digest),
      approved: set.doc,
      reads: set.reads,
      grouped: plan,
      replan: async () => {
        throw new Error("no round: nothing is planned again");
      },
      bind: async () => {
        throw new Error("no round: nothing is bound again");
      },
      run: (components, outputs, b) => {
        runs.push(components.map((c) => c.name));
        return runPromotion({
          plan: promotion(components),
          components,
          registry: w.registry,
          componentOutputs: outputs,
          gates: memoryGateLedgerPort(),
          releaseGate: b,
          grouped: plan,
          groupRuns,
        });
      },
    });
    expect(result.stages).toEqual([]);
    expect(runs).toEqual([["a", "b", "c"]]);
    expect(w.runGroupCalls.map((c) => c.components)).toEqual([["a", "b", "c"]]);
    expect(w.runGroupCalls[0]!.run.digest).toBe(set.groups![0]!.digest);
    expect(w.applied).toEqual([]);
    expect(result.run.status).toBe("ok");
    expect(result.completed).toEqual(["a", "b", "c"]);
    expect(result.outputs).toMatchObject({ a: { id: "a-id" }, b: { id: "b-id" }, c: { id: "c-id" } });
  });

  test("a group with no approved plan fails every member unless the promote plans it in its wave", async () => {
    const w = world({ group: true });
    const plan = await grouped(ABC, w.registry);
    const refused = await runPromotion({ plan: promotion(ABC), components: ABC, registry: w.registry, gates: memoryGateLedgerPort(), grouped: plan, groupRuns: [] });
    expect(refused.status).toBe("fail");
    expect(w.runGroupCalls).toEqual([]);
    const ran = await runPromotion({ plan: promotion(ABC), components: ABC, registry: w.registry, gates: memoryGateLedgerPort(), grouped: plan, planGroupsAtWave: true });
    expect(ran.status).toBe("ok");
    expect(w.planGroupCalls).toEqual([["a", "b", "c"]]);
    expect(w.runGroupCalls.map((c) => c.components)).toEqual([["a", "b", "c"]]);
    expect(ran.groupOutcomes).toEqual({ a: "applied", b: "applied", c: "applied" });
  });

  test("without the group pair each component runs its own deploy, as before", async () => {
    const w = world();
    const plan = await grouped(ABC, w.registry);
    const ran = await runPromotion({ plan: promotion(ABC), components: ABC, registry: w.registry, gates: memoryGateLedgerPort(), grouped: plan });
    expect(ran.status).toBe("ok");
    expect(w.applied).toEqual(["a", "b", "c"]);
    expect(ran.groupOutcomes).toBeUndefined();
  });

  test("a resume after the group failed part way plans only the members left, as a smaller group", async () => {
    const w = world({ group: true });
    const plan = await grouped(ABC, w.registry);
    // The first attempt: a applied, b failed, c did not start.
    w.outcome = () => ({
      members: { a: { status: "applied", outputs: { id: "a-id" } }, b: { status: "failed", error: "boom" }, c: { status: "not-started" } },
    });
    const first = await runPromotion({ plan: promotion(ABC), components: ABC, registry: w.registry, gates: memoryGateLedgerPort(), grouped: plan, planGroupsAtWave: true });
    expect(first.status).toBe("fail");
    expect(first.groupOutcomes).toEqual({ a: "applied", b: "failed", c: "not-started" });
    const completed = first.results.filter((r) => r.status === "ok").map((r) => r.component);
    expect(completed).toEqual(["a"]);

    // The resume groups what is left, as the promote handler does, and plans only that.
    w.planGroupCalls.length = 0;
    w.outcome = undefined;
    const left = await regroupRemaining({
      components: ABC,
      plan: remainingFanOut(plan, ABC, { completed }),
      registry: w.registry,
      env: "prod",
      groups: plan.groups,
    });
    expect(left.groups).toEqual([{ capability: "fake-stack", components: ["b", "c"] }]);
    const set = await planReleaseSet({
      release: release(),
      env: "prod",
      components: ABC,
      digests: new Map(),
      registry: w.registry,
      current: new Map(),
      seededOutputs: { a: { id: "a-id" } },
      only: new Set(["b", "c"]),
      grouped: left,
    });
    expect(w.planGroupCalls).toEqual([["b", "c"]]);
    expect(set.doc.members.map((m) => m.member)).toEqual(["b", "c"]);
  });
});

describe("components fan-out and run --components apply a group as one (#4465)", () => {
  test("runFanOut plans a group in its wave and applies it with one runGroup call", async () => {
    const w = world({ group: true });
    const plan = await grouped(ABC, w.registry);
    const result = await runFanOut(plan, ABC, w.registry, { env: "prod", gates: memoryGateLedgerPort(), planGroupsAtWave: true });
    expect(result.status).toBe("ok");
    expect(w.planGroupCalls).toEqual([["a", "b", "c"]]);
    expect(w.runGroupCalls.map((c) => c.components)).toEqual([["a", "b", "c"]]);
    expect(result.groupOutcomes).toEqual({ a: "applied", b: "applied", c: "applied" });
  });

  test("runInterpretDriver runs a group once, in place of its members' own deploys", async () => {
    const w = world({ group: true });
    const plan = await grouped(ABC, w.registry);
    const byName = new Map(ABC.map((c) => [c.name, c]));
    const run: DriverRunResult = await runInterpretDriver(ABC, w.registry, {
      env: "prod",
      gates: memoryGateLedgerPort(),
      groups: {
        waves: plan.waves,
        groups: plan.groups!,
        run: (group, componentOutputs) =>
          planAndRunComponentGroup({ group, components: byName, registry: w.registry, env: "prod", ctxOf: (name) => ({ env: "prod", component: name }), componentOutputs }),
      },
    });
    expect(run.status).toBe("ok");
    expect(run.waves).toEqual([["a", "b", "c"]]);
    expect(w.applied).toEqual([]);
    expect(w.runGroupCalls.map((c) => c.components)).toEqual([["a", "b", "c"]]);
    expect(run.componentOutputs).toMatchObject({ c: { id: "c-id" } });
  });
});

describe("the promote report names the group and each member's outcome (#4465)", () => {
  test("a group that stopped part way: its members, wave, digest and reads, each member's outcome, and what the same promote plans next", async () => {
    const w = world({ group: true });
    const { plan, set } = await planned(ABC, w.registry);
    const digest = set.groups![0]!.digest!;
    const report = runGroupsReport({ grouped: plan, planned: set.groups!, doc: set.doc, outcomes: { a: "applied", b: "partial", c: "not-started" } });
    expect(report.groups).toEqual([
      {
        capability: "fake-stack",
        components: ["a", "b", "c"],
        wave: 1,
        digest,
        reads: [
          { member: "b", ref: "a.id" },
          { member: "c", ref: "b.id" },
        ],
        outcomes: { a: "applied", b: "partial", c: "not-started" },
      },
    ]);
    expect(renderRunGroups(report, "the same promote")).toEqual([
      `a, b and c plan and apply as one (fake-stack, wave 1, group ${digest}); b reads a.id and c reads b.id, known when the group applies`,
      "  a applied; b applied in part, and what applied stays; c did not start",
      "  the group's apply stopped part way and nothing that applied is undone; the same promote plans b and c again, as one group where they still join",
    ]);
  });

  test("under --wave-gate the report says why each member planned by itself", async () => {
    const w = world({ group: true });
    const plan = await grouped(ABC, w.registry, true);
    const lines = renderRunGroups(runGroupsReport({ grouped: plan }), "the same promote");
    expect(lines).toEqual([
      "planned one by one, not as a group: a, b, c (wave-gate): a, b and c would plan and apply as one, but under --wave-gate each wave plans component by component, so no group forms",
    ]);
  });
});
