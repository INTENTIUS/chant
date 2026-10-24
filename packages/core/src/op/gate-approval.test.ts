/**
 * Gate approval policy (#2508): quorum, roles, and a policy decision that is
 * logged or enforced. The rules are decided by `evaluateGate`, driven here
 * through `memoryGateLedgerPort`; the Cedar evaluation itself is the cedar
 * lexicon's and is tested there.
 */
import { describe, test, expect } from "vitest";
import { evaluateGate, humanQuorumSince, memoryGateLedgerPort, tallyGateApprovals } from "./gate";
import { resolutionAnswering } from "./gate-resume";
import { gatesInLedger } from "../workspace/status-gates";
import { describeApprovalProgress } from "../cli/handlers/operator";
import { gate } from "./builders";
import { gateApprovalProblems, gateContextDigest, gatePolicyRequest, gatePolicyVersion, type GatePolicyRef, type ResolvedGateApproval } from "./gate-approval";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { rolesOf, type GateQuorumJudge } from "./gate-quorum";

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

/** A recorded allow, evaluated under `context` (the context the tests' blocks resolve, by default). */
function allow(mode: "log-only" | "enforce" = "enforce", context: Record<string, unknown> | undefined = { risk: "low" }): GateResolutionRecord["policyDecision"] {
  return { policy: "ship", version: POLICY.version, mode, contextDigest: gateContextDigest(context), decision: "allow", determining: ["ship-0"], errors: [] };
}

/**
 * #4290: roles come from .chant/trust.json at base, for a proven approver.
 * The tests' judge proves everyone and grants these roles.
 */
const ROLES: Record<string, string[]> = { maintainer: ["alex", "sam"], sre: ["sam"], viewer: ["pat"] };
const provenJudge: GateQuorumJudge = (r) => ({ proven: true, roles: rolesOf(r.resolvedBy, ROLES) });

async function decide(resolutions: GateResolutionRecord[], approvalBlock: ResolvedGateApproval, planDigest = PLAN_A, judge: GateQuorumJudge = provenJudge) {
  const port = memoryGateLedgerPort({ resolutions, pending: [{ ...PENDING, approval: approvalBlock, planDigest }] });
  const check = await evaluateGate(port, { op: "release", gate: "ship", planDigest, approval: approvalBlock, now: NOW, judge });
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
    expect(check.quorum).toMatchObject({ approvers: ["alex"], need: 2 });
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
    expect(check.quorum).toMatchObject({ approvers: [], need: 2 });
    expect(port.appended).toHaveLength(0);
  });

  test("#4290: a role the approver claims never counts; only trust.json's grant to a proven approver does", async () => {
    const claimed = [
      approval({ resolvedBy: "pat", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "human", roles: ["maintainer"] } }),
      approval({ resolvedBy: "kim", timestamp: "2026-09-01T02:00:00.000Z", approver: { kind: "human", roles: ["maintainer"] } }),
    ];
    expect((await decide(claimed, twoMaintainers)).check.satisfied).toBe(false);
    // alex and sam hold the role at base, and nothing proves them.
    const unproven: GateQuorumJudge = (r) => ({ proven: false, roles: rolesOf(r.resolvedBy, ROLES) });
    const granted = [approval({ resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z" }), approval({ resolvedBy: "sam", timestamp: "2026-09-01T02:00:00.000Z" })];
    expect((await decide(granted, twoMaintainers, PLAN_A, unproven)).check.satisfied).toBe(false);
    expect((await decide(granted, twoMaintainers)).check.satisfied).toBe(true);
  });

  // #2547: a gate still pending, and an approval given, under the bare sha256: prefix
  // keep working once the run computes the same plan's digest as jcs1-sha256:.
  test("a pending gate and an approval recorded under the bare prefix match the jcs1 digest of the same plan", async () => {
    const jcs = `jcs1-${PLAN_A}`;
    const block: ResolvedGateApproval = { quorum: { count: 1 }, mode: "log-only" };
    const run = async (resolutions: GateResolutionRecord[]) => {
      const port = memoryGateLedgerPort({ resolutions, pending: [{ ...PENDING, approval: block }] });
      return { port, check: await evaluateGate(port, { op: "release", gate: "ship", planDigest: jcs, approval: block, now: NOW }) };
    };
    const approved = await run([approval({ resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z" })]);
    expect(approved.check.satisfied).toBe(true);
    // A standing fact is not rewritten just because the prefix moved.
    const waiting = await run([]);
    expect(waiting.check.satisfied).toBe(false);
    expect(waiting.port.appended).toHaveLength(0);
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
    expect(check.quorum).toMatchObject({ approvers: [], need: 1 });
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
    const block: ResolvedGateApproval = { quorum: { count: 2 }, policy: POLICY, mode: "enforce", context: { risk: "low" } };
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
    const block: ResolvedGateApproval = { policy: POLICY, mode: "enforce", context: { risk: "low" } };
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

  test("log-only then enforce: the gated run re-records the pending fact under enforce, and only a fresh permit passes (#2512)", async () => {
    const logOnly: ResolvedGateApproval = { policy: POLICY, mode: "log-only", context: { risk: "low" } };
    const enforce: ResolvedGateApproval = { ...logOnly, mode: "enforce" };
    const stale = approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" }, policyDecision: allow("log-only") });
    const port = memoryGateLedgerPort({ resolutions: [stale], pending: [{ ...PENDING, approval: logOnly }] });

    const first = await evaluateGate(port, { op: "release", gate: "ship", planDigest: PLAN_A, approval: enforce, now: NOW });
    expect(first.satisfied).toBe(false);
    if (first.satisfied) return;
    // The standing fact described the log-only gate, so a fresh one carries
    // enforce, and `chant approve` evaluates the next agent approval under it.
    expect(first.recorded).toBe(true);
    expect(first.pending.approval?.mode).toBe("enforce");

    // Re-running without a new approval still waits: the stale permit predates the new pending fact as well.
    const again = await evaluateGate(port, { op: "release", gate: "ship", planDigest: PLAN_A, approval: enforce, now: "2026-09-01T12:30:00.000Z" });
    expect(again.satisfied).toBe(false);

    const fresh = approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T13:00:00.000Z", approver: { kind: "agent" }, policyDecision: allow("enforce") });
    const after = await evaluateGate(
      memoryGateLedgerPort({ resolutions: [stale, fresh], pending: [first.pending] }),
      { op: "release", gate: "ship", planDigest: PLAN_A, approval: enforce, now: "2026-09-01T14:00:00.000Z" },
    );
    expect(after.satisfied).toBe(true);
    if (!after.satisfied) return;
    expect(after.via).toBe("policy");
    expect(after.resolution.timestamp).toBe(fresh.timestamp);
  });

  test("enforce: a recorded decision with no mode does not pass the gate (#2512)", async () => {
    const block: ResolvedGateApproval = { policy: POLICY, mode: "enforce", context: { risk: "low" } };
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

describe("gate approval — a re-recorded pending fact keeps a partly filled quorum (#3206)", () => {
  const twoLogOnly: ResolvedGateApproval = { quorum: { count: 2 }, policy: POLICY, mode: "log-only", context: { risk: "low" } };
  const twoEnforce: ResolvedGateApproval = { ...twoLogOnly, mode: "enforce" };
  const alex = approval({ resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z", policyDecision: allow("log-only") });
  const sam = approval({ resolvedBy: "sam", timestamp: "2026-09-01T13:00:00.000Z" });

  /** Run the gate once under `before`'s pending fact with `next`, then again after `later` approvals. */
  async function switchThenApprove(before: ResolvedGateApproval, next: ResolvedGateApproval, later: GateResolutionRecord[], planDigest = PLAN_A) {
    const port = memoryGateLedgerPort({ resolutions: [alex], pending: [{ ...PENDING, approval: before }] });
    const first = await evaluateGate(port, { op: "release", gate: "ship", planDigest, approval: next, now: NOW });
    const ledger = await port.read("release");
    const after = await evaluateGate(
      memoryGateLedgerPort({ resolutions: [...ledger.resolutions, ...later], pending: ledger.pending }),
      { op: "release", gate: "ship", planDigest, approval: next, now: "2026-09-01T14:00:00.000Z" },
    );
    return { first, after, pending: ledger.pending };
  }

  test("log-only then enforce: the switch re-records the fact, and the human approval from before it still counts", async () => {
    const { first, after } = await switchThenApprove(twoLogOnly, twoEnforce, [sam]);
    expect(first.satisfied).toBe(false);
    if (first.satisfied) return;
    expect(first.recorded).toBe(true);
    expect(first.quorum).toMatchObject({ approvers: ["alex"], need: 2 });

    expect(after.satisfied).toBe(true);
    if (!after.satisfied) return;
    expect(after.via).toBe("quorum");
    expect(after.approvals?.map((r) => r.resolvedBy)).toEqual(["alex", "sam"]);
  });

  test("a changed context keeps the quorum too", async () => {
    const { after } = await switchThenApprove(twoLogOnly, { ...twoLogOnly, context: { risk: "high" } }, [sam]);
    expect(after.satisfied).toBe(true);
  });

  test("one approval of two is still one after the switch, so the gate waits", async () => {
    const { after } = await switchThenApprove(twoLogOnly, twoEnforce, []);
    expect(after.satisfied).toBe(false);
    if (after.satisfied) return;
    expect(after.quorum).toMatchObject({ approvers: ["alex"], need: 2 });
  });

  test("a changed policy version starts the count again", async () => {
    const text = TEXT.replace("low", "medium");
    const edited: GatePolicyRef = { ...POLICY, version: gatePolicyVersion(text), text };
    const { after } = await switchThenApprove(twoLogOnly, { ...twoLogOnly, policy: edited }, [sam]);
    expect(after.satisfied).toBe(false);
    if (after.satisfied) return;
    expect(after.quorum).toMatchObject({ approvers: ["sam"], need: 2 });
  });

  test("a fact for another plan in between starts the count again", async () => {
    const pending: PendingGateRecord[] = [
      { ...PENDING, approval: twoLogOnly },
      { ...PENDING, timestamp: "2026-09-01T02:00:00.000Z", planDigest: PLAN_B, approval: twoLogOnly },
      { ...PENDING, timestamp: "2026-09-01T03:00:00.000Z", approval: twoEnforce },
    ];
    expect(humanQuorumSince(pending, pending[2]!)).toBe(pending[2]!.timestamp);
    const check = await evaluateGate(
      memoryGateLedgerPort({ resolutions: [alex, sam], pending }),
      { op: "release", gate: "ship", planDigest: PLAN_A, approval: twoEnforce, now: "2026-09-01T14:00:00.000Z" },
    );
    expect(check.satisfied).toBe(false);
  });

  test("a fact that had expired before the next was recorded starts the count again", async () => {
    const pending: PendingGateRecord[] = [
      { ...PENDING, approval: twoLogOnly, expiresAt: "2026-09-01T02:00:00.000Z" },
      { ...PENDING, timestamp: "2026-09-01T03:00:00.000Z", approval: twoEnforce },
    ];
    expect(humanQuorumSince(pending, pending[1]!)).toBe(pending[1]!.timestamp);
    const unexpired = [{ ...pending[0]!, expiresAt: PENDING.expiresAt }, pending[1]!];
    expect(humanQuorumSince(unexpired, unexpired[1]!)).toBe(PENDING.timestamp);
  });

  test("a permit from before the standing fact still never passes, even one recorded under enforce", async () => {
    const bot = approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:30:00.000Z", approver: { kind: "agent" }, policyDecision: allow("enforce") });
    const enforceHigh: ResolvedGateApproval = { ...twoEnforce, context: { risk: "high" } };
    const pending: PendingGateRecord[] = [
      { ...PENDING, approval: enforceHigh },
      { ...PENDING, timestamp: "2026-09-01T02:00:00.000Z", approval: twoEnforce },
    ];
    const check = await evaluateGate(
      memoryGateLedgerPort({ resolutions: [bot], pending }),
      { op: "release", gate: "ship", planDigest: PLAN_A, approval: twoEnforce, now: NOW },
    );
    expect(check.satisfied).toBe(false);
    if (check.satisfied) return;
    expect(check.recorded).toBe(false);
  });

  test("workspace status, the resume check and chant approve's progress line count it the same way", async () => {
    const { pending } = await switchThenApprove(twoLogOnly, twoEnforce, []);
    const standing = pending[pending.length - 1]!;

    const content = [...pending, alex, sam].map((r) => JSON.stringify(r)).join("\n") + "\n";
    const gate = gatesInLedger("release", content, [], "2026-09-01T14:00:00.000Z").gates[0];
    expect(gate?.state).toBe("approved");
    expect(gate?.approvals.map((a) => a.principal)).toEqual(["alex", "sam"]);

    expect(resolutionAnswering([alex, sam], standing, pending)?.resolvedBy).toBe("sam");
    expect(resolutionAnswering([alex, sam], standing)).toBeUndefined();

    const lines = describeApprovalProgress(twoEnforce, sam, [alex], standing, pending);
    expect(lines).toContain("Quorum: 2 of 2 human approval(s) for this plan (alex, sam).");
  });
});

describe("gate approval — a permit counts only under the context it was given for (#3774)", () => {
  const low: ResolvedGateApproval = { policy: POLICY, mode: "enforce", context: { risk: "low" } };
  const high: ResolvedGateApproval = { ...low, context: { risk: "high" } };
  const bot = approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" }, policyDecision: allow("enforce", low.context) });

  test("the permit passes the run whose context it was given for", async () => {
    const { check } = await decide([bot], low);
    expect(check.satisfied).toBe(true);
    if (!check.satisfied) return;
    expect(check.via).toBe("policy");
  });

  test("once the context changes, the permit does not pass, and the run re-records the fact under the new context", async () => {
    // The standing fact is the low-risk one the permit was given against; this
    // run resolved risk "high" and checks approvals before re-recording.
    const port = memoryGateLedgerPort({ resolutions: [bot], pending: [{ ...PENDING, approval: low }] });
    const check = await evaluateGate(port, { op: "release", gate: "ship", planDigest: PLAN_A, approval: high, now: NOW });
    expect(check.satisfied).toBe(false);
    if (check.satisfied) return;
    expect(check.recorded).toBe(true);
    expect(port.appended[0]?.approval?.context).toEqual({ risk: "high" });

    // The next run, under the same high-risk context, still waits: nothing new was approved.
    const ledger = await port.read("release");
    const next = await evaluateGate(memoryGateLedgerPort(ledger), { op: "release", gate: "ship", planDigest: PLAN_A, approval: high, now: "2026-09-01T13:00:00.000Z" });
    expect(next.satisfied).toBe(false);
    if (next.satisfied) return;
    expect(next.recorded).toBe(false);
  });

  test("context keys compare in any order, and nested values count", () => {
    expect(gateContextDigest({ risk: "low", paths: ["a"] })).toBe(gateContextDigest({ paths: ["a"], risk: "low" }));
    expect(gateContextDigest({ plan: { adds: 1, deletes: 0 } })).toBe(gateContextDigest({ plan: { deletes: 0, adds: 1 } }));
    expect(gateContextDigest({ plan: { adds: 1, deletes: 0 } })).not.toBe(gateContextDigest({ plan: { adds: 1, deletes: 1 } }));
    expect(gateContextDigest(undefined)).toBe(gateContextDigest({}));
  });

  test("a permit recorded before #3774, with no context on it, does not pass an enforced gate", async () => {
    const { contextDigest: _c, ...legacy } = allow()!;
    const { check } = await decide(
      [approval({ resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z", approver: { kind: "agent" }, policyDecision: legacy })],
      low,
    );
    expect(check.satisfied).toBe(false);
  });

  test("a human's approval still counts toward the quorum after the context changes (#3206)", async () => {
    const alex = approval({ resolvedBy: "alex", timestamp: "2026-09-01T01:00:00.000Z", policyDecision: allow("enforce", low.context) });
    const { check } = await decide([alex], high);
    expect(check.satisfied).toBe(true);
    if (!check.satisfied) return;
    expect(check.via).toBe("quorum");
  });
});

describe("gate approval — the request a policy is asked (#2508)", () => {
  test("carries the approver, the gate and the context, with the plan digest", () => {
    expect(gatePolicyRequest({
      op: "release", gate: "ship", resolvedBy: "release-bot", approver: { kind: "agent" }, roles: ["deployer"],
      planDigest: PLAN_A, context: { risk: "low" },
    })).toEqual({
      principal: { kind: "agent", name: "release-bot", roles: ["deployer"] },
      action: "PassGate",
      resource: { op: "release", gate: "ship" },
      context: { risk: "low", planDigest: PLAN_A },
    });
  });

  test("never carries the roles the approver claims (#4324)", () => {
    const request = gatePolicyRequest({ op: "release", gate: "ship", resolvedBy: "github:sam", approver: { kind: "human", roles: ["maintainer"] } });
    expect(request.principal.roles).toEqual([]);
  });
});

describe("gate approval — the approval block is checked where it is written (#2508)", () => {
  test("a well-formed block passes, and lands on the step", () => {
    const step = gate("ship", { approval: { quorum: { count: 2, roles: ["maintainer"] }, policy: POLICY, mode: "enforce", context: { risk: "low" } } });
    expect((step.approval?.quorum as { count: number } | undefined)?.count).toBe(2);
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
