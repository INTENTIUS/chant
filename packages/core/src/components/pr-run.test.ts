/**
 * Planning and applying a pull request's members (#3183), against a fake
 * root capability and an in-memory gate ledger. The five-root run against
 * real `tofu` roots is `lexicons/terraform/src/components/pr-loop.tofu.test.ts`.
 *
 * The capability stands in for `terraform-apply`: `plan` returns the root, a
 * digest over what it would write (its `version` and every input), a
 * change-set part and, where `predict` says, the outputs it will expose
 * (#3999); `outputs` reads what it exposes now; `run` applies.
 */

import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type DeployContext, type PlannedOutputs } from "./capability";
import { memoryGateLedgerPort } from "../op/gate";
import { planFanOut } from "./fan-out";
import {
  applyPrSet,
  approvalOf,
  approversWhoAuthored,
  approversWithoutReview,
  decidePrGate,
  planCoveredBy,
  planPrSet,
  prReport,
  prWavePlan,
  readOnlyLedger,
  resumePrSet,
  waveNotCovered,
  type PrPlanSet,
} from "./pr-run";
import { changeSetDigest, changeSetDocumentDigest, composeChangeSet, type ChangeSetEntry, type ChangeSetPart } from "../change-set";
import type { PrApplyRecord } from "./fan-out-record";
import type { FanOutPlan } from "./fan-out";
import { computePlanDigest } from "../lifecycle/plan-digest";
import type { DriverComponent } from "./driver";

interface RootInput {
  root: string;
  vars?: Record<string, unknown>;
}

const root = (name: string, dependsOn: string[] = [], vars?: Record<string, unknown>): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "fake-root", root: name, ...(vars ? { vars } : {}) }] }],
});

/** net -> a, b; a -> app; dns alone. */
const ESTATE: DriverComponent[] = [
  root("net"),
  root("a", ["net"], { cidr: { stackOutput: { stack: "net", name: "cidr" } } }),
  root("b", ["net"], { cidr: { stackOutput: { stack: "net", name: "cidr" } } }),
  root("app", ["a"], { subnet: { stackOutput: { stack: "a", name: "id" } } }),
  root("dns"),
];

function world() {
  const w = {
    registry: new CapabilityRegistry(),
    /** What each root would write. */
    versions: {} as Record<string, string>,
    /** What each root's state exposes. */
    state: { net: { cidr: "10.0.0.0/16" }, a: { id: "a-v1" } } as Record<string, Record<string, unknown>>,
    planned: [] as Array<{ root: string; vars?: Record<string, unknown> }>,
    outputsRead: [] as string[],
    applied: [] as string[],
    /** The vars each root applied with, after wiring resolved. */
    ranWith: {} as Record<string, Record<string, unknown> | undefined>,
    fromPlan: {} as Record<string, boolean>,
    failing: new Set<string>(),
    planFailing: new Set<string>(),
    /**
     * What each root's plan says it will expose (#3999). By default `net`
     * keeps the cidr it has, and `a` will expose the id its version gives,
     * as a terraform plan's `planned_values` would say.
     */
    predict: {} as Record<string, (() => PlannedOutputs | undefined) | undefined>,
    /** What `a` writes when it applies, when not what its version gives. */
    appliesAs: undefined as string | undefined,
  };
  w.predict.net = () => ({ known: { ...(w.state.net ?? {}) }, unknown: [] });
  w.predict.a = () => ({ known: { id: `a-${w.versions.a ?? "v1"}` }, unknown: [] });
  const digestOf = (input: RootInput) => computePlanDigest("fake-root", { root: input.root, version: w.versions[input.root] ?? "v1", vars: input.vars ?? null });
  w.registry.register({
    kind: "fake-root",
    async plan(_ctx: DeployContext, input: RootInput) {
      w.planned.push({ root: input.root, ...(input.vars ? { vars: input.vars } : {}) });
      if (w.planFailing.has(input.root)) throw new Error(`${input.root}: no value for a required variable`);
      const planDigest = digestOf(input);
      const changes = (w.versions[input.root] ?? "v1") !== "v1";
      const outputs = w.predict[input.root]?.();
      return {
        member: input.root,
        planDigest,
        artifact: { planDigest },
        ...(outputs ? { outputs } : {}),
        changeSet: {
          member: { member: input.root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest, holes: [] },
          entries: changes
            ? [
                {
                  member: input.root,
                  lexicon: "terraform",
                  planner: "tofu",
                  address: "terraform_data.x",
                  type: "terraform_data",
                  action: "update",
                  attributes: [{ path: "version", before: "v1", after: w.versions[input.root] }],
                },
              ]
            : [],
        },
      };
    },
    async outputs(_ctx: DeployContext, input: RootInput) {
      w.outputsRead.push(input.root);
      return { ...(w.state[input.root] ?? {}) };
    },
    async run(ctx: DeployContext, input: RootInput) {
      w.fromPlan[input.root] = ctx.plans?.[input.root] !== undefined;
      w.ranWith[input.root] = input.vars;
      if (w.failing.has(input.root)) throw new Error(`${input.root} failed`);
      w.applied.push(input.root);
      if (input.root === "a") w.state.a = { id: w.appliesAs ?? `a-${w.versions.a ?? "v1"}` };
      return { outputs: { ...(w.state[input.root] ?? {}) } };
    },
  } as never);
  return w;
}

const NOW = "2026-10-03T00:00:00Z";
const LATER = "2026-10-03T01:00:00Z";

const approval = (planDigest: string, resolvedBy = "github:alice") => ({
  version: 1 as const,
  kind: "resolution" as const,
  op: "pr-12",
  gate: "pr-apply",
  resolvedBy,
  timestamp: LATER,
  planDigest,
});

describe("planPrSet", () => {
  test("plans the changed root and its dependents: a dependency outside the change as deployed, one in it as its plan says (#3999)", async () => {
    const w = world();
    w.versions.a = "v2";
    const plan = planFanOut({ components: ESTATE, changed: ["a"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });

    expect(plan.order).toEqual(["a", "app"]);
    // app reads the id a's plan says a will have, not the one a has now.
    expect(w.planned).toEqual([
      { root: "a", vars: { cidr: "10.0.0.0/16" } },
      { root: "app", vars: { subnet: "a-v2" } },
    ]);
    // net is read from the estate; a is not read at all.
    expect(w.outputsRead).toEqual(["net"]);
    expect(set.deployedOutputs).toEqual({ net: ["cidr"] });
    expect(set.plannedOutputs).toEqual({ a: ["id"] });
    expect(set.members.every((m) => m.unknownInputs === undefined)).toBe(true);
    expect(set.members.map((m) => [m.member, m.status, m.counts.update])).toEqual([
      ["a", "planned", 1],
      ["app", "planned", 0],
    ]);
    expect(set.doc.digest).toBe(changeSetDocumentDigest(set.doc));
    expect(set.doc.digest).not.toBe(changeSetDigest(set.members.map((m) => ({ member: m.member, planDigest: m.planDigest }))));
    expect(set.failed).toBe(false);
  });

  test("planning the same members against the same state gives the same digest; a changed root moves it", async () => {
    const plan = planFanOut({ components: ESTATE, changed: ["a"] });
    const w = world();
    w.versions.a = "v2";
    const first = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });
    const again = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });
    w.versions.a = "v3";
    const moved = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });
    expect(again.doc.digest).toBe(first.doc.digest);
    expect(moved.doc.digest).not.toBe(first.doc.digest);
  });

  test("a component that fails to plan is a failed member with no digest", async () => {
    const w = world();
    w.planFailing.add("app");
    const set = await planPrSet({ components: ESTATE, plan: planFanOut({ components: ESTATE, changed: ["a"] }), registry: w.registry, env: "prod" });
    expect(set.failed).toBe(true);
    expect(set.members.find((m) => m.member === "app")).toMatchObject({ status: "plan-failed", planDigest: null, error: "app: no value for a required variable" });
  });
});

describe("a dependency outside the selection (#4104)", () => {
  /** Two members: `up`, and `down` reading its `id`. The pull request changes `down` alone. */
  const PAIR: DriverComponent[] = [root("up"), root("down", ["up"], { upstream: { stackOutput: { stack: "up", name: "id" } } })];

  function pairWorld() {
    const w = world();
    w.state = { up: { id: "up-live", arn: "arn:up" } };
    w.versions.down = "v2";
    return w;
  }

  test("the dependent's plan resolves the upstream's outputs from its deployed outputs, and the report lists them", async () => {
    const w = pairWorld();
    const plan = planFanOut({ components: PAIR, changed: ["down"] });
    expect(plan.order).toEqual(["down"]);
    expect(plan.seeds).toEqual(["up"]);

    const set = await planPrSet({ components: PAIR, plan, registry: w.registry, env: "prod" });
    expect(w.outputsRead).toEqual(["up"]);
    expect(w.planned).toEqual([{ root: "down", vars: { upstream: "up-live" } }]);
    expect(set.outputs).toEqual({ up: { id: "up-live", arn: "arn:up" } });
    expect(set.deployedOutputs).toEqual({ up: ["arn", "id"] });

    const report = prReport({
      stage: "plan",
      pr: 12,
      env: "prod",
      base: "1".repeat(40),
      head: "2".repeat(40),
      op: "pr-12",
      gate: "pr-apply",
      plan,
      signal: { changed: ["down"], indeterminate: [], unclaimed: [] },
      set,
      approval: { status: "pending" },
      status: "planned",
    });
    expect(report.deployedOutputs).toEqual({ up: ["arn", "id"] });
    expect(report.selection).toMatchObject({ changed: ["down"], dependents: [] });
  });

  test("the apply's plan reads the same outputs, gets the approved digest, and applies against them", async () => {
    const w = pairWorld();
    const plan = planFanOut({ components: PAIR, changed: ["down"] });
    const approved = await planPrSet({ components: PAIR, plan, registry: w.registry, env: "prod" });

    // pr-apply plans the members again before anything applies.
    w.outputsRead.length = 0;
    const set = await planPrSet({ components: PAIR, plan, registry: w.registry, env: "prod" });
    expect(w.outputsRead).toEqual(["up"]);
    expect(set.doc.digest).toBe(approved.doc.digest);
    const check = await decidePrGate(memoryGateLedgerPort({ resolutions: [approval(approved.doc.digest)] }), {
      op: "pr-12",
      gate: "pr-apply",
      digest: set.doc.digest,
      now: NOW,
    });
    expect(check.satisfied).toBe(true);

    const { members, status } = await applyPrSet({ components: PAIR, plan, registry: w.registry, env: "prod", set });
    expect(status).toBe("applied");
    expect(w.applied).toEqual(["down"]);
    expect(w.ranWith.down).toEqual({ upstream: "up-live" });
    expect(members.map((m) => [m.member, m.status, m.inputsMoved])).toEqual([["down", "applied", undefined]]);
  });

  test("an upstream whose deployed output moved after approval moves the apply's digest", async () => {
    const w = pairWorld();
    const plan = planFanOut({ components: PAIR, changed: ["down"] });
    const approved = await planPrSet({ components: PAIR, plan, registry: w.registry, env: "prod" });
    w.state.up = { id: "up-moved", arn: "arn:up" };
    const set = await planPrSet({ components: PAIR, plan, registry: w.registry, env: "prod" });
    expect(set.doc.digest).not.toBe(approved.doc.digest);
  });

  test("--seed-outputs wins: a seeded upstream is not read and not listed", async () => {
    const w = pairWorld();
    const plan = planFanOut({ components: PAIR, changed: ["down"] });
    const set = await planPrSet({ components: PAIR, plan, registry: w.registry, env: "prod", seededOutputs: { up: { id: "up-seeded" } } });
    expect(w.outputsRead).toEqual([]);
    expect(w.planned).toEqual([{ root: "down", vars: { upstream: "up-seeded" } }]);
    expect(set.deployedOutputs).toBeUndefined();
  });

  test("an upstream whose steps cannot say leaves the reference unresolved", async () => {
    const w = pairWorld();
    const silent: DriverComponent[] = [
      { name: "up", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "no-outputs" }] }] },
      PAIR[1]!,
    ];
    w.registry.register({ kind: "no-outputs", async run() { return {}; } } as never);
    const plan = planFanOut({ components: silent, changed: ["down"] });
    const set = await planPrSet({ components: silent, plan, registry: w.registry, env: "prod" });
    expect(w.outputsRead).toEqual([]);
    expect(set.outputs).toEqual({});
    expect(set.deployedOutputs).toBeUndefined();
    expect(w.planned).toHaveLength(1);
    expect(w.planned[0]!.vars?.upstream).not.toBe("up-live");
  });

  test("the selection in place of the whole graph is refused, naming the dependency", async () => {
    const w = pairWorld();
    const plan = planFanOut({ components: PAIR, changed: ["down"] });
    await expect(planPrSet({ components: [PAIR[1]!], plan, registry: w.registry, env: "prod" })).rejects.toThrow(/up, a dependency of a planned member/);
  });

  test("a resume plans against the record's outputs and reads no dependency they cover", async () => {
    const w = world();
    w.versions.a = "v2";
    const plan = planFanOut({ components: ESTATE, changed: ["a"] });
    const { set, first, record } = await firstAttempt(w, plan, ["app"]);
    expect(first.run.completed).toEqual(["a"]);
    expect(set.deployedOutputs).toEqual({ net: ["cidr"] });
    expect(set.plannedOutputs).toEqual({ a: ["id"] });

    w.outputsRead.length = 0;
    w.state.net = { cidr: "10.9.0.0/16" };
    const resumed = await resumePrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", record, completed: ["a"] });
    if (!resumed.ok) throw new Error(resumed.reasons.join("; "));
    expect(w.outputsRead).toEqual([]);
    expect(resumed.set.doc.digest).toBe(set.doc.digest);
    expect(resumed.set.outputs).toBe(record.planOutputs);
  });
});

describe("the gate", () => {
  test("pending with no approval, approved for the digest, changed for another one", async () => {
    const w = world();
    const set = await planPrSet({ components: ESTATE, plan: planFanOut({ components: ESTATE, changed: ["a"] }), registry: w.registry, env: "prod" });
    const input = { op: "pr-12", gate: "pr-apply", digest: set.doc.digest, now: NOW };

    expect(approvalOf(await decidePrGate(readOnlyLedger(memoryGateLedgerPort()), input))).toEqual({ status: "pending" });
    expect(approvalOf(await decidePrGate(memoryGateLedgerPort({ resolutions: [approval(set.doc.digest)] }), input))).toEqual({
      status: "approved",
      approvedBy: ["github:alice"],
    });
    const other = `jcs1-sha256:${"9".repeat(64)}`;
    expect(approvalOf(await decidePrGate(memoryGateLedgerPort({ resolutions: [approval(other)] }), input))).toEqual({ status: "changed", approved: other });
  });

  test("the plan stage's ledger records nothing", async () => {
    const ledger = memoryGateLedgerPort();
    await decidePrGate(readOnlyLedger(ledger), { op: "pr-12", gate: "pr-apply", digest: `jcs1-sha256:${"1".repeat(64)}`, now: NOW });
    expect(ledger.appended).toEqual([]);
  });

  test("an approver needs a standing approving review, named the forge's way", () => {
    expect(approversWithoutReview(["github:alice", "GitHub:Bob"], ["github:alice", "github:bob"])).toEqual([]);
    expect(approversWithoutReview(["github:mallory"], ["github:alice"])).toEqual(["github:mallory"]);
  });

  test("an approver who wrote the change is named, the forge's naming compared without case (#4000)", () => {
    expect(approversWhoAuthored(["github:alice", "GitHub:Carol"], ["github:carol", "github:dave"])).toEqual(["GitHub:Carol"]);
    expect(approversWhoAuthored(["github:alice"], ["github:carol"])).toEqual([]);
  });
});

describe("applyPrSet", () => {
  test("applies each member's approved plan in order; a dependent planned on the output its upstream applied as applies as approved (#3999)", async () => {
    const w = world();
    w.versions.a = "v2";
    const plan = planFanOut({ components: ESTATE, changed: ["a"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });
    const { members, status, rounds } = await applyPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", set });

    expect(status).toBe("applied");
    expect(w.applied).toEqual(["a", "app"]);
    expect(w.fromPlan).toEqual({ a: true, app: true });
    expect(w.ranWith.app).toEqual({ subnet: "a-v2" });
    expect(rounds).toBeUndefined();
    expect(members.map((m) => [m.member, m.status, m.inputsMoved, m.round])).toEqual([
      ["a", "applied", undefined, undefined],
      ["app", "applied", undefined, undefined],
    ]);
  });

  test("a failed member blocks its dependents and nothing else", async () => {
    const w = world();
    w.failing.add("a");
    const plan = planFanOut({ components: ESTATE, changed: ["net", "dns"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });
    const { members, status } = await applyPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", set });
    expect(status).toBe("failed");
    expect(Object.fromEntries(members.map((m) => [m.member, m.status]))).toEqual({
      a: "failed",
      app: "blocked",
      b: "applied",
      dns: "applied",
      net: "applied",
    });
    expect(members.find((m) => m.member === "a")?.error).toBe("a failed");
  });
});

describe("a dependent planned on its upstream's planned outputs (#3999)", () => {
  /** `a` and `app` reading its `id`, the change touching `a`. */
  const plan = () => planFanOut({ components: ESTATE, changed: ["a"] });
  const approveAll = (digest: string, gate: string) =>
    decidePrGate(memoryGateLedgerPort({ resolutions: [{ ...approval(digest), gate }] }), { op: "pr-12", gate, digest, now: NOW });
  const decideWith = (approved: Set<string>) => async ({ gate, set }: { gate: string; set: PrPlanSet }) => {
    const check = approved.has(set.doc.digest) ? await approveAll(set.doc.digest, gate) : await decidePrGate(readOnlyLedger(memoryGateLedgerPort()), { op: "pr-12", gate, digest: set.doc.digest, now: NOW });
    return { satisfied: check.satisfied, approval: approvalOf(check) };
  };

  test("an output the change leaves as it is: the dependent plans on the planned value, which is the deployed one", async () => {
    const w = world();
    const set = await planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
    expect(w.planned.find((p) => p.root === "app")?.vars).toEqual({ subnet: "a-v1" });
    expect(set.plannedOutputs).toEqual({ a: ["id"] });
    const applied = await applyPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod", set });
    expect(applied.status).toBe("applied");
    expect(w.applied).toEqual(["a", "app"]);
  });

  test("an output the change moves: the dependent plans on the moved value, not the one standing now", async () => {
    const w = world();
    w.versions.a = "v2";
    expect(w.state.a).toEqual({ id: "a-v1" });
    const set = await planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
    expect(w.planned.find((p) => p.root === "app")?.vars).toEqual({ subnet: "a-v2" });
    expect(w.outputsRead).not.toContain("a");
    // The reviewer approves app's plan against a-v2, and that is what applies.
    const applied = await applyPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod", set });
    expect(applied.status).toBe("applied");
    expect(w.ranWith.app).toEqual({ subnet: "a-v2" });
  });

  test("an output known only after apply is listed on the dependent, which the apply plans again and gates once its upstream applied", async () => {
    const w = world();
    w.versions.a = "v2";
    w.predict.a = () => ({ known: {}, unknown: ["id"] });
    const set = await planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
    expect(set.failed).toBe(false);
    expect(w.planned.find((p) => p.root === "app")?.vars?.subnet).toBeUndefined();
    expect(set.plannedOutputs).toEqual({ a: [] });
    expect(set.members.map((m) => [m.member, m.unknownInputs])).toEqual([
      ["a", undefined],
      ["app", ["a.id"]],
    ]);

    // No approval of the plan made after a applied: a applies, app waits.
    const waiting = await applyPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod", set, decideRound: decideWith(new Set()) });
    expect(waiting.status).toBe("waiting");
    expect(w.applied).toEqual(["a"]);
    expect(waiting.rounds).toHaveLength(1);
    const round = waiting.rounds![0]!;
    expect(round).toMatchObject({ round: 2, gate: "pr-apply-round-2", components: ["app"], status: "waiting", approval: { status: "pending" } });
    // Round 2 planned app against the id a applied as.
    expect(w.planned.at(-1)).toEqual({ root: "app", vars: { subnet: "a-v2" } });
    const app = waiting.members.find((m) => m.member === "app")!;
    expect(app).toMatchObject({ status: "waiting", round: 2, held: "its plan read a.id before that output applied as another value" });
    expect(app.planDigest).toBe(round.changeSet.members[0]!.planDigest);
    expect(app.planDigest).not.toBe(set.members.find((m) => m.member === "app")!.planDigest);

    // With that plan approved, app applies against the value a applied as.
    const w2 = world();
    w2.versions.a = "v2";
    w2.predict.a = () => ({ known: {}, unknown: ["id"] });
    const set2 = await planPrSet({ components: ESTATE, plan: plan(), registry: w2.registry, env: "prod" });
    const applied = await applyPrSet({ components: ESTATE, plan: plan(), registry: w2.registry, env: "prod", set: set2, decideRound: decideWith(new Set([round.digest])) });
    expect(applied.status).toBe("applied");
    expect(w2.applied).toEqual(["a", "app"]);
    expect(w2.ranWith.app).toEqual({ subnet: "a-v2" });
    expect(applied.rounds?.map((r) => [r.round, r.status, r.approval.status])).toEqual([[2, "applied", "approved"]]);
    expect(applied.members.find((m) => m.member === "app")).toMatchObject({ status: "applied", round: 2 });
  });

  test("an upstream new in the same pull request plans, and so does its dependent", async () => {
    const pair: DriverComponent[] = [root("vpc"), root("svc", ["vpc"], { vpc: { stackOutput: { stack: "vpc", name: "id" } } })];
    const w = world();
    w.state = {};
    // A new root: its plan creates it, and its id is known only after apply.
    w.versions.vpc = "v2";
    w.predict.vpc = () => ({ known: {}, unknown: ["id"] });
    const p = planFanOut({ components: pair, changed: ["vpc", "svc"] });
    const set = await planPrSet({ components: pair, plan: p, registry: w.registry, env: "prod" });
    expect(set.failed).toBe(false);
    expect(set.members.map((m) => [m.member, m.status, m.unknownInputs])).toEqual([
      ["svc", "planned", ["vpc.id"]],
      ["vpc", "planned", undefined],
    ]);
    expect(w.outputsRead).toEqual([]);
    expect(set.deployedOutputs).toBeUndefined();
  });

  test("an upstream that applies as another value than its plan said holds the dependent back, which does not apply its approved plan", async () => {
    const w = world();
    w.versions.a = "v2";
    w.appliesAs = "a-v2-real";
    const set = await planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
    expect(w.planned.find((p) => p.root === "app")?.vars).toEqual({ subnet: "a-v2" });

    // Without a way to decide a later round, app is left waiting.
    const held = await applyPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod", set });
    expect(held.status).toBe("waiting");
    expect(w.applied).toEqual(["a"]);
    expect(held.members.find((m) => m.member === "app")).toMatchObject({ status: "waiting", held: "its plan read a.id before that output applied as another value" });
    expect(held.run.held).toEqual([{ component: "app", reason: "its plan read a.id before that output applied as another value" }]);
  });

  test("a resumed apply carries on from a waiting round once its plan is approved", async () => {
    const w = world();
    w.versions.a = "v2";
    w.predict.a = () => ({ known: {}, unknown: ["id"] });
    const set = await planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
    const first = await applyPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod", set, decideRound: decideWith(new Set()) });
    expect(first.status).toBe("waiting");
    const roundDigest = first.rounds![0]!.digest;

    const record = recordOf(set);
    const resumed = await resumePrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod", record, completed: ["a"] });
    if (!resumed.ok) throw new Error(resumed.reasons.join("; "));
    expect(resumed.plan.order).toEqual(["app"]);
    const second = await applyPrSet({
      components: ESTATE,
      plan: resumed.plan,
      registry: w.registry,
      env: "prod",
      set: resumed.set,
      resumed: { completed: ["a"], outputs: { a: first.run.componentOutputs.a! } },
      decideRound: decideWith(new Set([roundDigest])),
    });
    expect(second.status).toBe("applied");
    expect(second.rounds?.[0]?.digest).toBe(roundDigest);
    expect(w.applied).toEqual(["a", "app"]);
    expect(w.ranWith.app).toEqual({ subnet: "a-v2" });
  });
});

/** The record a first attempt leaves (`pr-apply --resume`), from the set it applied. */
function recordOf(set: PrPlanSet, approvedBy = "github:alice"): PrApplyRecord {
  return {
    op: "pr-12",
    gate: "pr-apply",
    head: "2".repeat(40),
    digest: set.doc.digest,
    approvedBy: [approvedBy],
    members: set.members,
    changeSet: set.doc,
    planOutputs: set.outputs,
  };
}

/** Plan and apply once, with `failing` failing to apply. */
async function firstAttempt(w: ReturnType<typeof world>, plan: FanOutPlan, failing: string[]) {
  for (const f of failing) w.failing.add(f);
  const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });
  const first = await applyPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", set });
  for (const f of failing) w.failing.delete(f);
  return { set, first, record: recordOf(set) };
}

describe("resuming an apply that failed partway (#3464)", () => {
  test("plans and applies only what did not apply, and the set keeps the approved digest", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net", "dns"] });
    const { set, first, record } = await firstAttempt(w, plan, ["a"]);
    expect(first.status).toBe("failed");
    expect(first.run.completed).toEqual(["b", "dns", "net"]);

    w.planned.length = 0;
    w.applied.length = 0;
    const resumed = await resumePrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", record, completed: first.run.completed });
    if (!resumed.ok) throw new Error(resumed.reasons.join("; "));

    expect(resumed.plan.order).toEqual(["a", "app"]);
    // Planned against the outputs the approved plans read, so each member plans as it did.
    expect(w.planned).toEqual([
      { root: "a", vars: { cidr: "10.0.0.0/16" } },
      { root: "app", vars: { subnet: "a-v1" } },
    ]);
    expect(resumed.set.doc.digest).toBe(set.doc.digest);
    expect(resumed.fresh.members.map((m) => m.planDigest)).toEqual(
      set.members.filter((m) => m.member === "a" || m.member === "app").map((m) => m.planDigest),
    );

    // The gate is decided against the digest that was approved, and it still stands.
    const ledger = memoryGateLedgerPort({ resolutions: [approval(set.doc.digest)] });
    const check = await decidePrGate(ledger, { op: "pr-12", gate: "pr-apply", digest: resumed.set.doc.digest, now: NOW });
    expect(check.satisfied).toBe(true);
    expect(ledger.appended).toEqual([]);

    const second = await applyPrSet({
      components: ESTATE,
      plan: resumed.plan,
      registry: w.registry,
      env: "prod",
      set: resumed.set,
      resumed: { completed: first.run.completed, outputs: {} },
    });
    expect(second.status).toBe("applied");
    expect(w.applied).toEqual(["a", "app"]);
    expect(w.fromPlan.a).toBe(true);
    expect(Object.fromEntries(second.members.map((m) => [m.member, m.status]))).toEqual({
      a: "applied",
      app: "applied",
      b: "applied",
      dns: "applied",
      net: "applied",
    });
  });

  test("the resumed report carries the approved digest and names what the earlier attempt applied", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net", "dns"] });
    const { set, first, record } = await firstAttempt(w, plan, ["a"]);
    const resumed = await resumePrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", record, completed: first.run.completed });
    if (!resumed.ok) throw new Error(resumed.reasons.join("; "));
    const second = await applyPrSet({
      components: ESTATE,
      plan: resumed.plan,
      registry: w.registry,
      env: "prod",
      set: resumed.set,
      resumed: { completed: first.run.completed, outputs: {} },
    });
    const report = prReport({
      stage: "apply",
      pr: 12,
      env: "prod",
      base: "1".repeat(40),
      head: "2".repeat(40),
      op: "pr-12",
      gate: "pr-apply",
      plan,
      signal: { changed: ["net", "dns"], unclaimed: [] } as never,
      set: resumed.set,
      approval: { status: "approved", approvedBy: ["github:alice"] },
      status: second.status,
      members: second.members,
      resumed: first.run.completed,
    });
    expect(report.digest).toBe(set.doc.digest);
    expect(report.changeSet).toBe(set.doc);
    expect(report.resumed).toEqual({ applied: ["b", "dns", "net"] });
  });

  test("a dependent whose dependency applied as planned in the earlier attempt applies its approved plan", async () => {
    const w = world();
    w.versions.a = "v2";
    const plan = planFanOut({ components: ESTATE, changed: ["a"] });
    const { first, record } = await firstAttempt(w, plan, ["app"]);
    expect(first.run.completed).toEqual(["a"]);
    const outputs = { a: first.run.componentOutputs.a };
    expect(outputs.a).toEqual({ id: "a-v2" });

    w.planned.length = 0;
    const resumed = await resumePrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", record, completed: ["a"] });
    if (!resumed.ok) throw new Error(resumed.reasons.join("; "));
    // app is planned against the value it was approved with: the one a's plan said, which a wrote.
    expect(w.planned).toEqual([{ root: "app", vars: { subnet: "a-v2" } }]);

    const second = await applyPrSet({
      components: ESTATE,
      plan: resumed.plan,
      registry: w.registry,
      env: "prod",
      set: resumed.set,
      resumed: { completed: ["a"], outputs },
    });
    expect(second.status).toBe("applied");
    expect(w.ranWith.app).toEqual({ subnet: "a-v2" });
    expect(second.members.map((m) => [m.member, m.status, m.inputsMoved])).toEqual([
      ["a", "applied", undefined],
      ["app", "applied", undefined],
    ]);
  });

  test("a member left over whose plan moved is not covered, and says why", async () => {
    const w = world();
    w.versions.a = "v2";
    const plan = planFanOut({ components: ESTATE, changed: ["net", "a"] });
    const { first, record } = await firstAttempt(w, plan, ["a"]);
    expect(first.run.completed).toEqual(["b", "net"]);

    w.versions.a = "v3";
    const resumed = await resumePrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", record, completed: first.run.completed });
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.reasons).toEqual(["a now writes terraform_data.x.version to a different value than the approved plan"]);
  });

  test("a member left over that fails to plan is not covered", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const { first, record } = await firstAttempt(w, plan, ["a"]);
    w.planFailing.add("a");
    const resumed = await resumePrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", record, completed: first.run.completed });
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.reasons[0]).toMatch(/^a failed to plan/);
  });

  test("a record whose change set is not the one its digest names does not resume (#3543)", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const { set, first, record } = await firstAttempt(w, plan, ["a"]);
    const other = { ...set.doc, digest: "jcs1-sha256:" + "0".repeat(64) };
    for (const forged of [
      { ...record, changeSet: other },
      { ...record, digest: other.digest, changeSet: other },
      { ...record, changeSet: { ...set.doc, members: set.doc.members.map((m) => (m.member === "a" ? { ...m, planDigest: "jcs1-sha256:" + "1".repeat(64) } : m)) } },
      // The digest binds the entries (#3555): an entry or a hole planted in the record does not resume.
      {
        ...record,
        changeSet: {
          ...set.doc,
          entries: [...set.doc.entries, { member: "a", lexicon: "terraform", planner: "tofu" as const, address: "aws_vpc.planted", type: "aws_vpc", action: "create" as const, attributes: [] }],
        },
      },
      { ...record, changeSet: { ...set.doc, members: set.doc.members.map((m) => (m.member === "a" ? { ...m, holes: [{ address: "data.planted", reason: "unobserved" }] } : m)) } },
    ]) {
      w.planned.length = 0;
      const resumed = await resumePrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", record: forged, completed: first.run.completed });
      expect(resumed.ok).toBe(false);
      if (resumed.ok) return;
      expect(resumed.reasons[0]).toMatch(/^the record's change set is not the one its digest/);
      expect(w.planned).toEqual([]);
    }
  });

  test("with every component applied, nothing is left to plan or apply", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["dns"] });
    const { first, record } = await firstAttempt(w, plan, []);
    expect(first.status).toBe("applied");
    w.planned.length = 0;
    const resumed = await resumePrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", record, completed: first.run.completed });
    if (!resumed.ok) throw new Error(resumed.reasons.join("; "));
    expect(resumed.plan.order).toEqual([]);
    expect(w.planned).toEqual([]);
  });
});

describe("planCoveredBy", () => {
  const entry = (address: string, action: ChangeSetEntry["action"], attributes: ChangeSetEntry["attributes"] = [], extra: Partial<ChangeSetEntry> = {}): ChangeSetEntry => ({
    member: "net",
    lexicon: "terraform",
    planner: "tofu",
    address,
    type: address.split(".")[0],
    action,
    attributes,
    ...extra,
  });
  const doc = (digest: string, entries: ChangeSetEntry[], extra: Partial<ChangeSetPart["member"]> = {}) =>
    composeChangeSet([
      {
        member: { member: "net", lexicon: "terraform", planner: "tofu", status: "planned", planDigest: `jcs1-sha256:${digest.repeat(64)}`, holes: [], ...extra },
        entries,
      },
    ]);

  const approved = doc("1", [
    entry("aws_vpc.main", "update", [{ path: "tags", before: { a: "1" }, after: { a: "2" } }]),
    entry("aws_subnet.a", "create", [{ path: "vpc_id", unknown: true }, { path: "cidr_block", after: "10.0.1.0/24" }]),
    entry("aws_instance.web", "replace", [{ path: "ami", before: "ami-1", after: "ami-2", forcesReplacement: true }]),
    entry("aws_db_instance.db", "update", [{ path: "password", sensitive: true }]),
  ]);

  test("the same plan digest is covered", () => {
    expect(planCoveredBy(approved, doc("1", []), "net")).toBeUndefined();
  });

  test("what is left of the approved changes is covered", () => {
    // The VPC applied, the subnet's vpc_id is known now, and the instance's
    // old object was destroyed before the create failed.
    const left = doc("2", [
      entry("aws_vpc.main", "no-op"),
      entry("aws_subnet.a", "create", [{ path: "vpc_id", after: "vpc-123" }, { path: "cidr_block", after: "10.0.1.0/24" }]),
      entry("aws_instance.web", "create", [{ path: "ami", after: "ami-2" }, { path: "instance_type", after: "t3.micro" }]),
      entry("aws_db_instance.db", "update", [{ path: "password", sensitive: true }]),
    ]);
    expect(planCoveredBy(approved, left, "net")).toBeUndefined();
  });

  test("a create-before-destroy replace left with its deposed object to delete is covered", () => {
    const left = doc("2", [entry("aws_instance.web", "delete", [], { deposed: "00abc" })]);
    expect(planCoveredBy(approved, left, "net")).toBeUndefined();
  });

  test("a change the approved plan did not make is not covered", () => {
    expect(planCoveredBy(approved, doc("2", [entry("aws_s3_bucket.logs", "create")]), "net")).toBe(
      "net now plans to create aws_s3_bucket.logs, which the approved plan did not",
    );
    expect(planCoveredBy(approved, doc("2", [entry("aws_vpc.main", "delete")]), "net")).toBe(
      "net now plans to delete aws_vpc.main, where the approved plan would update it",
    );
    expect(planCoveredBy(approved, doc("2", [entry("aws_vpc.main", "update", [{ path: "tags", before: { a: "1" }, after: { a: "3" } }])]), "net")).toBe(
      "net now writes aws_vpc.main.tags to a different value than the approved plan",
    );
    expect(planCoveredBy(approved, doc("2", [entry("aws_vpc.main", "update", [{ path: "cidr_block", before: "a", after: "b" }])]), "net")).toBe(
      "net now writes aws_vpc.main.cidr_block, which the approved plan did not",
    );
  });

  test("a sensitive value is covered only where the approved plan wrote it as sensitive", () => {
    expect(planCoveredBy(approved, doc("2", [entry("aws_vpc.main", "update", [{ path: "tags", sensitive: true }])]), "net")).toMatch(/as sensitive/);
    expect(planCoveredBy(approved, doc("2", [entry("aws_db_instance.db", "update", [{ path: "password", after: "x" }])]), "net")).toMatch(/wrote as sensitive/);
  });

  test("a hole the approved plan did not have is not covered", () => {
    const left = doc("2", [], { holes: [{ address: "data.aws_ami.latest", reason: "unknown" }] });
    expect(planCoveredBy(approved, left, "net")).toMatch(/cannot read data.aws_ami.latest/);
  });

  test("a member the approved set did not have is not covered", () => {
    const other = composeChangeSet([
      { member: { member: "edge", lexicon: "terraform", planner: "tofu", status: "planned", planDigest: `jcs1-sha256:${"3".repeat(64)}`, holes: [] }, entries: [] },
    ]);
    expect(planCoveredBy(approved, other, "edge")).toBe("edge was not in the approved plan");
  });
});

describe("a gate per wave on merge (#4003)", () => {
  const estate = [root("net"), root("a", ["net"]), root("b", ["net"]), root("app", ["a"])];
  const plan = planFanOut({ components: estate, changed: ["net"] });

  test("prWavePlan narrows the derivation to one wave, less what applied, with the earlier waves as seeds and the same digest", () => {
    expect(plan.waves).toEqual([["net"], ["a", "b"], ["app"]]);
    const two = prWavePlan(plan, estate, 2);
    expect(two).toMatchObject({ order: ["a", "b"], waves: [["a", "b"]], seeds: ["net"], digest: plan.digest });
    expect(prWavePlan(plan, estate, 2, ["a"])).toMatchObject({ order: ["b"], waves: [["b"]] });
    expect(prWavePlan(plan, estate, 2, ["a", "b"])).toMatchObject({ order: [], waves: [] });
    expect(prWavePlan(plan, estate, 4)).toMatchObject({ order: [], waves: [] });
  });

  const member = (name: string, digest: string, planner: "tofu" | "chant" = "tofu") => ({
    member: name,
    lexicon: planner === "tofu" ? "terraform" : "chant",
    planner,
    status: "planned" as const,
    planDigest: `jcs1-sha256:${digest.repeat(64)}`,
    holes: [],
  });
  const write = (name: string, cidr: unknown): ChangeSetEntry => ({
    member: name,
    lexicon: "terraform",
    planner: "tofu",
    address: `${name}.main`,
    type: "aws_subnet",
    action: "update",
    attributes: cidr === undefined ? [{ path: "cidr", unknown: true }] : [{ path: "cidr", after: cidr }],
  });

  test("waveNotCovered: the same plan, or one the approved plan knew only after apply, is covered; a moved value is not", () => {
    const approved = composeChangeSet([
      { member: member("a", "1"), entries: [write("a", "10.0.0.0/16")] },
      { member: member("b", "2"), entries: [write("b", undefined)] },
    ]);
    const same = composeChangeSet([{ member: member("a", "1"), entries: [write("a", "10.0.0.0/16")] }]);
    expect(waveNotCovered(approved, same)).toEqual([]);
    // b's cidr was known only after net applied: the value it has now is covered.
    const known = composeChangeSet([{ member: member("b", "3"), entries: [write("b", "10.1.0.0/16")] }]);
    expect(waveNotCovered(approved, known)).toEqual([]);
    const moved = composeChangeSet([{ member: member("a", "4"), entries: [write("a", "10.1.0.0/16")] }]);
    expect(waveNotCovered(approved, moved)).toEqual(["a now writes a.main.cidr to a different value than the approved plan"]);
  });

  test("waveNotCovered: a member whose planner describes no changes is covered only by the digest it was approved with", () => {
    const approved = composeChangeSet([{ member: member("job", "1", "chant"), entries: [] }]);
    expect(waveNotCovered(approved, composeChangeSet([{ member: member("job", "1", "chant"), entries: [] }]))).toEqual([]);
    const moved = waveNotCovered(approved, composeChangeSet([{ member: member("job", "2", "chant"), entries: [] }]));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/^job now plans to jcs1-sha256:2+, not the approved jcs1-sha256:1+, and its planner describes no changes to compare$/);
  });
});
