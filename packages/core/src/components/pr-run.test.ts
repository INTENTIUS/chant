/**
 * Planning and applying a pull request's members (#3183), against a fake
 * root capability and an in-memory gate ledger. The five-root run against
 * real `tofu` roots is `lexicons/terraform/src/components/pr-loop.tofu.test.ts`.
 *
 * The capability stands in for `terraform-apply`: `plan` returns the root, a
 * digest over what it would write (its `version` and every input) and a
 * change-set part; `outputs` reads what it exposes now; `run` applies.
 */

import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type DeployContext } from "./capability";
import { memoryGateLedgerPort } from "../op/gate";
import { planFanOut } from "./fan-out";
import { applyPrSet, approvalOf, approversWithoutReview, decidePrGate, planPrSet, readOnlyLedger } from "./pr-run";
import { changeSetDigest } from "../change-set";
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
    fromPlan: {} as Record<string, boolean>,
    failing: new Set<string>(),
    planFailing: new Set<string>(),
  };
  const digestOf = (input: RootInput) => computePlanDigest("fake-root", { root: input.root, version: w.versions[input.root] ?? "v1", vars: input.vars ?? null });
  w.registry.register({
    kind: "fake-root",
    async plan(_ctx: DeployContext, input: RootInput) {
      w.planned.push({ root: input.root, ...(input.vars ? { vars: input.vars } : {}) });
      if (w.planFailing.has(input.root)) throw new Error(`${input.root}: no value for a required variable`);
      const planDigest = digestOf(input);
      const changes = (w.versions[input.root] ?? "v1") !== "v1";
      return {
        member: input.root,
        planDigest,
        artifact: { planDigest },
        changeSet: {
          member: { member: input.root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest, holes: [] },
          entries: changes
            ? [{ member: input.root, lexicon: "terraform", planner: "tofu", address: "terraform_data.x", type: "terraform_data", action: "update", attributes: [] }]
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
      if (w.failing.has(input.root)) throw new Error(`${input.root} failed`);
      w.applied.push(input.root);
      if (input.root === "a") w.state.a = { id: `a-${w.versions.a ?? "v1"}` };
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
  test("plans the changed root and its dependents, each against the outputs its dependency has now", async () => {
    const w = world();
    w.versions.a = "v2";
    const plan = planFanOut({ components: ESTATE, changed: ["a"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });

    expect(plan.order).toEqual(["a", "app"]);
    expect(w.planned).toEqual([
      { root: "a", vars: { cidr: "10.0.0.0/16" } },
      { root: "app", vars: { subnet: "a-v1" } },
    ]);
    // net is read for a, and a for app, before anything applies.
    expect(w.outputsRead).toEqual(["net", "a"]);
    expect(set.members.map((m) => [m.member, m.status, m.counts.update])).toEqual([
      ["a", "planned", 1],
      ["app", "planned", 0],
    ]);
    expect(set.doc.digest).toBe(changeSetDigest(set.members.map((m) => ({ member: m.member, planDigest: m.planDigest }))));
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
});

describe("applyPrSet", () => {
  test("applies each member's approved plan in order and marks a dependent whose inputs moved", async () => {
    const w = world();
    w.versions.a = "v2";
    const plan = planFanOut({ components: ESTATE, changed: ["a"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });
    const { members, status } = await applyPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", set });

    expect(status).toBe("applied");
    expect(w.applied).toEqual(["a", "app"]);
    expect(w.fromPlan).toEqual({ a: true, app: true });
    expect(members.map((m) => [m.member, m.status, m.inputsMoved])).toEqual([
      ["a", "applied", undefined],
      ["app", "applied", ["a"]],
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
