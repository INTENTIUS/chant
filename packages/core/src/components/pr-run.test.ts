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
import {
  CapabilityRegistry,
  type CapabilityGroupOutcome,
  type DeployContext,
  type GroupContext,
  type GroupFallback,
  type GroupMember,
  type GroupRun,
  type PlannedOutputs,
} from "./capability";
import { findComponentGroups, groupFanOut } from "./groups";
import { failedRunExitCode } from "./driver";
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
import { changeSetDigest, changeSetDocumentDigest, composeChangeSet, isEmptyChangeSet, type ChangeSetEntry, type ChangeSetPart } from "../change-set";
import type { PrApplyRecord } from "./fan-out-record";
import { renderPrNote, type PrApproval } from "../pr-loop";
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
    /** `a` applying makes `app` plan a change its first plan did not show. */
    bumpAppOnApply: false,
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
      if (input.root === "a" && w.bumpAppOnApply) w.versions.app = "v2";
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

  test("each member names every upstream output it reads, the known ones too, and the apply report keeps them", async () => {
    const w = world();
    w.versions.a = "v2";
    const set = await planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
    // a reads net, which is not in the change: a read of a deployed output is a read too.
    expect(set.members.map((m) => [m.member, m.reads])).toEqual([
      ["a", [{ upstream: "net", outputs: ["cidr"] }]],
      ["app", [{ upstream: "a", outputs: ["id"] }]],
    ]);
    const applied = await applyPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod", set });
    expect(applied.members.find((m) => m.member === "app")?.reads).toEqual([{ upstream: "a", outputs: ["id"] }]);
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
    expect(set.members.find((m) => m.member === "app")?.reads).toEqual([{ upstream: "a", outputs: ["id"], unknown: ["id"] }]);

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

  const approvedFirst: PrApproval = { status: "approved", approvedBy: ["github:rev"] };

  test("the first approval covers the round that only fills in what was unknown: no gate of its own, recorded as covered (#4419)", async () => {
    const w = world();
    w.versions.a = "v2";
    w.predict.a = () => ({ known: {}, unknown: ["id"] });
    const set = await planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
    let asked = 0;
    const applied = await applyPrSet({
      components: ESTATE,
      plan: plan(),
      registry: w.registry,
      env: "prod",
      set,
      approval: approvedFirst,
      decideRound: async () => {
        asked++;
        return { satisfied: false, approval: { status: "pending" } };
      },
    });
    expect(asked).toBe(0);
    expect(applied.status).toBe("applied");
    expect(w.applied).toEqual(["a", "app"]);
    expect(w.ranWith.app).toEqual({ subnet: "a-v2" });
    expect(applied.rounds).toHaveLength(1);
    expect(applied.rounds![0]).toMatchObject({
      round: 2,
      status: "applied",
      approval: approvedFirst,
      covered: { digest: set.doc.digest, filledInputs: ["a.id"] },
    });
  });

  test("a round that plans a change the first plan did not show asks for its own approval, with the reason (#4419)", async () => {
    const w = world();
    w.versions.a = "v2";
    w.predict.a = () => ({ known: {}, unknown: ["id"] });
    w.bumpAppOnApply = true;
    const set = await planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
    const seen: Array<string | undefined> = [];
    const applied = await applyPrSet({
      components: ESTATE,
      plan: plan(),
      registry: w.registry,
      env: "prod",
      set,
      approval: approvedFirst,
      decideRound: async ({ notCovered }) => {
        seen.push(notCovered);
        return { satisfied: false, approval: { status: "pending" } };
      },
    });
    expect(applied.status).toBe("waiting");
    expect(w.applied).toEqual(["a"]);
    expect(seen).toEqual(["app now plans to update terraform_data.x, which the first plan did not"]);
    expect(applied.rounds![0]).toMatchObject({ status: "waiting", notCovered: seen[0] });
    expect(applied.rounds![0]!.covered).toBeUndefined();
  });

  test("a third member that reads a previewed member's known output is covered when the round plans that output as the same value (#4419)", async () => {
    const chain: DriverComponent[] = [
      root("x"),
      root("y", ["x"], { id: { stackOutput: { stack: "x", name: "id" } } }),
      root("z", ["y"], { port: { stackOutput: { stack: "y", name: "port" } } }),
    ];
    const w = world();
    w.state = { x: { id: "x-v1" }, y: { port: "8080" }, z: {} };
    w.versions.x = "v2";
    w.versions.y = "v2";
    w.versions.z = "v2";
    w.predict.x = () => ({ known: {}, unknown: ["id"] });
    w.predict.y = () => ({ known: { port: "8080" }, unknown: [] });
    w.predict.z = () => undefined;
    const chainPlan = planFanOut({ components: chain, changed: ["x"] });
    const set = await planPrSet({ components: chain, plan: chainPlan, registry: w.registry, env: "prod" });
    const seen: Array<string | undefined> = [];
    const applied = await applyPrSet({
      components: chain,
      plan: chainPlan,
      registry: w.registry,
      env: "prod",
      set,
      approval: approvedFirst,
      decideRound: async ({ notCovered }) => {
        seen.push(notCovered);
        return { satisfied: false, approval: { status: "pending" } };
      },
    });
    expect(seen).toEqual([]);
    expect(applied.status).toBe("applied");
    expect(w.applied).toEqual(["x", "y", "z"]);
    expect(applied.rounds![0]).toMatchObject({ round: 2, components: ["y", "z"], covered: { digest: set.doc.digest, filledInputs: ["x.id"] } });
  });

  test("an input the first plan read with a value that moved is not covered (#4419)", async () => {
    const w = world();
    w.versions.a = "v2";
    w.appliesAs = "a-v2-real";
    const set = await planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
    const seen: Array<string | undefined> = [];
    await applyPrSet({
      components: ESTATE,
      plan: plan(),
      registry: w.registry,
      env: "prod",
      set,
      approval: approvedFirst,
      decideRound: async ({ notCovered }) => {
        seen.push(notCovered);
        return { satisfied: false, approval: { status: "pending" } };
      },
    });
    expect(seen).toEqual(["app reads a.id, which the first plan read as another value"]);
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

describe("a digest a build in the same pull request publishes (#3999)", () => {
  /** `web-image` builds and publishes an image; `web` deploys it, and with `withSubnet` also reads `a.id`. */
  const estate = (withSubnet = false): DriverComponent[] => [
    root("a"),
    { name: "web-image", dependsOn: [], deploy: [{ phase: "Publish", steps: [{ kind: "fake-build" }] }] },
    root("web", withSubnet ? ["web-image", "a"] : ["web-image"], {
      image: "@web-image.publish.digest",
      ...(withSubnet ? { subnet: { stackOutput: { stack: "a", name: "id" } } } : {}),
    }),
  ];
  function buildWorld() {
    const w = world();
    let n = 0;
    w.registry.register({
      kind: "fake-build",
      async run() {
        n++;
        return { uri: "registry.example/web", digest: `sha256:built-${n}` };
      },
    } as never);
    return w;
  }
  const neverApproved = async () => ({ satisfied: false, approval: { status: "pending" as const } });

  test("image plus deploy in one pull request: the deploy plans with the digest unknown, lists it as the build's, and applies in one round", async () => {
    const w = buildWorld();
    const components = estate();
    const plan = planFanOut({ components, changed: ["web-image", "web"] });
    const set = await planPrSet({ components, plan, registry: w.registry, env: "prod" });
    expect(set.failed).toBe(false);
    const web = set.members.find((m) => m.member === "web")!;
    expect(web.buildInputs).toEqual(["web-image.publish.digest"]);
    expect(web.unknownInputs).toBeUndefined();

    let asked = 0;
    const applied = await applyPrSet({ components, plan, registry: w.registry, env: "prod", set, decideRound: async () => (asked++, neverApproved()) });
    expect(applied.status).toBe("applied");
    expect(asked).toBe(0);
    expect(applied.rounds).toBeUndefined();
    expect(w.ranWith.web).toEqual({ image: "sha256:built-1" });
    expect(applied.members.find((m) => m.member === "web")).toMatchObject({ status: "applied" });

    const note = renderPrNote(prReport({ stage: "plan", pr: 12, env: "prod", base: "1".repeat(40), head: "2".repeat(40), op: "pr-12", gate: "pr-apply", plan, signal: { changed: ["web-image", "web"], indeterminate: [], unclaimed: [] }, set, approval: { status: "pending" }, status: "planned" }));
    expect(note).toContain("From this pull request's build: `web` reads `web-image.publish.digest`. The image digest comes from this pull request's build");
    expect(note).not.toContain("Known only after apply");
  });

  test("a deploy that also reads an output known only after apply still goes to round 2", async () => {
    const w = buildWorld();
    w.versions.a = "v2";
    w.predict.a = () => ({ known: {}, unknown: ["id"] });
    const components = estate(true);
    const plan = planFanOut({ components, changed: ["a", "web-image", "web"] });
    const set = await planPrSet({ components, plan, registry: w.registry, env: "prod" });
    const web = set.members.find((m) => m.member === "web")!;
    expect(web.buildInputs).toEqual(["web-image.publish.digest"]);
    expect(web.unknownInputs).toEqual(["a.id"]);

    const applied = await applyPrSet({ components, plan, registry: w.registry, env: "prod", set, decideRound: neverApproved });
    expect(applied.status).toBe("waiting");
    expect(w.ranWith.web).toBeUndefined();
    // Held for a.id alone: the image digest is not a reason.
    expect(applied.members.find((m) => m.member === "web")).toMatchObject({ status: "waiting", round: 2, held: "its plan read a.id before that output applied as another value" });
    expect(applied.rounds?.map((r) => [r.gate, r.components])).toEqual([["pr-apply-round-2", ["web"]]]);
  });

  test("under --wave-gate, the approved set covers a wave whose member waited only on the build's digest", () => {
    const hole = (member: string, digest: string): ChangeSetPart => ({
      member: { member, lexicon: "aws", planner: "chant", status: "planned", planDigest: `jcs1-sha256:${digest.repeat(64)}`, holes: [{ address: member, reason: "inputs from web-image; re-checked on apply" }] },
      entries: [],
    });
    const approvedDoc = composeChangeSet([hole("web", "1")]);
    const fresh = composeChangeSet([
      {
        member: { member: "web", lexicon: "aws", planner: "chant", status: "planned", planDigest: `jcs1-sha256:${"2".repeat(64)}`, holes: [] },
        entries: [{ member: "web", lexicon: "aws", planner: "chant", address: "Service", type: "AWS::ECS::Service", action: "update", attributes: [{ path: "Image", after: "sha256:built-1" }] }],
      },
    ]);
    const member = (extra: Record<string, unknown>) => [{ member: "web", component: "web", planDigest: null, status: "planned" as const, counts: { create: 0, update: 0, replace: 0, delete: 0 }, ...extra }];
    expect(waveNotCovered(approvedDoc, fresh, member({ buildInputs: ["web-image.publish.digest"] }))).toEqual([]);
    expect(waveNotCovered(approvedDoc, fresh, member({ buildInputs: ["web-image.publish.digest"], unknownInputs: ["a.id"] }))).toHaveLength(1);
    expect(waveNotCovered(approvedDoc, fresh)).toHaveLength(1);
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

/**
 * One decision for a round, a resume and a wave (#4422). The same estate and
 * the same two outcomes go through `applyPrSet`'s round, `resumePrSet` and
 * `waveNotCovered` (what `--wave-gate` uses), and each path must give the same
 * verdict with the same reason.
 */
describe("one coverage decision on a round, a resume and a wave (#4422)", () => {
  const plan = () => planFanOut({ components: ESTATE, changed: ["a"] });
  const approvedFirst: PrApproval = { status: "approved", approvedBy: ["github:rev"] };
  /** `a` v2, whose id is known only after apply; `app` reads it. */
  async function first(w: ReturnType<typeof world>) {
    w.versions.a = "v2";
    w.predict.a = () => ({ known: {}, unknown: ["id"] });
    return planPrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod" });
  }

  const paths: Record<string, (extra: boolean) => Promise<string | undefined>> = {
    round: async (extra) => {
      const w = world();
      const set = await first(w);
      w.bumpAppOnApply = extra;
      let reason: string | undefined;
      const applied = await applyPrSet({
        components: ESTATE,
        plan: plan(),
        registry: w.registry,
        env: "prod",
        set,
        approval: approvedFirst,
        decideRound: async ({ notCovered }) => {
          reason = notCovered;
          return { satisfied: false, approval: { status: "pending" } };
        },
      });
      expect(applied.status).toBe(extra ? "waiting" : "applied");
      return reason;
    },
    resume: async (extra) => {
      const w = world();
      const set = await first(w);
      w.state.a = { id: "a-v2" };
      if (extra) w.versions.app = "v2";
      const resumed = await resumePrSet({ components: ESTATE, plan: plan(), registry: w.registry, env: "prod", record: recordOf(set), completed: ["a"] });
      return resumed.ok ? undefined : resumed.reasons[0];
    },
    wave: async (extra) => {
      const w = world();
      const set = await first(w);
      if (extra) w.versions.app = "v2";
      const wavePlan = prWavePlan(plan(), ESTATE, 2);
      const fresh = await planPrSet({ components: ESTATE, plan: wavePlan, registry: w.registry, env: "prod", seededOutputs: { ...set.outputs, a: { id: "a-v2" } } });
      return waveNotCovered(set.doc, fresh.doc, set.members)[0];
    },
  };

  test.each([
    ["only the previewed unknown filled in", false, undefined],
    ["an entry the first plan did not show", true, "app now plans to update terraform_data.x, which the first plan did not"],
  ] as const)("%s", async (_name, extra, expected) => {
    for (const [path, decide] of Object.entries(paths)) {
      expect({ path, reason: await decide(extra) }).toEqual({ path, reason: expected });
    }
  });

  test("a member that was a hole with no preview is not covered by an approval that never saw its shape", () => {
    const part = (digest: string, entries: ChangeSetEntry[], holes: ChangeSetPart["member"]["holes"]): ChangeSetPart => ({
      member: { member: "svc", lexicon: "aws", planner: "chant", status: "planned", planDigest: `jcs1-sha256:${digest.repeat(64)}`, holes },
      entries,
    });
    const approved = composeChangeSet([part("1", [], [{ address: "svc", reason: "inputs from net; re-checked on apply" }])]);
    const entry: ChangeSetEntry = { member: "svc", lexicon: "aws", planner: "chant", address: "Queue", type: "AWS::SQS::Queue", action: "create", attributes: [] };
    const fresh = composeChangeSet([part("2", [entry], [])]);
    const members = [{ member: "svc", component: "svc", planDigest: null, status: "planned" as const, counts: { create: 0, update: 0, replace: 0, delete: 0 }, unknownInputs: ["net.id"] }];
    // Even with the input named unknown, nothing was previewed to cover a create.
    expect(waveNotCovered(approved, fresh, members)).toEqual(["svc now plans to create Queue, which the first plan did not"]);
    expect(waveNotCovered(approved, fresh)).toEqual(["svc now plans to create Queue, which the first plan did not"]);
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

describe("a group planned and applied as one (ws-107, #4440)", () => {
  interface StackInput {
    root: string;
    vars?: Record<string, unknown>;
  }
  const so = (stack: string, name: string) => ({ stackOutput: { stack, name } });
  const stack = (name: string, dependsOn: string[] = [], vars?: Record<string, unknown>): DriverComponent => ({
    name,
    dependsOn,
    deploy: [{ phase: "Apply", steps: [{ kind: "fake-stack", root: name, ...(vars ? { vars } : {}) }] }],
  });
  const plainStack = (name: string, dependsOn: string[] = [], vars?: Record<string, unknown>): DriverComponent => ({
    name,
    dependsOn,
    deploy: [{ phase: "Apply", steps: [{ kind: "fake-plain", root: name, ...(vars ? { vars } : {}) }] }],
  });
  /** a; b reads a's new id; c reads b's. */
  const ABC = [stack("a"), stack("b", ["a"], { upstream: so("a", "id") }), stack("c", ["b"], { upstream: so("b", "id") })];

  /**
   * `fake-stack` creates one resource and exposes an `id` known only after
   * it applies. With `group`, it declares `planGroup` and `runGroup`;
   * `fallback` adds a `groupFallback`. `fake-plain` never groups, and its
   * plan knows the `id` it will expose.
   */
  function groupWorld(opts: { group?: boolean; fallback?: GroupFallback } = {}) {
    const w = {
      registry: new CapabilityRegistry(),
      planned: [] as string[],
      applied: [] as string[],
      planGroupCalls: [] as string[][],
      runGroupCalls: [] as Array<{ components: string[]; run: GroupRun; members: GroupMember[] }>,
      planThrows: undefined as unknown,
      runThrows: undefined as unknown,
      outcome: undefined as ((members: readonly GroupMember[]) => CapabilityGroupOutcome) | undefined,
      /** Roots whose plan also creates `res.extra`, a change no earlier plan showed. */
      extra: new Set<string>(),
    };
    const planOf = (input: StackInput, known: boolean) => {
      const planDigest = computePlanDigest("fake-stack", { root: input.root, vars: input.vars ?? null });
      const outputs: PlannedOutputs = known ? { known: { id: `${input.root}-id` }, unknown: [] } : { known: {}, unknown: ["id"] };
      return {
        member: input.root,
        planDigest,
        artifact: { planDigest },
        outputs,
        changeSet: {
          member: { member: input.root, lexicon: "test", planner: "tofu" as const, status: "planned" as const, planDigest, holes: [] },
          entries: [
            { member: input.root, lexicon: "test", planner: "tofu" as const, address: "res.x", type: "res", action: "create" as const, attributes: [] },
            ...(w.extra.has(input.root)
              ? [{ member: input.root, lexicon: "test", planner: "tofu" as const, address: "res.extra", type: "res", action: "create" as const, attributes: [] }]
              : []),
          ],
        },
      };
    };
    w.registry.register({
      kind: "fake-stack",
      async plan(_ctx: DeployContext, input: StackInput) {
        w.planned.push(input.root);
        return planOf(input, false);
      },
      async run(_ctx: DeployContext, input: StackInput) {
        w.applied.push(input.root);
        return { outputs: { id: `${input.root}-id` } };
      },
      ...(opts.group
        ? {
            async planGroup(_ctx: GroupContext, members: readonly GroupMember<StackInput>[]) {
              w.planGroupCalls.push(members.map((m) => m.component));
              if (w.planThrows) throw w.planThrows;
              return {
                members: Object.fromEntries(members.map((m) => [m.component, planOf(m.input!, false)])),
                digest: computePlanDigest("fake-composition", members.map((m) => m.component)),
                artifact: { composed: members.map((m) => m.component) },
              };
            },
            async runGroup(_ctx: GroupContext, run: GroupRun, members: readonly GroupMember<StackInput>[]) {
              w.runGroupCalls.push({ components: members.map((m) => m.component), run, members: [...members] });
              if (w.runThrows) throw w.runThrows;
              if (w.outcome) return w.outcome(members);
              return { members: Object.fromEntries(members.map((m) => [m.component, { status: "applied" as const, outputs: { id: `${m.component}-id` } }])) };
            },
          }
        : {}),
      ...(opts.fallback ? { groupFallback: async () => opts.fallback } : {}),
    } as never);
    w.registry.register({
      kind: "fake-plain",
      async plan(_ctx: DeployContext, input: StackInput) {
        w.planned.push(input.root);
        const p = planOf(input, true);
        return { ...p, changeSet: { member: p.changeSet.member, entries: [] } };
      },
      async run(_ctx: DeployContext, input: StackInput) {
        w.applied.push(input.root);
        return { outputs: { id: `${input.root}-id` } };
      },
    } as never);
    return w;
  }

  /** The fan-out `pr.ts`'s prepare step derives: planFanOut, then the groups placed. */
  async function prepared(components: DriverComponent[], changed: string[], registry: CapabilityRegistry): Promise<FanOutPlan> {
    const plan = planFanOut({ components, changed });
    return groupFanOut(plan, components, await findComponentGroups({ components, plan, registry, env: "prod" }));
  }

  const approvedBy = async (digest: string) =>
    approvalOf(await decidePrGate(memoryGateLedgerPort({ resolutions: [approval(digest)] }), { op: "pr-12", gate: "pr-apply", digest, now: NOW }));

  test("A, B reading A's new output and C reading B's: one planGroup call, one digest, no unknownInputs, one runGroup call under one approval", async () => {
    const w = groupWorld({ group: true });
    const plan = await prepared(ABC, ["a"], w.registry);
    expect(plan.groups).toEqual([{ capability: "fake-stack", components: ["a", "b", "c"] }]);
    expect(plan.waves).toEqual([["a", "b", "c"], [], []]);

    const set = await planPrSet({ components: ABC, plan, registry: w.registry, env: "prod" });
    expect(w.planGroupCalls).toEqual([["a", "b", "c"]]);
    expect(w.planned).toEqual([]);
    expect(set.failed).toBe(false);
    expect(set.members.map((m) => [m.member, m.status, m.unknownInputs])).toEqual([
      ["a", "planned", undefined],
      ["b", "planned", undefined],
      ["c", "planned", undefined],
    ]);
    // The report still draws the line from b to a, unknown at plan.
    expect(set.members.find((m) => m.member === "b")?.reads).toEqual([{ upstream: "a", outputs: ["id"], unknown: ["id"] }]);
    const groupDigest = set.groups?.[0]?.digest;
    expect(groupDigest).toEqual(expect.stringMatching(/sha256:/));
    expect(set.doc.members.map((m) => [m.member, m.group])).toEqual([
      ["a", { digest: groupDigest, reads: [] }],
      ["b", { digest: groupDigest, reads: ["a.id"] }],
      ["c", { digest: groupDigest, reads: ["b.id"] }],
    ]);
    // The member's digest binds the group's; the document's binds every member's.
    expect(set.doc.members.find((m) => m.member === "a")?.planDigest).toBe(
      computePlanDigest("capability-group-member", { plan: computePlanDigest("fake-stack", { root: "a", vars: null }), group: groupDigest }),
    );
    expect(set.doc.digest).toBe(changeSetDocumentDigest(set.doc));
    // Ruling 4: unknown reads inside the group keep the change set from passing as empty.
    expect(isEmptyChangeSet(set.doc)).toBe(false);

    const firstApproval = await approvedBy(set.doc.digest);
    expect(firstApproval.status).toBe("approved");
    let asked = 0;
    const applied = await applyPrSet({
      components: ABC,
      plan,
      registry: w.registry,
      env: "prod",
      set,
      approval: firstApproval,
      decideRound: async () => {
        asked++;
        return { satisfied: false, approval: { status: "pending" } };
      },
    });
    expect(w.runGroupCalls.map((c) => c.components)).toEqual([["a", "b", "c"]]);
    expect(w.applied).toEqual([]);
    expect(asked).toBe(0);
    expect(applied.rounds).toBeUndefined();
    expect(applied.status).toBe("applied");
    expect(applied.members.map((m) => [m.member, m.status])).toEqual([
      ["a", "applied"],
      ["b", "applied"],
      ["c", "applied"],
    ]);
    // runGroup got the bound group digest, the artifact planGroup gave, and b's read of a left out of its input.
    const call = w.runGroupCalls[0]!;
    expect(call.run.digest).toBe(groupDigest);
    expect(call.run.artifact).toEqual({ composed: ["a", "b", "c"] });
    expect(call.members[1]).toMatchObject({ component: "b", input: { root: "b", vars: {} }, reads: [{ at: "/vars/upstream", ref: "a.id", component: "a", output: "id" }] });
    expect(applied.run.componentOutputs.c).toEqual({ id: "c-id" });
  });

  test("the same three without planGroup plan and apply as on main: one by one, B and C wait on unknown inputs for a round", async () => {
    const w = groupWorld();
    const derived = planFanOut({ components: ABC, changed: ["a"] });
    const plan = await prepared(ABC, ["a"], w.registry);
    expect(plan).toEqual(derived);

    const set = await planPrSet({ components: ABC, plan, registry: w.registry, env: "prod" });
    expect(w.planGroupCalls).toEqual([]);
    expect(w.planned).toEqual(["a", "b", "c"]);
    expect(set.groups).toBeUndefined();
    expect(set.doc.members.every((m) => m.group === undefined)).toBe(true);
    expect(set.members.map((m) => [m.member, m.unknownInputs])).toEqual([
      ["a", undefined],
      ["b", ["a.id"]],
      ["c", ["b.id"]],
    ]);
    const applied = await applyPrSet({
      components: ABC,
      plan,
      registry: w.registry,
      env: "prod",
      set,
      approval: await approvedBy(set.doc.digest),
      decideRound: async () => ({ satisfied: false, approval: { status: "pending" } }),
    });
    expect(w.runGroupCalls).toEqual([]);
    expect(w.applied[0]).toBe("a");
    const round = applied.rounds?.[0];
    expect(round?.round).toBe(2);
    expect(round?.covered !== undefined || round?.status === "waiting").toBe(true);
  });

  test("a capability that refuses the set says why; the members plan one by one and the reason is in the plan set", async () => {
    const w = groupWorld({ group: true, fallback: { kind: "too-many", reason: "fake-stack composes two at most" } });
    const plan = await prepared(ABC, ["a"], w.registry);
    expect(plan.groups).toBeUndefined();
    const set = await planPrSet({ components: ABC, plan, registry: w.registry, env: "prod" });
    expect(w.planGroupCalls).toEqual([]);
    expect(w.planned).toEqual(["a", "b", "c"]);
    expect(set.fallbacks).toEqual(
      ["a", "b", "c"].map((component) => ({ component, capability: "fake-stack", kind: "too-many", reason: "fake-stack composes two at most" })),
    );
    expect(set.members.find((m) => m.member === "b")?.unknownInputs).toEqual(["a.id"]);
  });

  test("two plans of one group on one estate give one digest; a group with one more member gives another", async () => {
    const w = groupWorld({ group: true });
    const plan = await prepared(ABC, ["a"], w.registry);
    const first = await planPrSet({ components: ABC, plan, registry: w.registry, env: "prod" });
    const again = await planPrSet({ components: ABC, plan, registry: w.registry, env: "prod" });
    expect(again.doc.digest).toBe(first.doc.digest);
    expect(again.groups?.[0]?.digest).toBe(first.groups?.[0]?.digest);

    const ABCE = [...ABC, stack("e", ["c"], { upstream: so("c", "id") })];
    const wider = await prepared(ABCE, ["a"], w.registry);
    expect(wider.groups).toEqual([{ capability: "fake-stack", components: ["a", "b", "c", "e"] }]);
    const more = await planPrSet({ components: ABCE, plan: wider, registry: w.registry, env: "prod" });
    expect(more.groups?.[0]?.digest).not.toBe(first.groups?.[0]?.digest);
    // a plans the same on its own, and still its digest moves with the group's.
    const a = (s: PrPlanSet) => s.doc.members.find((m) => m.member === "a")?.planDigest;
    expect(a(more)).not.toBe(a(first));
    expect(more.doc.digest).not.toBe(first.doc.digest);
  });

  test("a runGroup that applies A, fails on B and never starts C: A applied, B failed, C not-started, and what depends on C outside the group is blocked by it", async () => {
    const w = groupWorld({ group: true });
    w.outcome = () => ({
      members: {
        a: { status: "applied", outputs: { id: "a-id" } },
        b: { status: "failed", error: "b: quota exceeded" },
        c: { status: "not-started" },
      },
    });
    const components = [...ABC, plainStack("d", ["c"], { upstream: so("c", "id") })];
    const plan = await prepared(components, ["a"], w.registry);
    expect(plan.waves).toEqual([["a", "b", "c"], [], [], ["d"]]);
    const set = await planPrSet({ components, plan, registry: w.registry, env: "prod" });
    const applied = await applyPrSet({ components, plan, registry: w.registry, env: "prod", set, approval: await approvedBy(set.doc.digest) });
    expect(applied.status).toBe("failed");
    expect(Object.fromEntries(applied.members.map((m) => [m.member, m.status]))).toEqual({ a: "applied", b: "failed", c: "not-started", d: "blocked" });
    expect(applied.members.find((m) => m.member === "b")?.error).toBe("b: quota exceeded");
    expect(applied.members.find((m) => m.member === "d")?.blockedBy).toBe("c");
    expect(applied.run.notStarted).toEqual(["c"]);
    expect(applied.run.componentOutputs.a).toEqual({ id: "a-id" });
    expect(w.applied).toEqual([]);
    // pr-apply exits with the failed run's code.
    expect(failedRunExitCode(applied.run.results)).toBe(1);
  });

  test("a runGroup that throws a moved plan leaves every member not-started and exits 3; any other throw fails every member", async () => {
    const moved = groupWorld({ group: true });
    moved.runThrows = Object.assign(new Error("the target moved since it was planned"), { planMoved: true });
    const plan = await prepared(ABC, ["a"], moved.registry);
    const set = await planPrSet({ components: ABC, plan, registry: moved.registry, env: "prod" });
    const stopped = await applyPrSet({ components: ABC, plan, registry: moved.registry, env: "prod", set });
    expect(stopped.members.map((m) => m.status)).toEqual(["not-started", "not-started", "not-started"]);
    expect(failedRunExitCode(stopped.run.results)).toBe(3);

    const broken = groupWorld({ group: true });
    broken.runThrows = new Error("connection reset");
    const set2 = await planPrSet({ components: ABC, plan, registry: broken.registry, env: "prod" });
    const failed = await applyPrSet({ components: ABC, plan, registry: broken.registry, env: "prod", set: set2 });
    expect(failed.members.map((m) => [m.status, m.error])).toEqual([
      ["failed", "connection reset"],
      ["failed", "connection reset"],
      ["failed", "connection reset"],
    ]);
    expect(failedRunExitCode(failed.run.results)).toBe(1);
  });

  test("a planGroup that throws makes every member plan-failed, and nothing falls back", async () => {
    const w = groupWorld({ group: true });
    w.planThrows = new Error("cannot compose: backends differ");
    const plan = await prepared(ABC, ["a"], w.registry);
    const set = await planPrSet({ components: ABC, plan, registry: w.registry, env: "prod" });
    expect(set.failed).toBe(true);
    expect(w.planned).toEqual([]);
    expect(set.members.map((m) => [m.member, m.status, m.error])).toEqual([
      ["a", "plan-failed", "cannot compose: backends differ"],
      ["b", "plan-failed", "cannot compose: backends differ"],
      ["c", "plan-failed", "cannot compose: backends differ"],
    ]);
    expect(set.groups).toEqual([{ capability: "fake-stack", components: ["a", "b", "c"], digest: null, error: "cannot compose: backends differ" }]);
  });

  test("under --wave-gate the group is part of the wave it was placed in, and the wave's digest covers it", async () => {
    const w = groupWorld({ group: true });
    const components = [plainStack("x"), stack("a", ["x"], { upstream: so("x", "id") }), stack("b", ["a"], { upstream: so("a", "id") }), stack("c", ["b"], { upstream: so("b", "id") })];
    const plan = await prepared(components, ["x"], w.registry);
    expect(plan.waves).toEqual([["x"], ["a", "b", "c"], [], []]);
    const approved = await planPrSet({ components, plan, registry: w.registry, env: "prod" });

    const wave = prWavePlan(plan, components, 2, ["x"]);
    expect(wave.groups).toEqual(plan.groups);
    const fresh = await planPrSet({ components, plan: wave, registry: w.registry, env: "prod", seededOutputs: approved.outputs });
    expect(w.planGroupCalls).toEqual([
      ["a", "b", "c"],
      ["a", "b", "c"],
    ]);
    expect(fresh.doc.members.map((m) => m.member)).toEqual(["a", "b", "c"]);
    expect(fresh.doc.members.map((m) => m.group?.digest)).toEqual(approved.doc.members.filter((m) => m.member !== "x").map((m) => m.group?.digest));
    expect(waveNotCovered(approved.doc, fresh.doc, approved.members, { approved: approved.shapes, fresh: fresh.shapes })).toEqual([]);
    // A wave whose group composed differently is not covered by the digest.
    const other = groupWorld({ group: true });
    const wider = [...components, stack("e", ["c"], { upstream: so("c", "id") })];
    const widerPlan = await prepared(wider, ["x"], other.registry);
    const widerWave = await planPrSet({ components: wider, plan: prWavePlan(widerPlan, wider, 2, ["x"]), registry: other.registry, env: "prod", seededOutputs: approved.outputs });
    const a = (s: PrPlanSet) => s.doc.members.find((m) => m.member === "a")?.planDigest;
    expect(a(widerWave)).not.toBe(a(approved));
  });

  describe("the report names each group and member outcome, and a resume plans what is left (#4446)", () => {
    const at = { pr: 12, env: "prod", base: "1".repeat(40), head: "2".repeat(40), op: "pr-12", gate: "pr-apply" };
    const signal = { changed: ["a"], indeterminate: [], unclaimed: [] };
    /** A, B and C, where B fails and C never starts. */
    const failOnB = (w: ReturnType<typeof groupWorld>) => {
      w.outcome = () => ({
        members: {
          a: { status: "applied", outputs: { id: "a-id" } },
          b: { status: "failed", error: "b: quota exceeded" },
          c: { status: "not-started" },
        },
      });
    };
    /** The first attempt: plan, approve, apply with B failing. What a `--resume` record keeps. */
    async function failedAttempt(w: ReturnType<typeof groupWorld>) {
      failOnB(w);
      const plan = await prepared(ABC, ["a"], w.registry);
      const set = await planPrSet({ components: ABC, plan, registry: w.registry, env: "prod" });
      const firstApproval = await approvedBy(set.doc.digest);
      const first = await applyPrSet({ components: ABC, plan, registry: w.registry, env: "prod", set, approval: firstApproval });
      w.outcome = undefined;
      return { plan, set, first, firstApproval, record: recordOf(set) };
    }

    test("a plan report for the three-member group lists one group with three members, its wave and the group digest", async () => {
      const w = groupWorld({ group: true });
      const plan = await prepared(ABC, ["a"], w.registry);
      const set = await planPrSet({ components: ABC, plan, registry: w.registry, env: "prod" });
      const report = prReport({ stage: "plan", ...at, plan, signal, set, approval: { status: "pending" }, status: "planned" });
      expect(report.groups).toEqual([
        {
          capability: "fake-stack",
          components: ["a", "b", "c"],
          wave: 1,
          digest: set.groups![0]!.digest,
          reads: [
            { component: "b", ref: "a.id" },
            { component: "c", ref: "b.id" },
          ],
        },
      ]);
      expect(report.groups![0]!.digest).toEqual(expect.stringMatching(/sha256:/));
      expect(report.fallbacks).toBeUndefined();
      expect(report.members.map((m) => [m.member, m.group, m.groupOutcome])).toEqual([
        ["a", 0, undefined],
        ["b", 0, undefined],
        ["c", 0, undefined],
      ]);
      // The run's artifact stays in the process that planned.
      expect(JSON.stringify(report.groups)).not.toContain("composed");
      const note = renderPrNote(report);
      expect(note).toContain("`a`, `b` and `c` plan and apply as one (`fake-stack`, wave 1); `b` reads `a.id` and `c` reads `b.id`, known when the group applies.");
    });

    test("an apply report after a failure on B lists A applied, B failed, C not-started, and the note says plainly that A stays applied", async () => {
      const w = groupWorld({ group: true });
      const { plan, set, first, firstApproval } = await failedAttempt(w);
      const report = prReport({ stage: "apply", ...at, plan, signal, set, approval: firstApproval, status: first.status, members: first.members });
      expect(report.status).toBe("failed");
      expect(report.members.map((m) => [m.member, m.status, m.groupOutcome, m.group])).toEqual([
        ["a", "applied", "applied", 0],
        ["b", "failed", "failed", 0],
        ["c", "not-started", "not-started", 0],
      ]);
      const note = renderPrNote(report);
      expect(note).toContain("The apply failed: 1 failed, 1 not started, 1 applied.");
      expect(note).toContain("The group's apply stopped part way: `a` applied and stays applied; `b` failed; `c` did not start. Nothing that applied is undone.");
      expect(note).toContain("`pr-apply --resume` plans `b` and `c` again");
    });

    test("pr-apply --resume on that record plans B and C only, as a smaller group, and applies them under the first approval", async () => {
      const w = groupWorld({ group: true });
      const { plan, set, first, firstApproval, record } = await failedAttempt(w);
      expect(first.run.completed).toEqual(["a"]);
      w.planGroupCalls.length = 0;
      w.runGroupCalls.length = 0;

      const resumed = await resumePrSet({ components: ABC, plan, registry: w.registry, env: "prod", record, completed: first.run.completed, applied: { a: first.run.componentOutputs.a! } });
      if (!resumed.ok) throw new Error(resumed.reasons.join("; "));
      expect(resumed.plan.order).toEqual(["b", "c"]);
      expect(resumed.plan.groups).toEqual([{ capability: "fake-stack", components: ["b", "c"] }]);
      expect(w.planGroupCalls).toEqual([["b", "c"]]);
      expect(w.planned).toEqual([]);
      // The smaller group's digest is not the approved one, so coverage rested on entries.
      expect(resumed.fresh.groups?.[0]?.digest).not.toBe(set.groups?.[0]?.digest);
      expect(resumed.set.doc.digest).toBe(set.doc.digest);
      expect(resumed.set.groups?.map((g) => g.components)).toEqual([["b", "c"]]);

      let asked = 0;
      const applied = await applyPrSet({
        components: ABC,
        plan: resumed.plan,
        registry: w.registry,
        env: "prod",
        set: resumed.set,
        approval: firstApproval,
        resumed: { completed: first.run.completed, outputs: { a: first.run.componentOutputs.a! } },
        decideRound: async () => {
          asked++;
          return { satisfied: false, approval: { status: "pending" } };
        },
      });
      expect(asked).toBe(0);
      expect(applied.rounds).toBeUndefined();
      expect(applied.status).toBe("applied");
      // B planned and applied against the id A applied with.
      expect(w.runGroupCalls.map((c) => c.components)).toEqual([["b", "c"]]);
      expect(w.runGroupCalls[0]!.members[0]).toMatchObject({ component: "b", input: { root: "b", vars: { upstream: "a-id" } } });
      expect(applied.members.map((m) => [m.member, m.status, m.groupOutcome])).toEqual([
        ["a", "applied", undefined],
        ["b", "applied", "applied"],
        ["c", "applied", "applied"],
      ]);
      const report = prReport({ stage: "apply", ...at, plan, signal, set: resumed.set, approval: firstApproval, status: applied.status, members: applied.members, resumed: first.run.completed });
      expect(report.groups?.map((g) => g.components)).toEqual([["b", "c"]]);
      expect(report.members.map((m) => [m.member, m.group])).toEqual([
        ["a", undefined],
        ["b", 0],
        ["c", 0],
      ]);
    });

    test("a resume whose new plans the approved set does not cover carries nothing, and the new plan waits at its gate", async () => {
      const w = groupWorld({ group: true });
      const { plan, set, first, record } = await failedAttempt(w);
      w.extra.add("c");
      const resumed = await resumePrSet({ components: ABC, plan, registry: w.registry, env: "prod", record, completed: first.run.completed, applied: { a: first.run.componentOutputs.a! } });
      expect(resumed.ok).toBe(false);
      if (resumed.ok) return;
      expect(resumed.reasons.join("; ")).toMatch(/res\.extra/);
      // pr-apply then plans every member again, and that plan's digest has no approval of its own.
      const again = await planPrSet({ components: ABC, plan, registry: w.registry, env: "prod" });
      expect(again.doc.digest).not.toBe(set.doc.digest);
      const ledger = memoryGateLedgerPort({ resolutions: [approval(set.doc.digest)] });
      const check = await decidePrGate(ledger, { op: "pr-12", gate: "pr-apply", digest: again.doc.digest, now: NOW });
      expect(check.satisfied).toBe(false);
      expect(approvalOf(check).status).toBe("changed");
    });

    test("a resume whose capability refuses the smaller group plans what is left one by one, and says why", async () => {
      const w = groupWorld({ group: true });
      const { plan, first, record } = await failedAttempt(w);
      // From here on the capability takes no group.
      const refusing = groupWorld({ group: true, fallback: { kind: "too-many", reason: "fake-stack composes three or none" } });
      const resumed = await resumePrSet({ components: ABC, plan, registry: refusing.registry, env: "prod", record, completed: first.run.completed, applied: { a: first.run.componentOutputs.a! } });
      expect(refusing.planGroupCalls).toEqual([]);
      expect(refusing.planned).toEqual(["b", "c"]);
      const fresh = resumed.fresh!;
      expect(fresh.groups).toBeUndefined();
      expect(fresh.fallbacks).toEqual(["b", "c"].map((component) => ({ component, capability: "fake-stack", kind: "too-many", reason: "fake-stack composes three or none" })));
    });

    test("a set the capability refused is under fallbacks with its reason, and the note prints it; kind off is reported and not printed", async () => {
      const w = groupWorld({ group: true, fallback: { kind: "too-many", reason: "fake-stack composes two at most" } });
      const plan = await prepared(ABC, ["a"], w.registry);
      const set = await planPrSet({ components: ABC, plan, registry: w.registry, env: "prod" });
      const report = prReport({ stage: "plan", ...at, plan, signal, set, approval: { status: "pending" }, status: "planned" });
      expect(report.groups).toBeUndefined();
      expect(report.fallbacks).toEqual(
        ["a", "b", "c"].map((component) => ({ component, capability: "fake-stack", kind: "too-many", reason: "fake-stack composes two at most" })),
      );
      expect(report.members.every((m) => m.group === undefined)).toBe(true);
      expect(renderPrNote(report)).toContain("Planned one by one, not as a group: `a`, `b`, `c` (`too-many`): fake-stack composes two at most.");

      const off = groupWorld({ group: true, fallback: { kind: "off", reason: "terraform.compose is not set" } });
      const offPlan = await prepared(ABC, ["a"], off.registry);
      const offSet = await planPrSet({ components: ABC, plan: offPlan, registry: off.registry, env: "prod" });
      const offReport = prReport({ stage: "plan", ...at, plan: offPlan, signal, set: offSet, approval: { status: "pending" }, status: "planned" });
      expect(offReport.fallbacks?.map((f) => f.kind)).toEqual(["off", "off", "off"]);
      expect(renderPrNote(offReport)).not.toContain("not as a group");
    });
  });
});
