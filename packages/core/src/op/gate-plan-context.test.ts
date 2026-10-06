/**
 * The plan summary a gate's policy reads (#3182): what it counts, where the
 * run finds the change set, and that it lands on the pending fact as
 * `context.plan` with no context code in the Op.
 */
import { describe, test, expect } from "vitest";
import type { ChangeSetEntry, ChangeSetMember, ChangeSetPart } from "../change-set";
import { composeChangeSet } from "../change-set";
import {
  changeSetOfResult, gatePlanSummary, gatePlanSummaryOfResult, GATE_PLAN_ADDRESS_LIMIT, GATE_PLAN_CONTEXT_KEY,
} from "./gate-plan-context";
import { gateApprovalProblems, gatePolicyVersion, type GateApproval, type GatePolicyRef } from "./gate-approval";
import { runOpLocally } from "./local-executor";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import type { GateLedgerPort } from "./gate";
import type { PendingGateRecord } from "../lifecycle/gate-ledger";
import type { OpConfig } from "./types";
import { stepOutput } from "./step-output-ref";

const PROFILES: Record<string, ActivityProfile> = { single: { timeout: "5m", retry: { maximumAttempts: 1 } } };
const TEXT = 'permit (principal, action, resource);\n';
const POLICY: GatePolicyRef = { kind: "gate-policy", lexicon: "cedar", name: "prod", version: gatePolicyVersion(TEXT), text: TEXT };

function member(name: string, extra: Partial<ChangeSetMember> = {}): ChangeSetMember {
  return { member: name, lexicon: "terraform", planner: "terraform", status: "planned", planDigest: `sha256:${"a".repeat(64)}`, holes: [], ...extra };
}

function entry(address: string, action: ChangeSetEntry["action"], extra: Partial<ChangeSetEntry> = {}): ChangeSetEntry {
  return {
    member: "estate", lexicon: "terraform", planner: "terraform", address,
    type: address.split(".")[0], action, attributes: [], ...extra,
  };
}

const RDS_DELETE: ChangeSetPart = {
  member: member("estate"),
  entries: [
    entry("aws_db_instance.main", "delete", { disruption: "destroy", region: "us-east-1" }),
    entry("aws_s3_bucket.logs", "create", {
      region: "us-east-1",
      attributes: [{ path: "tags", after: { owner: "data", env: "prod" } }, { path: "bucket", after: "logs" }],
    }),
    entry("aws_iam_role_policy_attachment.ro", "create", { attributes: [{ path: "role", after: "ro" }] }),
    entry("aws_instance.web", "replace", { disruption: "destroy", region: "eu-west-1" }),
    entry("aws_vpc.main", "no-op"),
    entry("data.aws_caller_identity.me", "read"),
  ],
};

describe("gatePlanSummary (#3182)", () => {
  test("counts each action and names deleted and replaced types and addresses", () => {
    const s = gatePlanSummary({ members: [RDS_DELETE.member], entries: RDS_DELETE.entries });
    expect(s).toMatchObject({
      members: ["estate"], membersChanged: ["estate"], failedMembers: [], failed: 0, holes: 0,
      entries: 6, changes: 4, creates: 2, updates: 0, replaces: 1, deletes: 1, reads: 1, noOps: 1, forgets: 0,
      deletedTypes: ["aws_db_instance"], deleted: ["aws_db_instance.main"],
      replacedTypes: ["aws_instance"], replaced: ["aws_instance.web"],
      createdTypes: ["aws_iam_role_policy_attachment", "aws_s3_bucket"],
      lexicons: ["terraform"], tagOnly: false, truncated: false,
    });
  });

  test("regions and types are of changes only, not of no-ops or reads", () => {
    const s = gatePlanSummary({ members: [RDS_DELETE.member], entries: RDS_DELETE.entries });
    expect(s.regions).toEqual(["eu-west-1", "us-east-1"]);
    expect(s.types).not.toContain("aws_vpc");
    expect(s.types).not.toContain("data");
  });

  test("createTagKeys is what every tagged create carries, and untagged creates are counted apart", () => {
    const s = gatePlanSummary({
      members: [member("estate")],
      entries: [
        entry("aws_s3_bucket.a", "create", { attributes: [{ path: "tags", after: { owner: "x", env: "prod" } }] }),
        entry("aws_s3_bucket.b", "create", { attributes: [{ path: "tags_all", after: { owner: "y" } }] }),
        entry("aws_route.r", "create"),
      ],
    });
    expect(s.taggedCreates).toBe(2);
    expect(s.untaggedCreates).toBe(1);
    expect(s.createTagKeys).toEqual(["owner"]);
  });

  test("tagOnly holds only when every change is an update of tags or labels", () => {
    const tagsOnly = [
      entry("aws_s3_bucket.a", "update", { attributes: [{ path: "tags", before: {}, after: { owner: "x" } }] }),
      entry("google_storage_bucket.b", "update", { attributes: [{ path: "labels", after: { team: "y" } }] }),
      entry("aws_vpc.main", "no-op"),
    ];
    expect(gatePlanSummary({ members: [member("estate")], entries: tagsOnly }).tagOnly).toBe(true);
    const withSize = [...tagsOnly, entry("aws_instance.web", "update", { attributes: [{ path: "instance_type", after: "m5.large" }] })];
    expect(gatePlanSummary({ members: [member("estate")], entries: withSize }).tagOnly).toBe(false);
    expect(gatePlanSummary({ members: [member("estate")], entries: [entry("aws_vpc.main", "no-op")] }).tagOnly).toBe(false);
  });

  test("failed members and holes are counted", () => {
    const s = gatePlanSummary({
      members: [member("estate"), member("net", { status: "failed", planDigest: null, holes: [{ address: "x", reason: "unread" }] })],
      entries: [],
    });
    expect(s.failedMembers).toEqual(["net"]);
    expect(s.failed).toBe(1);
    expect(s.holes).toBe(1);
  });

  test("address sets are cut at the limit, the counts are not", () => {
    const entries = Array.from({ length: GATE_PLAN_ADDRESS_LIMIT + 3 }, (_, i) => entry(`aws_sqs_queue.q${i}`, "delete"));
    const s = gatePlanSummary({ members: [member("estate")], entries });
    expect(s.deletes).toBe(GATE_PLAN_ADDRESS_LIMIT + 3);
    expect(s.deleted).toHaveLength(GATE_PLAN_ADDRESS_LIMIT);
    expect(s.truncated).toBe(true);
  });
});

describe("changeSetOfResult (#3182)", () => {
  test("finds terraformPlan's changeSet, a part, composeChangeSet's document, and a bare document", () => {
    const doc = composeChangeSet([RDS_DELETE]);
    expect(changeSetOfResult({ planDigest: "x", changeSet: RDS_DELETE })?.entries).toHaveLength(6);
    expect(changeSetOfResult({ part: RDS_DELETE })?.members).toEqual([RDS_DELETE.member]);
    expect(changeSetOfResult({ document: doc, digest: doc.digest })?.entries).toHaveLength(6);
    expect(changeSetOfResult(doc)?.members).toHaveLength(1);
  });

  test("a result with no change set has no summary", () => {
    expect(gatePlanSummaryOfResult({ planDigest: "x" })).toBeUndefined();
    expect(gatePlanSummaryOfResult("sha256:abc")).toBeUndefined();
    expect(gatePlanSummaryOfResult(undefined)).toBeUndefined();
  });
});

describe("approval.context.plan is reserved (#3182)", () => {
  test("an authored context may not set plan", () => {
    expect(gateApprovalProblems({ policy: POLICY, context: { plan: "mine" } }).join("\n")).toContain("reserved");
    expect(gateApprovalProblems({ policy: POLICY, context: { risk: "low" } })).toEqual([]);
  });
});

function ledger(): { port: GateLedgerPort; pending: PendingGateRecord[] } {
  const pending: PendingGateRecord[] = [];
  return {
    pending,
    port: {
      async read() { return { resolutions: [], pending: [...pending] }; },
      async appendPending(input) {
        const record: PendingGateRecord = { version: 1, kind: "pending", ...input };
        pending.push(record);
        return { record, pushed: true };
      },
    },
  };
}

function planOp(approval: GateApproval): OpConfig {
  return {
    name: "estate-apply",
    overview: "",
    phases: [
      { name: "Plan", steps: [{ kind: "activity", fn: "plan", id: "plan", args: {} }] },
      { name: "Gate", steps: [{ kind: "gate", gate: "approve", plan: stepOutput("plan", "planDigest"), approval }] },
      { name: "Apply", steps: [{ kind: "activity", fn: "apply", args: {} }] },
    ],
  };
}

describe("runOpLocally puts the plan summary in the gate's context (#3182)", () => {
  const activities = new Map<string, ActivityFn>([
    ["plan", async () => ({ planDigest: RDS_DELETE.member.planDigest, changeSet: RDS_DELETE })],
    ["apply", async () => ({})],
  ]);

  test("a gate with a policy whose plan names the planning step gets context.plan, beside its own context", async () => {
    const { port, pending } = ledger();
    const result = await runOpLocally(planOp({ policy: POLICY, mode: "enforce", context: { risk: "high" } }), activities, PROFILES, undefined, { gates: port, now: "2026-10-06T12:00:00.000Z" });
    expect(result.status).toBe("gated");
    expect(pending).toHaveLength(1);
    const context = pending[0].approval?.context as Record<string, unknown>;
    expect(context.risk).toBe("high");
    expect(context[GATE_PLAN_CONTEXT_KEY]).toEqual(gatePlanSummary({ members: [RDS_DELETE.member], entries: RDS_DELETE.entries }));
  });

  test("a gate with no policy gets no summary, so its pending fact is what it was", async () => {
    const { port, pending } = ledger();
    await runOpLocally(planOp({ quorum: { count: 1 } }), activities, PROFILES, undefined, { gates: port, now: "2026-10-06T12:00:00.000Z" });
    expect(pending[0].approval).toEqual({ quorum: { count: 1 }, mode: "log-only" });
  });
});
