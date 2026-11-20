/**
 * The scored change risk (#5325): the pinned weights, the same score for the
 * same change set, questions and their `unknown` answers, and the rules that
 * keep the score from ever passing a gate.
 */
import { describe, expect, test } from "vitest";
import {
  CHANGE_RISK_HALF,
  CHANGE_RISK_LEVEL_FROM,
  CHANGE_RISK_REVIEW_VALUES,
  CHANGE_RISK_WEIGHTS,
  changeRiskContext,
  changeRiskLines,
  changeRiskProblems,
  changeRiskQuorum,
  graphDependents,
  scoreChangeRisk,
  type ChangeRiskFacts,
} from "./change-risk";
import { opWaveHoldsProblems } from "./op/op-waves-capability-spec";
import { evaluateGate, memoryGateLedgerPort, tallyGateApprovals } from "./op/gate";
import { gateApprovalProblems, gateContextDigest, gatePermitReadsRisk, gatePolicyVersion, type GatePolicyRef, type ResolvedGateApproval } from "./op/gate-approval";
import { resolveGateApproval } from "./op/local-executor";
import { stepOutput } from "./op/step-output-ref";
import type { GateQuorumJudge } from "./op/gate-quorum";
import type { GateResolutionRecord, PendingGateRecord } from "./lifecycle/gate-ledger";
import type { ChangeSetEntry, ChangeSetMember } from "./change-set";

const member = (name: string): ChangeSetMember => ({ member: name, lexicon: "terraform", planner: "terraform", status: "planned", planDigest: `sha256:${"1".repeat(64)}`, holes: [] });
const entry = (m: string, address: string, action: ChangeSetEntry["action"], extra: Partial<ChangeSetEntry> = {}): ChangeSetEntry => ({
  member: m, lexicon: "terraform", planner: "terraform", address, type: "aws_instance", action, attributes: [], ...extra,
});

describe("the weights are pinned (#5325)", () => {
  test("every weight, half and level threshold, as the docs list them", () => {
    expect(CHANGE_RISK_WEIGHTS).toEqual({
      destroys: 0.7,
      replacements: 0.5,
      "disruption.destroy": 0.6,
      "disruption.rolling": 0.2,
      "disruption.unknown": 0.3,
      "sql.destructive": 0.7,
      members: 0.2,
      environments: 0.3,
      dependents: 0.3,
      review: 0.5,
    });
    expect(CHANGE_RISK_HALF).toEqual({
      destroys: 1,
      replacements: 1,
      "disruption.destroy": 1,
      "disruption.rolling": 2,
      "disruption.unknown": 2,
      "sql.destructive": 1,
      members: 2,
      environments: 1,
      dependents: 4,
    });
    expect(CHANGE_RISK_REVIEW_VALUES).toEqual({ low: 0, medium: 0.5, high: 1, unknown: 0.5 });
    expect(CHANGE_RISK_LEVEL_FROM).toEqual({ medium: 0.3, high: 0.6 });
  });

  test("the docs' example: one delete and one replacement in one member and one environment score 0.5125, medium", () => {
    const facts: ChangeRiskFacts = {
      changeSet: { members: [member("net")], entries: [entry("net", "aws_instance.a", "delete", { disruption: "destroy" }), entry("net", "aws_instance.b", "replace", { disruption: "replace" })] },
      environments: ["prod"],
    };
    const risk = scoreChangeRisk(facts);
    expect(risk.score).toBe(0.5125);
    expect(risk.level).toBe("medium");
    expect(risk.reasons.map((r) => [r.id, r.contribution])).toEqual([
      ["destroys", 0.35],
      ["replacements", 0.25],
      ["disruption.destroy", 0],
      ["disruption.rolling", 0],
      ["disruption.unknown", 0],
      ["sql.destructive", 0],
      ["members", 0],
      ["environments", 0],
      ["dependents", 0],
    ]);
  });

  test("every reason counts, and the score is pinned to four places", () => {
    const facts: ChangeRiskFacts = {
      changeSet: {
        members: [member("net"), member("app")],
        entries: [
          entry("net", "aws_instance.a", "delete", { disruption: "destroy" }),
          entry("net", "aws_db_instance.b", "replace", { disruption: "destroy" }),
          entry("app", "kubernetes_deployment.c", "update", { disruption: "rolling" }),
          entry("app", "aws_s3_bucket.d", "update", { disruption: "unknown" }),
        ],
      },
      destructive: ["drop-column"],
      migrations: [{ file: "db/1.sql", member: "db", reader: "goose-dir", version: "1", name: "x", type: "versioned", dialect: "postgres", statements: [{ index: 1, sql: "DROP TABLE t", outcome: "classified", changes: [{ rule: "drop-table", class: "rebuild", label: "REBUILD", title: "drop", destructive: true }] }] }],
      environments: ["staging", "prod"],
      dependents: ["net/aws_route.r"],
      review: { risk: "high" },
    };
    const risk = scoreChangeRisk(facts);
    const byId = Object.fromEntries(risk.reasons.map((r) => [r.id, r]));
    expect(byId["sql.destructive"]).toMatchObject({ count: 2, value: 0.75, contribution: 0.525 });
    expect(byId.members).toMatchObject({ count: 2, value: 0.2929 });
    expect(byId.environments).toMatchObject({ count: 2, value: 0.5, contribution: 0.15 });
    expect(byId.dependents).toMatchObject({ count: 1, value: 0.1591 });
    expect(byId.review).toMatchObject({ value: 1, contribution: 0.5 });
    expect(risk.score).toBe(0.947);
    expect(risk.level).toBe("high");
  });

  test("the same change set always gives the same score, whatever order its entries come in", () => {
    const entries = [entry("a", "x", "delete"), entry("b", "y", "replace", { disruption: "unknown" }), entry("a", "z", "update", { disruption: "rolling" })];
    const one = scoreChangeRisk({ changeSet: { members: [member("a"), member("b")], entries }, environments: ["prod"] });
    const two = scoreChangeRisk({ changeSet: { members: [member("b"), member("a")], entries: [...entries].reverse() }, environments: ["prod"] });
    expect(two).toEqual(one);
  });

  test("a reason only ever raises the score", () => {
    const base = scoreChangeRisk({ changeSet: { members: [member("a")], entries: [entry("a", "x", "update", { disruption: "in-place" })] } });
    const more = scoreChangeRisk({ changeSet: { members: [member("a")], entries: [entry("a", "x", "update", { disruption: "in-place" })] }, review: { risk: "low" }, dependents: ["n"] });
    expect(base.score).toBe(0);
    expect(more.score).toBeGreaterThanOrEqual(base.score);
  });
});

describe("questions (#5325)", () => {
  const questions = [
    { id: "customer-data", text: "Does this touch customer data?", weight: 0.8, approveAbove: 0.5 },
    { id: "network", text: "Does it change network reach?", weight: 0.5 },
  ];
  const quiet = { members: [member("a")], entries: [entry("a", "x", "update", { disruption: "in-place" })] };

  test("each answer is a reason with its weight, and one over its own threshold makes the change over", () => {
    const risk = scoreChangeRisk({ changeSet: quiet, review: { risk: "low", answers: { "customer-data": 0.7, network: 0.1 } } }, { questions });
    const q = risk.reasons.filter((r) => r.id.startsWith("question."));
    expect(q).toEqual([
      expect.objectContaining({ id: "question.customer-data", weight: 0.8, value: 0.7, contribution: 0.56, answer: 0.7, approveAbove: 0.5 }),
      expect.objectContaining({ id: "question.network", weight: 0.5, value: 0.1, contribution: 0.05, answer: 0.1 }),
    ]);
    expect(risk.over).toBe(true);
    expect(risk.overBy).toEqual(["question customer-data was answered 0.7, above its threshold of 0.5"]);
  });

  test("an unknown answer, from a plan too large for the review, is above every threshold while the deterministic reasons still score", () => {
    const changeSet = { members: [member("a")], entries: [entry("a", "x", "delete")] };
    const risk = scoreChangeRisk(
      { changeSet, review: { risk: "medium", answers: { "customer-data": "unknown", network: "unknown" }, unknownBecause: "the plan is larger than the review's prompt carries" } },
      { questions: [{ ...questions[0]!, approveAbove: 1 }, { ...questions[1]!, approveAbove: 1 }] },
    );
    expect(risk.reasons.find((r) => r.id === "destroys")).toMatchObject({ count: 1, contribution: 0.35 });
    expect(risk.reasons.filter((r) => r.id.startsWith("question.")).map((r) => [r.answer, r.value])).toEqual([["unknown", 1], ["unknown", 1]]);
    expect(risk.overBy).toEqual([
      "question customer-data has no answer, which counts above its threshold of 1",
      "question network has no answer, which counts above its threshold of 1",
    ]);
  });

  test("an answer to a question nobody asked counts for nothing", () => {
    const risk = scoreChangeRisk({ changeSet: quiet, review: { risk: "low", answers: { invented: 0 } } }, { questions: [questions[1]!] });
    expect(risk.reasons.map((r) => r.id)).not.toContain("question.invented");
    expect(risk.reasons.find((r) => r.id === "question.network")).toMatchObject({ answer: "unknown" });
  });
});

describe("the score only adds approvals (#5325)", () => {
  test("allow_unattended and every key that would pass a gate on a low score is refused, in ci.risk, holds.risk and approval.risk", () => {
    for (const key of ["allow_unattended", "allowUnattended", "approveBelow"]) {
      expect(changeRiskProblems("ci.risk", { [key]: 0.1 }, { quorum: false, questions: true }).join()).toMatch(/refused/);
      expect(opWaveHoldsProblems({ risk: { [key]: 0.1 } }).join()).toMatch(/refused/);
      expect(gateApprovalProblems({ risk: { [key]: 0.1 } }).join()).toMatch(/refused/);
    }
    expect(changeRiskProblems("ci.risk", { approveAbove: 0.5, questions: [{ id: "a", text: "q", weight: 0.5 }] }, { quorum: false, questions: true })).toEqual([]);
    expect(changeRiskProblems("ci.risk", { approveAbove: 2 }, { quorum: false, questions: true }).join()).toMatch(/from 0 to 1/);
    expect(opWaveHoldsProblems({ risk: { approveAbove: 0.4, quorum: [{ count: 2 }] } })).toEqual([]);
    expect(opWaveHoldsProblems({ risk: { questions: [] } }).join()).toMatch(/ci\.risk\.questions/);
  });

  test("an over score adds the settings' rules; a score under the threshold adds none and asks for nothing more", () => {
    const quorum = [{ count: 2 }, { count: 1, roles: ["sre"] }];
    const low = scoreChangeRisk({ changeSet: { members: [], entries: [] } }, { approveAbove: 0.4, quorum });
    const high = scoreChangeRisk({ changeSet: { members: [member("a")], entries: [entry("a", "x", "delete"), entry("a", "y", "delete")] } }, { approveAbove: 0.4, quorum });
    expect(low).toMatchObject({ score: 0, over: false });
    expect(changeRiskQuorum(low, { quorum })).toEqual([]);
    expect(high.over).toBe(true);
    expect(changeRiskQuorum(high, { quorum })).toEqual(quorum);
    expect(changeRiskLines(low).join("\n")).toMatch(/approves nothing/);
    expect(changeRiskLines(high).join("\n")).toMatch(/needs an approval of its own digest/);
  });
});

describe("graph dependents (#5325)", () => {
  test("a node that reads a changed node counts once; a changed reader does not", () => {
    const doc = { entries: [entry("a", "x", "update", { node: "db" }), entry("a", "y", "update", { node: "app" })] };
    expect(graphDependents(doc, [{ from: "app", to: "db" }, { from: "dns", to: "db" }, { from: "dns", to: "app" }, { from: "cdn", to: "dns" }])).toEqual(["dns"]);
  });
});

const PLAN = `sha256:${"a".repeat(64)}`;
const PENDING: PendingGateRecord = { version: 1, kind: "pending", op: "release", gate: "ship", timestamp: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-03T00:00:00.000Z", planDigest: PLAN };
const NOW = "2026-09-01T12:00:00.000Z";
const RISK_TEXT = "permit (principal, action, resource) when { context.changeRisk.percent < 30 };\n";
const RISK_POLICY: GatePolicyRef = { kind: "gate-policy", lexicon: "cedar", name: "ship", version: gatePolicyVersion(RISK_TEXT), text: RISK_TEXT };
const lowContext = { changeRisk: changeRiskContext(scoreChangeRisk({ changeSet: { members: [], entries: [] } })) };
const permitOf = (who: string, kind: "human" | "agent", seal = false): GateResolutionRecord => ({
  version: 1, op: "release", gate: "ship", planDigest: PLAN, resolvedBy: who, timestamp: "2026-09-01T01:00:00.000Z", approver: { kind },
  ...(seal ? { seal: { key: "k", signature: "s" } as never } : {}),
  policyDecision: { policy: "ship", version: RISK_POLICY.version, mode: "enforce", contextDigest: gateContextDigest(lowContext), decision: "allow", determining: ["ship-0"], errors: [] },
});
/** The trust at base proves the sealed approvals: alice is in trust.json, release-bot and mallory are not proven. */
const trustJudge: GateQuorumJudge = (r) => ({ proven: r.resolvedBy === "alice" && r.seal !== undefined, roles: [] });

describe("a Cedar permit that reads the score still needs a person from trust.json (#5325)", () => {
  const block: ResolvedGateApproval = { policy: RISK_POLICY, mode: "enforce", context: lowContext, risk: {} };

  test("the gate reads the score when it sets approval.risk, carries changeRisk, or its policy names it", () => {
    expect(gatePermitReadsRisk(block)).toBe(true);
    expect(gatePermitReadsRisk({ policy: RISK_POLICY })).toBe(true);
    expect(gatePermitReadsRisk({ context: lowContext })).toBe(true);
    expect(gatePermitReadsRisk({ context: { risk: "low" } })).toBe(false);
  });

  test("the agent principal's permit on a low score is refused", async () => {
    const tally = tallyGateApprovals([permitOf("release-bot", "agent", true)], "ship", PENDING.timestamp, PLAN, block, undefined, trustJudge);
    expect(tally.permit).toBeUndefined();
    const port = memoryGateLedgerPort({ resolutions: [permitOf("release-bot", "agent", true)], pending: [{ ...PENDING, approval: block }] });
    const check = await evaluateGate(port, { op: "release", gate: "ship", planDigest: PLAN, approval: block, now: NOW, judge: trustJudge });
    expect(check.satisfied).toBe(false);
  });

  test("a human the trust does not prove passes no permit; a proven human from trust.json does", () => {
    expect(tallyGateApprovals([permitOf("mallory", "human")], "ship", PENDING.timestamp, PLAN, block, undefined, trustJudge).permit).toBeUndefined();
    expect(tallyGateApprovals([permitOf("alice", "human", true)], "ship", PENDING.timestamp, PLAN, block, undefined, trustJudge).permit?.resolvedBy).toBe("alice");
  });

  test("with no score in the gate, an agent's enforce permit behaves as it did before", () => {
    const TEXT = 'permit (principal is Chant::Agent, action, resource) when { context.risk == "low" };\n';
    const policy: GatePolicyRef = { kind: "gate-policy", lexicon: "cedar", name: "ship", version: gatePolicyVersion(TEXT), text: TEXT };
    const old: ResolvedGateApproval = { policy, mode: "enforce", context: { risk: "low" } };
    const agent: GateResolutionRecord = { ...permitOf("release-bot", "agent"), policyDecision: { policy: "ship", version: policy.version, mode: "enforce", contextDigest: gateContextDigest({ risk: "low" }), decision: "allow", determining: ["ship-0"], errors: [] } };
    expect(tallyGateApprovals([agent], "ship", PENDING.timestamp, PLAN, old).permit?.resolvedBy).toBe("release-bot");
  });

  test("a low score on its own passes no gate: with no approval recorded, the gate waits", async () => {
    const port = memoryGateLedgerPort({ resolutions: [], pending: [{ ...PENDING, approval: block }] });
    const check = await evaluateGate(port, { op: "release", gate: "ship", planDigest: PLAN, approval: block, now: NOW, judge: trustJudge });
    expect(lowContext.changeRisk.percent).toBe(0);
    expect(check.satisfied).toBe(false);
  });

  test("approval.context.changeRisk is reserved", () => {
    expect(gateApprovalProblems({ policy: RISK_POLICY, context: { changeRisk: "low" } }).join()).toMatch(/reserved/);
  });
});

describe("an Op gate's approval.risk (#5325)", () => {
  const plan = { kind: "gate" as const, name: "ship", plan: stepOutput("plan", "planDigest") };
  const changeSet = { members: [member("a")], entries: [entry("a", "x", "delete"), entry("a", "y", "delete")] };
  const results = new Map<string, unknown>([["plan", { planDigest: PLAN, changeSet: { member: changeSet.members[0], entries: changeSet.entries } }]]);

  test("the run scores the plan's change set into context.changeRisk, and over the threshold adds the risk's rules", () => {
    const step = { ...plan, approval: { quorum: { count: 1 }, risk: { approveAbove: 0.4, quorum: [{ count: 2 }] } } };
    const resolved = resolveGateApproval(step as never, results, "prod");
    expect(resolved?.context?.changeRisk).toEqual({ percent: 53, level: "medium", over: true, reasons: ["destroys"] });
    expect(resolved?.quorum).toEqual([{ count: 1 }, { count: 2 }]);
    expect(resolved?.risk).toEqual({ approveAbove: 0.4, quorum: [{ count: 2 }] });
  });

  test("under the threshold the gate keeps its own rules", () => {
    const step = { ...plan, approval: { quorum: { count: 1 }, risk: { approveAbove: 0.9, quorum: [{ count: 2 }] } } };
    expect(resolveGateApproval(step as never, results, "prod")?.quorum).toEqual({ count: 1 });
  });
});

