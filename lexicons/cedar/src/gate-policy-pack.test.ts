/**
 * The starter gate policy pack and the gate's Cedar schema (chant#3182),
 * evaluated by the real cedar-wasm against plan summaries core builds from
 * change sets. The Done-when of #3182 is the first describe: a gate denies an
 * agent's approval of a plan that deletes an RDS instance, with no context
 * code in the Op, using a policy from the pack.
 */
import { describe, test, expect } from "vitest";
import {
  gatePlanSummary, gatePolicyRequest, loadGatePolicyEvaluator, runOpLocally, stepOutput,
  type ActivityFn, type GateApproval, type GateLedgerPort, type GatePolicyDecision, type OpConfig,
} from "@intentius/chant/op";
import type { ChangeSetEntry, ChangeSetPart } from "@intentius/chant/change-set";
import type { GateResolutionRecord, PendingGateRecord } from "@intentius/chant/lifecycle/gate-ledger";
import { Policy } from "./generated/index";
import { evaluateGatePolicy, gatePolicy } from "./gate-policy";
import {
  allowRegions, capDeletes, capReplacements, permitLowRiskAgents, permitTagOnlyAgents, protectStateful,
  requireCreateTags, starterGatePolicies,
} from "./gate-policy-pack";
import { GATE_CEDAR_SCHEMA, GATE_PLAN_SUMMARY_CEDAR_TYPES, gateCedarSchema, validateGatePolicy } from "./gate-schema";

const DIGEST = `sha256:${"b".repeat(64)}`;

function entry(address: string, action: ChangeSetEntry["action"], extra: Partial<ChangeSetEntry> = {}): ChangeSetEntry {
  return { member: "estate", lexicon: "terraform", planner: "terraform", address, type: address.split(".")[0], action, attributes: [], ...extra };
}

function part(entries: ChangeSetEntry[]): ChangeSetPart {
  return {
    member: { member: "estate", lexicon: "terraform", planner: "terraform", status: "planned", planDigest: DIGEST, holes: [] },
    entries,
  };
}

const DELETES_RDS = part([
  entry("aws_db_instance.orders", "delete", { disruption: "destroy", region: "us-east-1" }),
  entry("aws_security_group.db", "update", { disruption: "in-place", region: "us-east-1", attributes: [{ path: "description", after: "x" }] }),
]);
const ADDS_A_BUCKET = part([
  entry("aws_s3_bucket.assets", "create", { region: "us-east-1", attributes: [{ path: "tags", after: { owner: "web", env: "prod" } }] }),
]);

function ask(kind: "human" | "agent", plan: ChangeSetPart | undefined, extra: Record<string, unknown> = {}) {
  return gatePolicyRequest({
    op: "estate-apply", gate: "approve", resolvedBy: kind === "agent" ? "deploy-bot" : "alex",
    approver: { kind, roles: [] }, planDigest: DIGEST,
    context: { ...extra, ...(plan ? { plan: gatePlanSummary({ members: [plan.member], entries: plan.entries }) } : {}) },
  });
}

/** A ledger in memory that a test appends approvals to between runs. */
function memoryLedger() {
  const resolutions: GateResolutionRecord[] = [];
  const pending: PendingGateRecord[] = [];
  const port: GateLedgerPort = {
    async read() { return { resolutions: [...resolutions], pending: [...pending] }; },
    async appendPending(input) {
      const record: PendingGateRecord = { version: 1, kind: "pending", ...input };
      pending.push(record);
      return { record, pushed: true };
    },
  };
  return { port, resolutions, pending };
}

/** An Op a team writes once: plan, a gate on the plan with the pack, apply. Nothing in it computes context. */
function estateApply(approval: GateApproval): OpConfig {
  return {
    name: "estate-apply",
    overview: "",
    phases: [
      { name: "Plan", steps: [{ kind: "activity", fn: "planEstate", id: "plan", args: {} }] },
      { name: "Gate", steps: [{ kind: "gate", gate: "approve", plan: stepOutput("plan", "planDigest"), approval }] },
      { name: "Apply", steps: [{ kind: "activity", fn: "applyEstate", args: {} }] },
    ],
  };
}

/**
 * What `chant approve --actor deploy-bot --agent` does for a gate with a
 * policy: evaluate it against the context the gated run recorded, through the
 * same loader, and record the decision next to the approval.
 */
async function agentApproves(ledger: ReturnType<typeof memoryLedger>, at: string): Promise<GatePolicyDecision> {
  const standing = ledger.pending[ledger.pending.length - 1];
  const approval = standing.approval!;
  const evaluator = await loadGatePolicyEvaluator(approval.policy!.lexicon);
  const answer = await evaluator.evaluateGatePolicy(approval.policy!, gatePolicyRequest({
    op: standing.op, gate: standing.gate, resolvedBy: "deploy-bot", approver: { kind: "agent" },
    ...(standing.planDigest ? { planDigest: standing.planDigest } : {}),
    ...(approval.context ? { context: approval.context } : {}),
  }));
  const policyDecision: GatePolicyDecision = { policy: approval.policy!.name, version: approval.policy!.version, mode: approval.mode, ...answer };
  ledger.resolutions.push({
    version: 1, op: standing.op, gate: standing.gate, resolvedBy: "deploy-bot", timestamp: at,
    approver: { kind: "agent" }, policyDecision, ...(standing.planDigest ? { planDigest: standing.planDigest } : {}),
  });
  return policyDecision;
}

describe("#3182 Done when: a gate denies an agent's approval of a plan that deletes an RDS instance", () => {
  const policy = gatePolicy("prod", starterGatePolicies());

  function activitiesFor(plan: ChangeSetPart, applied: string[]) {
    return new Map<string, ActivityFn>([
      // terraformPlan's result shape: the digest the gate binds, and the root's change-set part.
      ["planEstate", async () => ({ planDigest: plan.member.planDigest, changeSet: plan })],
      ["applyEstate", async () => { applied.push("apply"); return {}; }],
    ]);
  }

  test("enforce: the agent's approval is denied by protect-stateful and the run stays gated", async () => {
    const ledger = memoryLedger();
    const applied: string[] = [];
    const op = estateApply({ policy, mode: "enforce" });

    const first = await runOpLocally(op, activitiesFor(DELETES_RDS, applied), {}, undefined, { gates: ledger.port, now: "2026-10-06T12:00:00.000Z" });
    expect(first.status).toBe("gated");
    const recorded = ledger.pending[0].approval?.context?.plan as { deletedTypes: string[] };
    expect(recorded.deletedTypes).toEqual(["aws_db_instance"]);

    const decision = await agentApproves(ledger, "2026-10-06T12:01:00.000Z");
    expect(decision.decision).toBe("deny");
    expect(decision.determining).toEqual(["cap-deletes", "protect-stateful"]);

    const second = await runOpLocally(op, activitiesFor(DELETES_RDS, applied), {}, undefined, { gates: ledger.port, now: "2026-10-06T12:02:00.000Z" });
    expect(second.status).toBe("gated");
    expect(applied).toEqual([]);
  });

  test("enforce: the same Op and pack let the agent through a plan that only adds a bucket", async () => {
    const ledger = memoryLedger();
    const applied: string[] = [];
    const op = estateApply({ policy, mode: "enforce" });

    await runOpLocally(op, activitiesFor(ADDS_A_BUCKET, applied), {}, undefined, { gates: ledger.port, now: "2026-10-06T12:00:00.000Z" });
    const decision = await agentApproves(ledger, "2026-10-06T12:01:00.000Z");
    expect(decision).toMatchObject({ decision: "allow", determining: ["permit-low-risk-agents"] });

    const second = await runOpLocally(op, activitiesFor(ADDS_A_BUCKET, applied), {}, undefined, { gates: ledger.port, now: "2026-10-06T12:02:00.000Z" });
    expect(second.status).toBe("ok");
    expect(second.records.find((r) => r.fn === "gate:approve")?.approval).toMatchObject({ resolvedBy: "deploy-bot", via: "policy" });
    expect(applied).toEqual(["apply"]);
  });

  test("log-only: the deny is recorded and nothing binds, so the agent alone does not pass and the team sees why", async () => {
    const ledger = memoryLedger();
    const applied: string[] = [];
    const op = estateApply({ policy, mode: "log-only" });
    await runOpLocally(op, activitiesFor(ADDS_A_BUCKET, applied), {}, undefined, { gates: ledger.port, now: "2026-10-06T12:00:00.000Z" });
    const decision = await agentApproves(ledger, "2026-10-06T12:01:00.000Z");
    expect(decision).toMatchObject({ decision: "allow", mode: "log-only" });
    const second = await runOpLocally(op, activitiesFor(ADDS_A_BUCKET, applied), {}, undefined, { gates: ledger.port, now: "2026-10-06T12:02:00.000Z" });
    expect(second.status).toBe("gated");
  });
});

describe("the pack's rules (#3182)", () => {
  const evaluate = (policies: Parameters<typeof gatePolicy>[1], kind: "human" | "agent", plan: ChangeSetPart | undefined) =>
    evaluateGatePolicy(gatePolicy("pack", policies), ask(kind, plan));
  const permitAll = permitLowRiskAgents({ maxChanges: 1000 });

  test("protectStateful forbids deleting or replacing a stateful type, and lets other changes by", () => {
    expect(evaluate([protectStateful(), permitAll], "agent", DELETES_RDS)).toMatchObject({ decision: "deny", determining: ["protect-stateful"] });
    const replacesDynamo = part([entry("aws_dynamodb_table.t", "replace", { disruption: "destroy" })]);
    expect(evaluate([protectStateful(), permitLowRiskAgents()], "agent", replacesDynamo).decision).toBe("deny");
    expect(evaluate([protectStateful({ replacements: false }), capReplacements({ max: 5 })], "agent", replacesDynamo).determining).toEqual([]);
    expect(evaluate([protectStateful(), permitAll], "agent", ADDS_A_BUCKET).decision).toBe("allow");
  });

  test("protectStateful reads the aws lexicon's CloudFormation type names too", () => {
    const cfn = part([entry("OrdersDb", "delete", { type: "AWS::RDS::DBInstance", lexicon: "aws", planner: "chant" })]);
    expect(evaluate([protectStateful(), permitAll], "agent", cfn).determining).toEqual(["protect-stateful"]);
  });

  test("capDeletes and capReplacements forbid past their max", () => {
    const twoDeletes = part([entry("aws_route.a", "delete"), entry("aws_route.b", "delete")]);
    expect(evaluate([capDeletes({ max: 1 })], "agent", twoDeletes).determining).toEqual(["cap-deletes"]);
    expect(evaluate([capDeletes({ max: 2 })], "agent", twoDeletes).determining).toEqual([]);
    const replace = part([entry("aws_instance.web", "replace")]);
    expect(evaluate([capReplacements()], "agent", replace).determining).toEqual(["cap-replacements"]);
    expect(() => capDeletes({ max: -1 })).toThrow("at least 0");
  });

  test("allowRegions forbids a change outside the list", () => {
    const eu = part([entry("aws_instance.web", "create", { region: "eu-west-1" })]);
    const rule = allowRegions({ regions: ["us-east-1", "us-west-2"] });
    expect(evaluate([rule], "agent", eu).determining).toEqual(["allow-regions"]);
    expect(evaluate([rule], "agent", ADDS_A_BUCKET).determining).toEqual([]);
  });

  test("requireCreateTags forbids a tagged create missing a key, and strict also forbids untagged creates", () => {
    const rule = requireCreateTags({ keys: ["owner", "env"] });
    expect(evaluate([rule], "agent", ADDS_A_BUCKET).determining).toEqual([]);
    const noEnv = part([entry("aws_s3_bucket.b", "create", { attributes: [{ path: "tags", after: { owner: "web" } }] })]);
    expect(evaluate([rule], "agent", noEnv).determining).toEqual(["require-create-tags"]);
    const untagged = part([entry("aws_s3_bucket.c", "create")]);
    expect(evaluate([rule], "agent", untagged).determining).toEqual([]);
    expect(evaluate([requireCreateTags({ keys: ["owner"], strict: true })], "agent", untagged).determining).toEqual(["require-create-tags"]);
  });

  test("permitLowRiskAgents permits an agent only, and only within its limits", () => {
    expect(evaluate([permitLowRiskAgents()], "agent", ADDS_A_BUCKET).decision).toBe("allow");
    expect(evaluate([permitLowRiskAgents()], "human", ADDS_A_BUCKET).decision).toBe("deny");
    expect(evaluate([permitLowRiskAgents()], "agent", DELETES_RDS).decision).toBe("deny");
    const many = part(Array.from({ length: 4 }, (_, i) => entry(`aws_route.r${i}`, "create")));
    expect(evaluate([permitLowRiskAgents({ maxChanges: 3 })], "agent", many).decision).toBe("deny");
  });

  test("permitTagOnlyAgents permits a plan that only retags", () => {
    const retag = part([entry("aws_instance.web", "update", { attributes: [{ path: "tags", before: { a: "1" }, after: { a: "2" } }] })]);
    expect(evaluate([permitTagOnlyAgents()], "agent", retag)).toMatchObject({ decision: "allow", determining: ["permit-tag-only-agents"] });
    expect(evaluate([permitTagOnlyAgents()], "agent", ADDS_A_BUCKET).decision).toBe("deny");
  });

  test("every forbid fails closed on a request with no plan summary, and the permits do not apply", () => {
    for (const rule of [protectStateful(), capDeletes(), capReplacements(), allowRegions({ regions: ["us-east-1"] }), requireCreateTags({ keys: ["owner"] })]) {
      const answer = evaluate([rule, permitTagOnlyAgents()], "agent", undefined);
      expect(answer.decision).toBe("deny");
      expect(answer.determining).toHaveLength(1);
      expect(answer.errors).toEqual([]);
    }
    expect(evaluate([permitLowRiskAgents()], "agent", undefined)).toMatchObject({ decision: "deny", determining: [], errors: [] });
  });

  test("appliesTo agents leaves a human's decision alone", () => {
    expect(evaluate([capDeletes({ appliesTo: "agents" }), permitLowRiskAgents()], "human", DELETES_RDS).determining).toEqual([]);
    expect(evaluate([capDeletes(), permitLowRiskAgents()], "human", DELETES_RDS).determining).toEqual(["cap-deletes"]);
  });
});

describe("the gate's Cedar schema (#3182)", () => {
  test("declares every field of the plan summary core builds", () => {
    const summary = gatePlanSummary({ members: [DELETES_RDS.member], entries: DELETES_RDS.entries });
    expect(Object.keys(GATE_PLAN_SUMMARY_CEDAR_TYPES).sort()).toEqual(Object.keys(summary).sort());
    for (const key of Object.keys(summary)) expect(GATE_CEDAR_SCHEMA).toContain(`"${key}": `);
  });

  test("every rule in the pack validates against it", () => {
    const all = gatePolicy("all", {
      ...starterGatePolicies({ maxReplacements: 2, regions: ["us-east-1"], requiredTags: ["owner"] }),
      strictTags: requireCreateTags({ id: "strict-tags", keys: ["owner"], strict: true }),
      agentDeletes: capDeletes({ id: "agent-deletes", appliesTo: "agents" }),
    });
    expect(validateGatePolicy(all)).toEqual({ errors: [], warnings: [] });
  });

  test("a rule that reads a field the summary does not have fails validation", () => {
    const typo = gatePolicy("typo", { typo: new Policy({ effect: "forbid", when: ["context has plan && context.plan.deleteCount > 0"] }) });
    expect(validateGatePolicy(typo).errors.map((e) => e.policyId)).toEqual(["typo"]);
  });

  test("a gate's own context attributes are declared when given", () => {
    const risky = gatePolicy("risk", { risk: new Policy({ effect: "forbid", when: ['context has risk && context.risk == "high"'] }) });
    // Undeclared, the validator reports the rule (as an error or as an impossible policy).
    const undeclared = validateGatePolicy(risky);
    expect(undeclared.errors.length + undeclared.warnings.length).toBeGreaterThan(0);
    expect(validateGatePolicy(risky, { context: { risk: "String" } })).toEqual({ errors: [], warnings: [] });
    expect(() => gateCedarSchema({ context: { plan: "String" } })).toThrow("chant's own");
  });
});
