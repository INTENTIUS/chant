/**
 * #3949: a gate can carry aliases, so an Op can be restructured without
 * orphaning the approvals on the ledger. loomster's case: three per-tier
 * upgrade Ops, each with an `approve` gate, merged into one Op whose gates
 * are its waves.
 */

import { describe, expect, test } from "vitest";
import { approvalsAnswering, evaluateGate, memoryGateLedgerPort, type GateApprovalRule, type GateCheckInput } from "./gate";
import { aliasingGate, gateAliasProblems, resolveGateAliases, validateGateAliases } from "./gate-alias";
import { gate } from "./builders";
import { decideGateResume } from "./gate-checkpoint";
import { runOpLocally } from "./local-executor";
import { renderHuman } from "./local-output";
import { stepOutput } from "./step-output-ref";
import { parseGateLedger, type GateResolutionRecord, type PendingGateRecord } from "../lifecycle/gate-ledger";
import { gateSealPayload, gateSealVersion } from "../lifecycle/gate-seal";
import { deriveGateAudit } from "../lifecycle/gate-audit";
import type { AppliedGateRecord } from "../lifecycle/gate-applied";
import type { ActivityFn } from "./activity-registry";
import type { OpConfig } from "./types";

const PLAN = `jcs1-sha256:${"a".repeat(64)}`;
const MOVED = `jcs1-sha256:${"b".repeat(64)}`;
const CHECKPOINT = `jcs1-sha256:${"c".repeat(64)}`;
const COMMIT = "1".repeat(40);
const at = (minute: number) => `2026-10-12T12:${String(minute).padStart(2, "0")}:00.000Z`;
const NOW = at(30);

const pending = (op: string, gateName: string, over: Partial<PendingGateRecord> = {}): PendingGateRecord => ({
  version: 1,
  kind: "pending",
  op,
  gate: gateName,
  timestamp: at(0),
  expiresAt: "2099-01-01T00:00:00.000Z",
  planDigest: PLAN,
  runId: "old-run",
  ...over,
});

const approval = (op: string, gateName: string, resolvedBy: string, over: Partial<GateResolutionRecord> = {}): GateResolutionRecord => ({
  version: 1,
  op,
  gate: gateName,
  resolvedBy,
  timestamp: at(5),
  planDigest: PLAN,
  ...over,
});

/** The in-memory port, with each Op's ledger read on its own as the git port reads `_gates/<op>.jsonl`. */
function ports(seed: { resolutions?: GateResolutionRecord[]; pending?: PendingGateRecord[]; applied?: AppliedGateRecord[] } = {}) {
  const base = memoryGateLedgerPort(seed);
  return {
    ...base,
    async read(op: string) {
      const all = await base.read(op);
      return { resolutions: all.resolutions.filter((r) => r.op === op), pending: all.pending.filter((p) => p.op === op) };
    },
  };
}

const TIER_1 = { op: "upgrade-tier-1", gate: "approve" };
const input = (over: Partial<GateCheckInput> = {}): GateCheckInput => ({
  op: "upgrade",
  gate: "approve-tier-1",
  planDigest: PLAN,
  now: NOW,
  aliases: [TIER_1],
  ...over,
});

describe("declaring aliases", () => {
  test("the builder keeps them and fills nothing in", () => {
    const step = gate("approve-tier-1", { plan: "p", aliases: [{ op: "upgrade-tier-1", gate: "approve" }, { gate: "old" }] });
    expect(step.aliases).toEqual([{ op: "upgrade-tier-1", gate: "approve" }, { gate: "old" }]);
    expect(resolveGateAliases(step, "upgrade")).toEqual([TIER_1, { op: "upgrade", gate: "old" }]);
  });

  test("a gate with no plan, or one that asks a decision point, takes none", () => {
    expect(() => gate("approve", { aliases: [{ gate: "old" }] })).toThrow(/aliases need a plan/);
    expect(gateAliasProblems([{ gate: "old" }], { plan: "p", point: "prod" })).toContain("a gate that asks a decision point can't take aliases");
    expect(gateAliasProblems([{ gate: "old" }, { gate: "old" }], { plan: "p" })).toContain("alias old is listed twice");
  });
});

describe("OPS017's check", () => {
  const merged: OpConfig = {
    name: "upgrade",
    overview: "upgrade every tier",
    phases: [{ name: "Wave 1", steps: [{ kind: "gate", gate: "approve-tier-1", plan: PLAN, aliases: [TIER_1] }] }],
  };
  const tier1: OpConfig = { name: "upgrade-tier-1", overview: "tier 1", phases: [{ name: "Gate", steps: [{ kind: "gate", gate: "approve" }] }] };

  test("refuses an alias that is still a gate", () => {
    expect(validateGateAliases([merged])).toEqual([]);
    const [issue] = validateGateAliases([merged, tier1]);
    expect(issue).toMatchObject({ opName: "upgrade", gate: "approve-tier-1" });
    expect(issue!.message).toContain("alias upgrade-tier-1/approve is still a gate");
  });

  test("refuses one alias on two gates", () => {
    const twice: OpConfig = {
      ...merged,
      phases: [...merged.phases, { name: "Wave 2", steps: [{ kind: "gate", gate: "approve-tier-2", plan: PLAN, aliases: [TIER_1] }] }],
    };
    expect(validateGateAliases([twice]).map((i) => i.message)).toEqual([expect.stringContaining("is also an alias of upgrade/approve-tier-1")]);
  });

  test("refuses a gate that drops an identity.gates rule its alias had", () => {
    expect(validateGateAliases([merged], new Map([["approve", null]]))[0]!.message).toContain("identity.gates names its alias approve");
    expect(validateGateAliases([merged], new Map([["approve", "human"], ["approve-tier-1", null]]))[0]!.message).toContain("must keep its alias's class");
    expect(validateGateAliases([merged], new Map([["approve", "human"], ["approve-tier-1", "human"]]))).toEqual([]);
    expect(validateGateAliases([merged], new Map([["approve", null], ["approve-tier-1", "human"]]))).toEqual([]);
  });

  test("names the gate that aliases an old name, for chant approve", () => {
    expect(aliasingGate([merged, undefined], "upgrade-tier-1", "approve")).toEqual({ op: "upgrade", gate: "approve-tier-1" });
    expect(aliasingGate([merged], "upgrade-tier-2", "approve")).toBeUndefined();
  });
});

describe("a gate passes on an approval recorded under its alias", () => {
  test("the approval is written again under the new name, citing the line it came from", async () => {
    const port = ports({ pending: [pending("upgrade-tier-1", "approve")], resolutions: [approval("upgrade-tier-1", "approve", "alice", { url: "https://example.test/pr/1" })] });
    const check = await evaluateGate(port, input());
    expect(check).toMatchObject({ satisfied: true, via: "alias" });
    expect(port.resolved).toHaveLength(1);
    expect(port.resolved[0]).toMatchObject({
      op: "upgrade",
      gate: "approve-tier-1",
      resolvedBy: "alice",
      timestamp: NOW,
      planDigest: PLAN,
      url: "https://example.test/pr/1",
      approver: { kind: "human" },
      carriedFrom: { op: "upgrade-tier-1", gate: "approve", timestamp: at(5) },
    });
    expect(port.appended).toHaveLength(0);

    // The next run counts the carried line as its own and carries nothing more.
    const again = await evaluateGate(port, input({ now: at(40) }));
    expect(again).toMatchObject({ satisfied: true, resolution: { carriedFrom: { op: "upgrade-tier-1" } } });
    expect(again.satisfied && again.via).toBeUndefined();
    expect(port.resolved).toHaveLength(1);
  });

  test("the alias's op defaults to the gate's own, for a gate renamed in place", async () => {
    const port = ports({ pending: [pending("upgrade", "approve")], resolutions: [approval("upgrade", "approve", "alice")] });
    expect(await evaluateGate(port, input({ aliases: resolveGateAliases({ aliases: [{ gate: "approve" }] }, "upgrade") }))).toMatchObject({ satisfied: true, via: "alias" });
  });

  const refusedBecause = async (name: string, seed: Parameters<typeof ports>[0], over: Partial<GateCheckInput> = {}) => {
    const port = ports(seed);
    const check = await evaluateGate(port, input(over));
    expect(check.satisfied, name).toBe(false);
    expect(port.resolved, name).toHaveLength(0);
  };

  test("but not once the old pending fact has expired", () =>
    refusedBecause("expired", { pending: [pending("upgrade-tier-1", "approve", { expiresAt: at(20) })], resolutions: [approval("upgrade-tier-1", "approve", "alice")] }));

  test("nor for another plan", async () => {
    await refusedBecause("moved", { pending: [pending("upgrade-tier-1", "approve")], resolutions: [approval("upgrade-tier-1", "approve", "alice")] }, { planDigest: MOVED });
    await refusedBecause("no plan", { pending: [pending("upgrade-tier-1", "approve")], resolutions: [approval("upgrade-tier-1", "approve", "alice")] }, { planDigest: undefined });
  });

  test("nor from an approval older than the old fact, or for another environment", async () => {
    await refusedBecause("stale", { pending: [pending("upgrade-tier-1", "approve", { timestamp: at(10) })], resolutions: [approval("upgrade-tier-1", "approve", "alice")] });
    await refusedBecause("env", { pending: [pending("upgrade-tier-1", "approve", { environment: "prod" })], resolutions: [approval("upgrade-tier-1", "approve", "alice", { environment: "prod" })] }, { environment: "staging" });
  });

  test("nor from an agent, or a policy permit", async () => {
    await refusedBecause("agent", { pending: [pending("upgrade-tier-1", "approve")], resolutions: [approval("upgrade-tier-1", "approve", "bot", { approver: { kind: "agent" } })] });
    await refusedBecause("mcp", { pending: [pending("upgrade-tier-1", "approve")], resolutions: [approval("upgrade-tier-1", "approve", "bot", { origin: "mcp" })] });
  });

  test("nor from an approval spent under the old name", () =>
    refusedBecause("spent", {
      pending: [pending("upgrade-tier-1", "approve")],
      resolutions: [approval("upgrade-tier-1", "approve", "alice")],
      applied: [{ version: 1, kind: "applied", op: "upgrade-tier-1", gate: "approve", planDigest: PLAN, approvedAt: at(5), approvedBy: "alice", timestamp: at(6) }],
    }));

  test("nor again, once the carried line was spent under the new name", async () => {
    const carried = approval("upgrade", "approve-tier-1", "alice", { timestamp: at(20), carriedFrom: { op: "upgrade-tier-1", gate: "approve", timestamp: at(5) } });
    await refusedBecause(
      "spent carried",
      { pending: [pending("upgrade-tier-1", "approve")], resolutions: [approval("upgrade-tier-1", "approve", "alice"), carried] },
      { spent: [{ version: 1, kind: "applied", op: "upgrade", gate: "approve-tier-1", planDigest: PLAN, approvedAt: at(20), approvedBy: "alice", timestamp: at(21) }] },
    );
  });

  test("a carried line stops counting once the gate no longer names its alias", async () => {
    const carried = approval("upgrade", "approve-tier-1", "alice", { timestamp: at(20), carriedFrom: { op: "upgrade-tier-1", gate: "approve", timestamp: at(5) } });
    const port = ports({ resolutions: [carried] });
    expect((await evaluateGate(port, input())).satisfied).toBe(true);
    expect((await evaluateGate(port, input({ aliases: [] }))).satisfied).toBe(false);
  });

  test("the new gate's identity rule judges the approval, and names the one it refuses", async () => {
    const rule: GateApprovalRule = {
      requirement: { gate: "approve-tier-1", class: null },
      refuses: (r) => (r.seal ? null : `the approval by ${r.resolvedBy} is not signed`),
    };
    const port = { ...ports({ pending: [pending("upgrade-tier-1", "approve")], resolutions: [approval("upgrade-tier-1", "approve", "alice")] }), approvalRule: async () => rule };
    const check = await evaluateGate(port, input());
    expect(check.satisfied).toBe(false);
    expect(!check.satisfied && check.refused?.[0]?.reason).toBe("carried from upgrade-tier-1/approve: the approval by alice is not signed");
  });
});

describe("old and new approvals add up toward one quorum", () => {
  const quorum = { approval: { quorum: { count: 2 }, mode: "log-only" as const } };

  test("an approver under each name passes it, and only the old one is carried", async () => {
    const port = ports({
      pending: [pending("upgrade-tier-1", "approve"), pending("upgrade", "approve-tier-1", { timestamp: at(10), approval: quorum.approval })],
      resolutions: [approval("upgrade-tier-1", "approve", "alice"), approval("upgrade", "approve-tier-1", "bob", { timestamp: at(12) })],
    });
    const check = await evaluateGate(port, input(quorum));
    expect(check).toMatchObject({ satisfied: true, via: "alias" });
    expect(check.satisfied && check.approvals?.map((r) => r.resolvedBy).sort()).toEqual(["alice", "bob"]);
    expect(port.resolved.map((r) => r.resolvedBy)).toEqual(["alice"]);
  });

  test("one person under both names counts once, and the progress shows them", async () => {
    const port = ports({
      pending: [pending("upgrade-tier-1", "approve"), pending("upgrade", "approve-tier-1", { timestamp: at(10), approval: quorum.approval })],
      resolutions: [approval("upgrade-tier-1", "approve", "alice"), approval("upgrade", "approve-tier-1", "alice", { timestamp: at(12) })],
    });
    const check = await evaluateGate(port, input(quorum));
    expect(check.satisfied).toBe(false);
    expect(!check.satisfied && check.quorum).toMatchObject({ approvers: ["alice"], need: 2 });
    expect(port.resolved).toHaveLength(0);
  });

  test("an old approval waiting on its own quorum still counts toward the new one", async () => {
    const port = ports({
      pending: [pending("upgrade-tier-1", "approve", { approval: quorum.approval }), pending("upgrade-tier-2", "approve")],
      resolutions: [approval("upgrade-tier-1", "approve", "alice"), approval("upgrade-tier-2", "approve", "carol")],
    });
    const check = await evaluateGate(port, input({ ...quorum, aliases: [TIER_1, { op: "upgrade-tier-2", gate: "approve" }] }));
    expect(check).toMatchObject({ satisfied: true, via: "alias" });
    expect(port.resolved.map((r) => `${r.resolvedBy}<-${r.carriedFrom?.op}`)).toEqual(["alice<-upgrade-tier-1", "carol<-upgrade-tier-2"]);
  });
});

describe("a carried approval and checkpoints", () => {
  const sealed = approval("upgrade-tier-1", "approve", "alice", {
    relayedBy: "follower",
    checkpointDigest: CHECKPOINT,
    seal: { signer: "alice", key: "SHA256:x", signature: "sig", version: 2 },
  });

  test("its seal is checked against the line it came from, checkpoint digest included", async () => {
    const port = ports({ pending: [pending("upgrade-tier-1", "approve", { checkpointDigest: CHECKPOINT })], resolutions: [sealed] });
    await evaluateGate(port, input());
    const carried = port.resolved[0]!;
    expect(carried).not.toHaveProperty("checkpointDigest");
    expect(carried.carriedFrom).toEqual({ op: "upgrade-tier-1", gate: "approve", timestamp: at(5), checkpointDigest: CHECKPOINT });
    expect(carried.seal).toEqual(sealed.seal);
    expect(gateSealPayload(carried).toString()).toBe(gateSealPayload(sealed).toString());
    expect(gateSealVersion(carried)).toBe(2);

    // The line reads back whole, and a broken citation is a malformed line.
    const text = [JSON.stringify(carried), JSON.stringify({ ...carried, carriedFrom: { op: "x" } })].join("\n");
    expect(parseGateLedger(text)).toMatchObject({ resolutions: [{ carriedFrom: carried.carriedFrom }], malformed: 1 });
  });

  test("it never lets a run resume from the new gate's checkpoint", async () => {
    const config: OpConfig = {
      name: "upgrade",
      overview: "upgrade every tier",
      phases: [{ name: "Gate", steps: [{ kind: "gate", gate: "approve-tier-1", plan: PLAN, resume: true, aliases: [TIER_1] }] }],
    };
    const carried = approval("upgrade", "approve-tier-1", "alice", { timestamp: at(20), checkpointDigest: CHECKPOINT, carriedFrom: { op: "upgrade-tier-1", gate: "approve", timestamp: at(5) } });
    const port = ports({ pending: [pending("upgrade", "approve-tier-1", { timestamp: at(10), checkpointDigest: CHECKPOINT, runId: "run-1" })], resolutions: [carried] });
    expect(await decideGateResume(port, config, { now: NOW, commit: COMMIT })).toEqual({ kind: "none" });
  });

  test("a merged Op passes its resume gate on the old approval, starting at the first phase", async () => {
    const calls: string[] = [];
    const activities = new Map<string, ActivityFn>([
      ["snapshot", async () => (calls.push("snapshot"), { id: "snap-1" })],
      ["plan", async () => (calls.push("plan"), { planDigest: PLAN })],
      ["apply", async () => (calls.push("apply"), { ok: true })],
    ]);
    const config: OpConfig = {
      name: "upgrade",
      overview: "upgrade every tier",
      phases: [
        { name: "Prepare", steps: [{ kind: "activity", id: "snapshot", fn: "snapshot" }, { kind: "activity", id: "plan", fn: "plan" }] },
        { name: "Gate", steps: [{ kind: "gate", gate: "approve-tier-1", plan: stepOutput("plan", "planDigest"), resume: true, aliases: [TIER_1] }] },
        { name: "Apply", steps: [{ kind: "activity", fn: "apply", args: { snapshot: stepOutput("snapshot", "id") } }] },
      ],
    };
    const port = ports({ pending: [pending("upgrade-tier-1", "approve", { checkpointDigest: CHECKPOINT })], resolutions: [sealed] });
    const result = await runOpLocally(config, activities, {}, undefined, { gates: port, now: NOW, runId: "run-1", commit: COMMIT });
    expect(result.status).toBe("ok");
    expect(result.resumed).toBeUndefined();
    expect(calls).toEqual(["snapshot", "plan", "apply"]);
    const gateRecord = result.records.find((r) => r.fn === "gate:approve-tier-1")!;
    expect(gateRecord.approval).toMatchObject({
      resolvedBy: "alice",
      via: "alias",
      carriedFrom: [{ op: "upgrade-tier-1", gate: "approve", resolvedBy: "alice", timestamp: at(5) }],
    });
    expect(port.checkpoints.size).toBe(0);
    const lines: string[] = [];
    renderHuman(result, (l) => lines.push(l));
    expect(lines).toContain(`    [carried] alice's approval of upgrade-tier-1/approve at ${at(5)}`);
  });
});

describe("the rule an alias reads approvals by", () => {
  test("approvalsAnswering takes the standing fact's gate, plan and environment, since the fact", () => {
    const standing = pending("upgrade-tier-1", "approve", { timestamp: at(3) });
    const rs = [
      approval("upgrade-tier-1", "approve", "a"),
      approval("upgrade-tier-1", "approve", "b", { timestamp: at(1) }),
      approval("upgrade-tier-1", "approve", "c", { planDigest: MOVED }),
      approval("upgrade-tier-1", "approve", "d", { environment: "prod" }),
      approval("upgrade-tier-1", "other", "e"),
    ];
    expect(approvalsAnswering(rs, standing).map((r) => r.resolvedBy)).toEqual(["a"]);
  });
});

describe("the audit of a carried approval", () => {
  const carried = approval("upgrade", "approve-tier-1", "alice", { timestamp: at(20), carriedFrom: { op: "upgrade-tier-1", gate: "approve", timestamp: at(5) } });
  const lines = (...records: unknown[]) => records.map((record) => ({ record }));

  test("names where it came from, and finds its request under the old name", () => {
    const { entries, gaps } = deriveGateAudit({
      ledgers: [
        { op: "upgrade-tier-1", lines: lines(pending("upgrade-tier-1", "approve"), approval("upgrade-tier-1", "approve", "alice")) },
        { op: "upgrade", lines: lines(carried) },
      ],
    });
    expect(entries.find((e) => e.op === "upgrade")).toMatchObject({ kind: "approved", carriedFrom: { op: "upgrade-tier-1", gate: "approve", at: at(5) } });
    expect(gaps).toEqual([]);
  });

  test("says when the cited line is missing", () => {
    const { gaps } = deriveGateAudit({ ledgers: [{ op: "upgrade-tier-1", lines: lines(pending("upgrade-tier-1", "approve")) }, { op: "upgrade", lines: lines(carried) }] });
    expect(gaps.map((g) => g.kind)).toEqual(["carried-without-source"]);
  });
});
