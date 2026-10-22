import { describe, expect, test } from "vitest";
import {
  quorumProblems,
  quorumRuleLine,
  quorumRuleProgress,
  quorumRulesFor,
  rolesOf,
  targetGlobMatch,
  trustQuorumJudge,
  type GateQuorumJudge,
  type GateQuorumRule,
} from "./gate-quorum";
import { evaluateGate, memoryGateLedgerPort, tallyGateApprovals } from "./gate";
import { gateApprovalProblems } from "./gate-approval";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";

const digest = `sha256:${"a".repeat(64)}`;
const approval = (who: string, at: string, extra: Partial<GateResolutionRecord> = {}): GateResolutionRecord => ({
  version: 1,
  op: "ship",
  gate: "prod",
  resolvedBy: who,
  timestamp: at,
  planDigest: digest,
  ...extra,
});

/** A judge that proves the names in `proven`, gives roles from `roles`, and knows `authors`. */
const judgeOf = (proven: string[], roles: Record<string, string[]>, authors?: string[]): GateQuorumJudge => (r) => {
  const ok = proven.includes(r.resolvedBy);
  return { proven: ok, roles: ok ? rolesOf(r.resolvedBy, roles) : [], ...(authors ? { author: authors.includes(r.resolvedBy) } : {}) };
};

describe("approval rules (#4290)", () => {
  test("targets globs read * within a segment and ** across segments", () => {
    expect(targetGlobMatch("prod-*", "prod-eu")).toBe(true);
    expect(targetGlobMatch("prod-*", "staging")).toBe(false);
    expect(targetGlobMatch("envs/prod/**", "envs/prod/eu/db")).toBe(true);
    expect(targetGlobMatch("envs/*/db", "envs/prod/eu/db")).toBe(false);
    expect(targetGlobMatch("envs/**/db", "envs/db")).toBe(true);
  });

  test("a gate takes the rules with no targets, and those a glob of matches one of its targets", () => {
    const rules: GateQuorumRule[] = [{ count: 1 }, { targets: ["prod-*"], count: 2 }, { targets: ["dev"], count: 3 }];
    expect(quorumRulesFor(rules, ["prod-eu", "staging"])).toEqual([{ count: 1 }, { targets: ["prod-*"], count: 2 }]);
    expect(quorumRulesFor(rules, [])).toEqual([{ count: 1 }]);
  });

  test("a role counts only for a proven approver that trust.json grants it", () => {
    const rule: GateQuorumRule = { count: 2, roles: ["platform"] };
    const judge = judgeOf(["github:alice", "github:bob"], { platform: ["github:alice", "github:carol"] });
    const approvers = ["github:alice", "github:bob", "github:carol"].map((who, i) => ({ who, at: `2026-10-22T0${i}:00:00Z`, judged: judge(approval(who, "")) }));
    const p = quorumRuleProgress(rule, approvers);
    // bob is proven but holds no role; carol holds the role but is not proven.
    expect(p.approvers).toEqual(["github:alice"]);
    expect(p.met).toBe(false);
    expect(quorumRuleLine(p)).toBe("every target: 1 of 2 approvals (github:alice), needs 1 more from platform");
  });

  test("notAuthor needs a proven approver who is not the author, and waits when the author is unknown", () => {
    const rule: GateQuorumRule = { count: 1, notAuthor: true };
    const at = "2026-10-22T00:00:00Z";
    const byAuthor = judgeOf(["github:alice"], {}, ["github:alice"]);
    expect(quorumRuleProgress(rule, [{ who: "github:alice", at, judged: byAuthor(approval("github:alice", at)) }]).met).toBe(false);
    const byOther = judgeOf(["github:bob"], {}, ["github:alice"]);
    expect(quorumRuleProgress(rule, [{ who: "github:bob", at, judged: byOther(approval("github:bob", at)) }]).met).toBe(true);
    const unknown = judgeOf(["github:bob"], {});
    const p = quorumRuleProgress(rule, [{ who: "github:bob", at, judged: unknown(approval("github:bob", at)) }]);
    expect(p).toMatchObject({ met: false, authorUnknown: true });
    expect(quorumRuleLine(p)).toMatch(/author is not known/);
  });

  test("the trust judge proves a reviewer of the live review, never a claimed role", () => {
    const judge = trustQuorumJudge({
      signers: { base: null, signersPath: ".chant/allowed_signers", active: false, signers: [], problems: [] },
      roles: { platform: ["github:alice"] },
      authors: ["github:dana"],
      review: { head: "h1", approvers: ["github:alice"] },
    });
    expect(judge(approval("github:alice", "", { review: { pr: 1, head: "h1", approvers: ["github:alice"] } }))).toEqual({ proven: true, roles: ["platform"], author: false });
    // A review line for another head proves nothing, and a claimed role is ignored.
    expect(judge(approval("github:alice", "", { review: { pr: 1, head: "h0", approvers: ["github:alice"] }, approver: { kind: "human", roles: ["platform"] } }))).toEqual({ proven: false, roles: [], author: false });
  });

  test("the tally passes once every rule is met, each approver once", () => {
    const rules: GateQuorumRule[] = [{ count: 2 }, { count: 1, roles: ["platform"] }];
    const judge = judgeOf(["github:alice"], { platform: ["github:alice"] });
    const records = [approval("github:bob", "2026-10-22T01:00:00Z"), approval("github:bob", "2026-10-22T02:00:00Z")];
    const one = tallyGateApprovals(records, "prod", "2026-10-22T00:00:00Z", digest, { mode: "log-only", quorum: rules }, undefined, judge);
    expect(one).toMatchObject({ met: false, need: 2 });
    expect(one.counted.map((r) => r.resolvedBy)).toEqual(["github:bob"]);
    const both = tallyGateApprovals([...records, approval("github:alice", "2026-10-22T03:00:00Z")], "prod", "2026-10-22T00:00:00Z", digest, { mode: "log-only", quorum: rules }, undefined, judge);
    expect(both.met).toBe(true);
    expect(both.rules?.map((r) => r.met)).toEqual([true, true]);
  });

  test("an agent never counts toward a rule", () => {
    const records = [approval("bot", "2026-10-22T01:00:00Z", { approver: { kind: "agent" } })];
    expect(tallyGateApprovals(records, "prod", "2026-10-22T00:00:00Z", digest, { mode: "log-only", quorum: [{ count: 1 }] }).met).toBe(false);
  });

  test("evaluateGate asks the port's judge for rules naming roles, and with none no role counts", async () => {
    const quorum: GateQuorumRule[] = [{ count: 1, roles: ["platform"] }];
    const seeded = { resolutions: [approval("github:alice", "2026-10-22T01:00:00Z", { approver: { kind: "human", roles: ["platform"] } })] };
    const input = { op: "ship", gate: "prod", planDigest: digest, approval: { mode: "log-only" as const, quorum }, now: "2026-10-22T02:00:00Z" };
    const bare = await evaluateGate(memoryGateLedgerPort(seeded), input);
    expect(bare.satisfied).toBe(false);
    if (!bare.satisfied) expect(bare.quorum?.rules?.[0]).toMatchObject({ met: false, approvers: [] });
    const port = { ...memoryGateLedgerPort(seeded), quorumJudge: async () => judgeOf(["github:alice"], { platform: ["github:alice"] }) };
    expect((await evaluateGate(port, input)).satisfied).toBe(true);
  });

  test("an Op gate's block takes a list of rules, and refuses notAuthor", () => {
    expect(gateApprovalProblems({ quorum: [{ targets: ["prod"], count: 2, roles: ["platform"] }, { count: 1 }] })).toEqual([]);
    expect(gateApprovalProblems({ quorum: [{ count: 1, notAuthor: true }] })).toEqual([expect.stringMatching(/notAuthor` is not read here/)]);
    expect(gateApprovalProblems({ quorum: [] })).toEqual(["`approval.quorum` must name at least one rule"]);
    expect(quorumProblems([{ count: 0, targets: [], who: 1 }], "approvals.quorum", { notAuthor: true })).toEqual([
      "`approvals.quorum[0].count` must be an integer of at least 1",
      "`approvals.quorum[0].targets` must be a non-empty list of globs",
      "`approvals.quorum[0].who` is not a quorum field; use targets, count, roles or notAuthor",
    ]);
  });
});
