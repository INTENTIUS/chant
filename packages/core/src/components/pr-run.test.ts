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
import {
  applyPrSet,
  approvalOf,
  approversWithoutReview,
  decidePrGate,
  planCoveredBy,
  planPrSet,
  prReport,
  readOnlyLedger,
  resumePrSet,
  type PrPlanSet,
} from "./pr-run";
import { changeSetDigest, composeChangeSet, type ChangeSetEntry, type ChangeSetPart } from "../change-set";
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

  test("a dependent whose dependency applied in the earlier attempt applies its approved plan and says its inputs moved", async () => {
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
    // app is planned against the value it was approved with, not the one a wrote since.
    expect(w.planned).toEqual([{ root: "app", vars: { subnet: "a-v1" } }]);

    const second = await applyPrSet({
      components: ESTATE,
      plan: resumed.plan,
      registry: w.registry,
      env: "prod",
      set: resumed.set,
      resumed: { completed: ["a"], outputs },
    });
    expect(second.members.map((m) => [m.member, m.status, m.inputsMoved])).toEqual([
      ["a", "applied", undefined],
      ["app", "applied", ["a"]],
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
