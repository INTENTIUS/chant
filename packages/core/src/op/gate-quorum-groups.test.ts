/**
 * #5354: approval rules combine in `all` and `any` groups, nested up to
 * three deep, each rule and group with a name that shows in its line and on
 * the pending fact. An `any` never opens a way past the gate's approval.
 */

import { describe, expect, test } from "vitest";
import {
  quorumGroupLines,
  quorumProblems,
  quorumRuleLine,
  quorumRules,
  quorumRuleSites,
  quorumRulesFor,
  quorumTreeProgress,
  QUORUM_MAX_DEPTH,
  type GateQuorumJudge,
  type GateQuorumNode,
  type QuorumApprover,
} from "./gate-quorum";
import { evaluateGate, memoryGateLedgerPort, tallyGateApprovals } from "./gate";
import { opWavesQuorumWarnings } from "./op-waves-quorum-warnings";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";

const OPTS = { notAuthor: true, proven: true, combine: true } as const;
const DIGEST = "sha256:" + "c".repeat(64);

/** Two proven approvers, or one release manager. */
const RELEASE: GateQuorumNode[] = [
  {
    name: "release",
    any: [
      { name: "two-approvers", count: 2, proven: true },
      { name: "release-manager", count: 1, roles: ["release-manager"] },
    ],
  },
];

const approver = (who: string, proven: boolean, roles: string[] = []): QuorumApprover => ({ who, at: "2026-11-20T00:00:00Z", judged: { proven, roles } });

describe("reading groups", () => {
  test("groups and names read only with combine, and a list of rules reads as before", () => {
    expect(quorumProblems(RELEASE, "q", OPTS)).toEqual([]);
    expect(quorumProblems(RELEASE, "q", { notAuthor: true, proven: true })).toEqual([
      "`q[0].count` must be an integer of at least 1",
      "`q[0].name` is not a quorum field; use targets, count, roles, notAuthor or proven",
      "`q[0].any` is not a quorum field; use targets, count, roles, notAuthor or proven",
    ]);
    expect(quorumProblems([{ count: 2 }, { count: 1, roles: ["sre"] }], "q", OPTS)).toEqual([]);
  });

  test(`groups nest ${QUORUM_MAX_DEPTH} deep and no further`, () => {
    const nest = (depth: number): GateQuorumNode => (depth === 0 ? { count: 1 } : { all: [nest(depth - 1)] });
    expect(quorumProblems([nest(QUORUM_MAX_DEPTH)], "q", OPTS)).toEqual([]);
    expect(quorumProblems([nest(QUORUM_MAX_DEPTH + 1)], "q", OPTS)).toEqual([`\`q[0].all[0].all[0].all[0]\` nests groups deeper than ${QUORUM_MAX_DEPTH}; all and any nest up to ${QUORUM_MAX_DEPTH} groups deep`]);
  });

  test("an empty group, a group with both kinds, a bad name and a name used twice are refused", () => {
    expect(quorumProblems([{ any: [] }], "q", OPTS)).toEqual(["`q[0].any` must list at least one rule"]);
    expect(quorumProblems([{ all: [{ count: 1 }], any: [{ count: 1 }] } as never], "q", OPTS)).toContain("`q[0]` names both all and any; a group is one of them");
    expect(quorumProblems([{ name: "Two Approvers", count: 2 }], "q", OPTS)).toEqual(["`q[0].name` must be lowercase letters, digits, - and _"]);
    expect(quorumProblems([{ name: "a", count: 1 }, { any: [{ name: "a", count: 2 }] }], "q", OPTS)).toEqual(['`q[1].any[0].name` is "a", which another rule of the gate already names']);
    expect(quorumProblems([{ any: [{ count: 1 }], targets: ["prod"] } as never], "q", OPTS)).toEqual(["`q[0].targets` is not read on a group; a group takes name and one of all or any"]);
  });

  test("the flat list of rules holds the grouped ones, each with where it is written", () => {
    expect(quorumRules(RELEASE).map((r) => r.name)).toEqual(["two-approvers", "release-manager"]);
    expect(quorumRuleSites(RELEASE, "approvals.quorum").map((s) => s.at)).toEqual(["approvals.quorum[0].any[0]", "approvals.quorum[0].any[1]"]);
  });
});

describe("meeting groups", () => {
  test("an any group is met by one of its rules, and its line says which", () => {
    const none = quorumTreeProgress(RELEASE, [approver("alice", true)]);
    expect(none.met).toBe(false);
    expect(quorumGroupLines(none.groups)).toEqual(["any release: waits for one of two-approvers, release-manager"]);
    expect(none.rules.map(quorumRuleLine)).toEqual([
      "two-approvers (every target): 1 of 2 approvals (alice), needs 1 more proven",
      "release-manager (every target): 0 of 1 approval, needs 1 more from release-manager",
    ]);

    const rm = quorumTreeProgress(RELEASE, [approver("carol", true, ["release-manager"])]);
    expect(rm.met).toBe(true);
    expect(quorumGroupLines(rm.groups)).toEqual(["any release: met by release-manager"]);

    const two = quorumTreeProgress(RELEASE, [approver("alice", true), approver("bob", true)]);
    expect(two.met).toBe(true);
    expect(quorumGroupLines(two.groups)).toEqual(["any release: met by two-approvers"]);
  });

  test("an any group counts no plain approval toward a rule that needs proof", () => {
    // Two plain lines in two names do not meet `two-approvers`, which counts proven approvers only.
    expect(quorumTreeProgress(RELEASE, [approver("alice", false), approver("mallory", false)]).met).toBe(false);
  });

  test("nested groups: all of a security sign-off and any release path", () => {
    const nodes: GateQuorumNode[] = [{ name: "security", count: 1, roles: ["security"] }, ...RELEASE];
    expect(quorumTreeProgress(nodes, [approver("carol", true, ["release-manager"])]).met).toBe(false);
    const both = quorumTreeProgress(nodes, [approver("carol", true, ["release-manager"]), approver("sam", true, ["security"])]);
    expect(both.met).toBe(true);
  });

  test("a group whose rules a gate's targets leave out is dropped, never met by nobody", () => {
    const nodes: GateQuorumNode[] = [{ any: [{ count: 2, targets: ["prod-*"] }, { count: 1, roles: ["sre"], targets: ["prod-*"] }] }];
    expect(quorumRulesFor(nodes, ["staging"])).toEqual([]);
    const kept = quorumRulesFor<GateQuorumNode>([{ any: [{ count: 2, targets: ["prod-*"] }, { count: 3 }] }], ["staging"]);
    expect(kept).toEqual([{ any: [{ count: 3 }] }]);
    // An empty list is not met: the caller asks for its one human approval.
    expect(quorumTreeProgress([], []).met).toBe(false);
  });
});

describe("a gate with groups", () => {
  const judge: GateQuorumJudge = (r) => ({ proven: r.seal !== undefined, roles: r.resolvedBy === "carol" && r.seal !== undefined ? ["release-manager"] : [] });
  const line = (resolvedBy: string, sealed: boolean, at = "2026-11-20T00:00:01Z"): GateResolutionRecord => ({
    version: 1,
    op: "shop",
    gate: "prod",
    resolvedBy,
    timestamp: at,
    planDigest: DIGEST,
    ...(sealed ? { seal: { signer: resolvedBy, key: "k", signature: "s" } } : {}),
  });

  test("the tally reads the groups, and lists every rule and group", () => {
    const tally = tallyGateApprovals([line("alice", false), line("bob", false)], "prod", "2026-11-20T00:00:00Z", DIGEST, { quorum: RELEASE, mode: "enforce" }, undefined, judge);
    expect(tally.met).toBe(false);
    expect(tally.groups).toHaveLength(1);
    const met = tallyGateApprovals([line("carol", true)], "prod", "2026-11-20T00:00:00Z", DIGEST, { quorum: RELEASE, mode: "enforce" }, undefined, judge);
    expect(met.met).toBe(true);
    expect(met.counted.map((r) => r.resolvedBy)).toEqual(["carol"]);
  });

  test("the pending fact on the ledger carries the named rules, and an approval by a release manager passes the gate", async () => {
    const port = memoryGateLedgerPort();
    const waiting = await evaluateGate(port, { op: "shop", gate: "prod", planDigest: DIGEST, now: "2026-11-20T00:00:00Z", approval: { quorum: RELEASE, mode: "enforce" }, judge, gitSha: "a".repeat(40), runId: "r" });
    expect(waiting.satisfied).toBe(false);
    expect(port.appended[0]?.approval?.quorum).toEqual(RELEASE);
    if (!waiting.satisfied) expect(quorumGroupLines(waiting.quorum?.groups)).toEqual(["any release: waits for one of two-approvers, release-manager"]);

    const after = memoryGateLedgerPort({ pending: port.appended, resolutions: [line("carol", true)] });
    const passed = await evaluateGate(after, { op: "shop", gate: "prod", planDigest: DIGEST, now: "2026-11-20T00:00:02Z", approval: { quorum: RELEASE, mode: "enforce" }, judge, gitSha: "a".repeat(40), runId: "r" });
    expect(passed).toMatchObject({ satisfied: true, via: "quorum" });
  });
});

describe("an Op waves spec", () => {
  const spec = (quorum: GateQuorumNode[]): OpWavesSpec => ({
    name: "migrations",
    op: "migrate",
    plan: ["tool", "plan", "{target}", "--out", "{plan}"],
    apply: ["tool", "apply", "{plan}"],
    approvals: { quorum },
    waves: [{ name: "prod", runs: [{ target: "prod-eu" }] }],
  } as OpWavesSpec);

  test("takes groups and names, and refuses a group nested too deep", () => {
    expect(() => assertOpWavesSpec(spec(RELEASE))).not.toThrow();
    expect(() => assertOpWavesSpec(spec([{ all: [{ all: [{ all: [{ all: [{ count: 1 }] }] }] }] }]))).toThrow(/nests groups deeper than 3/);
  });

  test("the warnings read grouped rules and name where each is written", () => {
    const warnings = opWavesQuorumWarnings(spec([{ any: [{ count: 2 }, { count: 1, roles: ["sre"] }] }]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("approvals.quorum[0].any[0] asks for 2 approvers");
  });
});
