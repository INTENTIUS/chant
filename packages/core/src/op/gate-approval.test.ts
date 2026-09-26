/**
 * Gate approval policy (#2508): quorum, roles, and a policy decision that is
 * logged or enforced. The rules are decided by `evaluateGate`, driven here
 * through `memoryGateLedgerPort`; the Cedar evaluation itself is the cedar
 * lexicon's and is tested there.
 */
import { describe, test, expect } from "vitest";
import { evaluateGate, memoryGateLedgerPort, tallyGateApprovals } from "./gate";
import { gate } from "./builders";
import { gateApprovalProblems, gatePolicyRequest, gatePolicyVersion, type GatePolicyRef, type ResolvedGateApproval } from "./gate-approval";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";

const PLAN_A = `sha256:${"a".repeat(64)}`;
const PLAN_B = `sha256:${"b".repeat(64)}`;
const TEXT = 'permit (principal is Chant::Agent, action, resource) when { context.risk == "low" };\n';
const POLICY: GatePolicyRef = { kind: "gate-policy", lexicon: "cedar", name: "ship", version: gatePolicyVersion(TEXT), text: TEXT };

const PENDING: PendingGateRecord = {
  version: 1, kind: "pending", op: "release", gate: "ship",
  timestamp: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-03T00:00:00.000Z", planDigest: PLAN_A,
};
const NOW = "2026-09-01T12:00:00.000Z";

function approval(overrides: Partial<GateResolutionRecord> & { resolvedBy: string; timestamp: string }): GateResolutionRecord {
  return { version: 1, op: "release", gate: "ship", planDigest: PLAN_A, approver: { kind: "human" }, ...overrides };
}

function allow(mode: "log-only" | "enforce" = "enforce"): GateResolutionRecord["policyDecision"] {
  return { policy: "ship", version: POLICY.version, mode, decision: "allow", determining: ["ship-0"], errors: [] };
}

async function decide(resolutions: GateResolutionRecord[], approvalBlock: ResolvedGateApproval, planDigest = PLAN_A) {
  const port = memoryGateLedgerPort({ resolutions, pending: [{ ...PENDING, approval: approvalBlock, planDigest }] });
  const check = await evaluateGate(port, { op: "release", gate: "ship", planDigest, approval: approvalBlock, now: NOW });
  return { check, port };
}

describe("gate approval — quorum (#2508)", () => {
  const twoMaintainers: ResolvedGateApproval = { quorum: { count: 2, roles: ["maintainer"] }, mode: "log-only" };

  test("quorum not met: one approval of two leaves the gate standing and reports progress", async () => {
    const { check, port } = await decide(
      [approval({ resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "human", roles: ["maintainer"] } })],
      twoMaintainers,
    );
    expect(check.satisfied).toBe(false);
    if (check.satisfied) return;
    expect(check.quorum).toEqual({ approvers: ["alex"], need: 2 });
    // The standing fact still describes this gate, so nothing new is appended.
    expect(check.recorded).toBe(false);
    expect(port.appended).toHaveLength(0);
  });

  test("quorum met: two distinct maintainers pass the gate, and both are named", async () => {
    const { check } = await decide(
      [
        approval({ resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "human", roles: ["maintainer"] } }),
        approval({ resolvedBy: "sam", timestamp: "2026-09-01T02:00:00.000Z", approver: { kind: "human", roles: ["maintainer", "sre"] } }),
      ],
      twoMaintainers,
    );
    expect(check.satisfied).toBe(true);
    if (!check.satisfied) return;
    expect(check.via).toBe("quorum");
    expect(check.approvals?.map((r) => r.resolvedBy)).toEqual(["alex", "sam"]);
    expect(check.resolution.resolvedBy).toBe("sam");
  });

  test("the same person approving twice counts once", async () => {
    const { check } = await decide(
      [
        approval({ resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "human", roles: ["maintainer"] } }),
        approval({ resolvedBy: "alex", timestamp: "2026-09-01T02:00:00.000Z", approver: { kind: "human", roles: ["maintainer"] } }),
      ],
      twoMaintainers,
    );
    expect(check.satisfied).toBe(false);
  });

  test("an approver without one of the quorum's roles does not count", async () => {
    const { check } = await decide(
      [
        approval({ resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "human", roles: ["maintainer"] } }),
        approval({ resolvedBy: "pat", timestamp: "2026-09-01T02:00:00.000Z", approver: { kind: "human", roles: ["viewer"] } }),
      ],
      twoMaintainers,
    );
    expect(check.satisfied).toBe(false);
    if (check.satisfied) return;
    expect(check.quorum?.approvers).toEqual(["alex"]);
  });

  test("a changed plan invalidates every collected approval", async () => {
    const { check, port } = await decide(
      [
        approval({ resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "human", roles: ["maintainer"] } }),
        approval({ resolvedBy: "sam", timestamp: "2026-09-01T02:00:00.000Z", approver: { kind: "human", roles: ["maintainer"] } }),
      ],
      twoMaintainers,
      PLAN_B,
    );
    expect(check.satisfied).toBe(false);
    if (check.satisfied) return;
    expect(check.mismatch?.approved).toBe(PLAN_A);
    expect(check.mismatch?.planned).toBe(PLAN_B);
    expect(check.quorum).toEqual({ approvers: [], need: 2 });
    expect(port.appended).toHaveLength(0);
  });

  test("an approval older than the standing pending fact does not count", async () => {
    const { check } = await decide(
      [approval({ resolvedBy: "alex", timestamp: "2026-08-31T00:00:00.000Z" })],
      { quorum: { count: 1 }, mode: "log-only" },
    );
    expect(check.satisfied).toBe(false);
  });

  test("a resolution written before #2508 reads as a human, and one from a model channel as an agent", () => {
    const legacy: GateResolutionRecord = { version: 1, op: "release", gate: "ship", resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z", planDigest: PLAN_A };
    const fromMcp: GateResolutionRecord = { ...legacy, resolvedBy: "unattested", origin: "mcp", timestamp: "2026-09-01T02:00:00.000Z" };
    const tally = tallyGateApprovals([legacy, fromMcp], "ship", PENDING.timestamp, PLAN_A, { quorum: { count: 2 }, mode: "log-only" });
    expect(tally.counted.map((r) => r.resolvedBy)).toEqual(["alex"]);
  });
});

describe("gate approval — policy decisions (#2508)", () => {
  test("log-only: an agent's permit is recorded but does not pass the gate", async () => {
    const block: ResolvedGateApproval = { policy: POLICY, mode: "log-only", context: { risk: "low" } };
    const { check } = await decide(
      [approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" }, policyDecision: allow("log-only") })],
      block,
    );
    expect(check.satisfied).toBe(false);
    if (check.satisfied) return;
    expect(check.quorum).toEqual({ approvers: [], need: 1 });
  });

  test("log-only: a human's approval passes even when the policy recorded a deny", async () => {
    const block: ResolvedGateApproval = { policy: POLICY, mode: "log-only" };
    const { check } = await decide(
      [approval({
        resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z",
        policyDecision: { ...allow("log-only")!, decision: "deny", determining: [] },
      })],
      block,
    );
    expect(check.satisfied).toBe(true);
    if (!check.satisfied) return;
    expect(check.via).toBe("quorum");
    expect(check.resolution.policyDecision?.decision).toBe("deny");
  });

  test("enforce: an agent's permit passes the gate on its own", async () => {
    const block: ResolvedGateApproval = { quorum: { count: 2 }, policy: POLICY, mode: "enforce" };
    const { check } = await decide(
      [approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" }, policyDecision: allow() })],
      block,
    );
    expect(check.satisfied).toBe(true);
    if (!check.satisfied) return;
    expect(check.via).toBe("policy");
    expect(check.resolution.resolvedBy).toBe("release-bot");
  });

  test("enforce: a permit recorded under an older policy version does not count", async () => {
    const block: ResolvedGateApproval = { policy: POLICY, mode: "enforce" };
    const { check } = await decide(
      [approval({
        resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" },
        policyDecision: { ...allow()!, version: gatePolicyVersion("permit (principal, action, resource);\n") },
      })],
      block,
    );
    expect(check.satisfied).toBe(false);
  });

  test("log-only then enforce: a permit recorded under log-only does not pass the enforced gate (#2512)", async () => {
    const logOnly: ResolvedGateApproval = { policy: POLICY, mode: "log-only", context: { risk: "low" } };
    const enforce: ResolvedGateApproval = { ...logOnly, mode: "enforce" };
    // The pending fact was recorded while the gate was log-only, and the agent's allow was recorded against it.
    const port = memoryGateLedgerPort({
      resolutions: [approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" }, policyDecision: allow("log-only") })],
      pending: [{ ...PENDING, approval: logOnly }],
    });
    const check = await evaluateGate(port, { op: "release", gate: "ship", planDigest: PLAN_A, approval: enforce, now: NOW });
    expect(check.satisfied).toBe(false);

    const tally = tallyGateApprovals(
      [approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" }, policyDecision: allow("log-only") })],
      "ship", PENDING.timestamp, PLAN_A, enforce,
    );
    expect(tally.permit).toBeUndefined();
  });

  test("log-only then enforce: a human's approval recorded under log-only still counts toward the quorum (#2512)", async () => {
    const logOnly: ResolvedGateApproval = { quorum: { count: 1 }, policy: POLICY, mode: "log-only" };
    const enforce: ResolvedGateApproval = { ...logOnly, mode: "enforce" };
    const port = memoryGateLedgerPort({
      resolutions: [approval({ resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z", policyDecision: allow("log-only") })],
      pending: [{ ...PENDING, approval: logOnly }],
    });
    const check = await evaluateGate(port, { op: "release", gate: "ship", planDigest: PLAN_A, approval: enforce, now: NOW });
    expect(check.satisfied).toBe(true);
    if (!check.satisfied) return;
    expect(check.via).toBe("quorum");
    expect(check.resolution.resolvedBy).toBe("alex");
  });

  test("enforce: a recorded decision with no mode does not pass the gate (#2512)", async () => {
    const block: ResolvedGateApproval = { policy: POLICY, mode: "enforce" };
    const { mode: _mode, ...noMode } = allow()!;
    const { check } = await decide(
      [approval({
        resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" },
        policyDecision: noMode as GateResolutionRecord["policyDecision"],
      })],
      block,
    );
    expect(check.satisfied).toBe(false);
  });

  test("enforce: a deny-by-default policy keeps the old behaviour, where only a human's approval counts", async () => {
    const block: ResolvedGateApproval = { policy: POLICY, mode: "enforce" };
    const deny = { ...allow()!, decision: "deny" as const, determining: ["floor"] };
    const agentOnly = await decide(
      [approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" }, policyDecision: deny })],
      block,
    );
    expect(agentOnly.check.satisfied).toBe(false);

    const withHuman = await decide(
      [
        approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" }, policyDecision: deny }),
        approval({ resolvedBy: "alex", timestamp: "2026-09-01T02:00:00.000Z", policyDecision: deny }),
      ],
      block,
    );
    expect(withHuman.check.satisfied).toBe(true);
    if (!withHuman.check.satisfied) return;
    expect(withHuman.check.via).toBe("quorum");
  });

  test("a changed approval block re-records the pending fact, so approve evaluates the current context", async () => {
    const port = memoryGateLedgerPort({
      pending: [{ ...PENDING, approval: { policy: POLICY, mode: "log-only", context: { risk: "high" } } }],
    });
    const check = await evaluateGate(port, {
      op: "release", gate: "ship", planDigest: PLAN_A, now: NOW,
      approval: { policy: POLICY, mode: "log-only", context: { risk: "low" } },
    });
    expect(check.satisfied).toBe(false);
    if (check.satisfied) return;
    expect(check.recorded).toBe(true);
    expect(port.appended[0]?.approval?.context).toEqual({ risk: "low" });
  });

  test("a gate with no approval block decides exactly as before", async () => {
    const port = memoryGateLedgerPort({
      resolutions: [approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" } })],
      pending: [PENDING],
    });
    const check = await evaluateGate(port, { op: "release", gate: "ship", planDigest: PLAN_A, now: NOW });
    expect(check.satisfied).toBe(true);
    if (!check.satisfied) return;
    expect(check.via).toBeUndefined();
  });
});

describe("gate approval — the request a policy is asked (#2508)", () => {
  test("carries the approver, the gate and the context, with the plan digest", () => {
    expect(gatePolicyRequest({
      op: "release", gate: "ship", resolvedBy: "release-bot", approver: { kind: "agent", roles: ["deployer"] },
      planDigest: PLAN_A, context: { risk: "low" },
    })).toEqual({
      principal: { kind: "agent", name: "release-bot", roles: ["deployer"] },
      action: "PassGate",
      resource: { op: "release", gate: "ship" },
      context: { risk: "low", planDigest: PLAN_A },
    });
  });
});

describe("gate approval — the approval block is checked where it is written (#2508)", () => {
  test("a well-formed block passes, and lands on the step", () => {
    const step = gate("ship", { approval: { quorum: { count: 2, roles: ["maintainer"] }, policy: POLICY, mode: "enforce", context: { risk: "low" } } });
    expect(step.approval?.quorum?.count).toBe(2);
    expect(gateApprovalProblems(step.approval)).toEqual([]);
  });

  test.each([
    [{ quorum: { count: 0 } }, "quorum.count"],
    [{ quorum: { count: 2, roles: [] } }, "quorum.roles"],
    [{ mode: "enforce" }, "needs an `approval.policy`"],
    [{ mode: "strict" }, "approval.mode"],
    [{ policy: { name: "ship" } }, "does not resolve to a gate policy set"],
    [{ policy: { ...POLICY, version: "sha256:stale" } }, "not the digest of its text"],
    [{ context: { risk: "low" } }, "declares none"],
    [{ policy: POLICY, context: { risk: { level: 1 } } }, "approval.context.risk"],
  ])("rejects %j", (block, expected) => {
    expect(gateApprovalProblems(block).join("\n")).toContain(expected);
    expect(() => gate("ship", { approval: block as never })).toThrow(expected);
  });
});
