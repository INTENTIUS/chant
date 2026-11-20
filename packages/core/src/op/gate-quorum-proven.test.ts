/**
 * A rule's count met by proven approvers only (#5349), and the warning for a
 * count plain `chant approve` lines can meet.
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { quorumProblems, quorumRuleLine, quorumRuleProgress, ruleNeedsProof, type GateQuorumJudge, type GateQuorumRule } from "./gate-quorum";
import { evaluateGate, memoryGateLedgerPort } from "./gate";
import { gateApprovalProblems } from "./gate-approval";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import { opWavesQuorumWarnings } from "./op-waves-quorum-warnings";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { waveSetDigest } from "../gated-waves";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { TrustPolicy } from "../workspace/trust/policy";
import type { MergedReview, ReviewSource } from "./gate-review";

const at = (h: number) => `2026-11-19T0${h}:00:00Z`;
const judgeOf = (proven: string[]): GateQuorumJudge => (r) => ({ proven: proven.includes(r.resolvedBy), roles: [] });
const approvers = (names: string[], judge: GateQuorumJudge) =>
  names.map((who, i) => ({ who, at: at(i), judged: judge({ version: 1, op: "ship", gate: "prod", resolvedBy: who, timestamp: at(i) } as GateResolutionRecord) }));

describe("proven approvers (#5349)", () => {
  test("a rule with proven counts only proven approvers toward its count", () => {
    const rule: GateQuorumRule = { count: 2, proven: true };
    const judge = judgeOf(["github:alice"]);
    const p = quorumRuleProgress(rule, approvers(["github:alice", "github:bob", "github:carol"], judge));
    expect(p).toMatchObject({ approvers: ["github:alice"], met: false, proven: true });
    expect(quorumRuleLine(p)).toBe("every target: 1 of 2 approvals (github:alice), needs 1 more proven");
    expect(quorumRuleProgress(rule, approvers(["github:alice", "github:bob"], judgeOf(["github:alice", "github:bob"]))).met).toBe(true);
  });

  test("without proven, the count takes every human approver, as before", () => {
    const p = quorumRuleProgress({ count: 2 }, approvers(["github:alice", "github:bob"], judgeOf([])));
    expect(p).toMatchObject({ approvers: ["github:alice", "github:bob"], met: true });
    expect(p.proven).toBeUndefined();
  });

  test("a rule with nobody approving is never met, proven or not", () => {
    expect(quorumRuleProgress({ count: 1, proven: true }, []).met).toBe(false);
    expect(quorumRuleProgress({ count: 1, proven: false }, []).met).toBe(false);
  });

  test("proven makes a rule need proof, so a gate asks its judge", async () => {
    expect(ruleNeedsProof({ count: 2, proven: true })).toBe(true);
    expect(ruleNeedsProof({ count: 2, proven: false })).toBe(false);
    const digest = `sha256:${"a".repeat(64)}`;
    const line = (who: string, h: number): GateResolutionRecord => ({ version: 1, op: "ship", gate: "prod", resolvedBy: who, timestamp: at(h), planDigest: digest, approver: { kind: "human" } });
    const seeded = { resolutions: [line("github:alice", 1), line("github:bob", 2)] };
    const input = { op: "ship", gate: "prod", planDigest: digest, approval: { mode: "log-only" as const, quorum: [{ count: 2, proven: true }] }, now: at(3) };
    expect((await evaluateGate(memoryGateLedgerPort(seeded), input)).satisfied).toBe(false);
    const port = { ...memoryGateLedgerPort(seeded), quorumJudge: async () => judgeOf(["github:alice", "github:bob"]) };
    expect((await evaluateGate(port, input)).satisfied).toBe(true);
  });

  test("an Op waves spec reads proven; an Op gate and identity.gates refuse it", () => {
    expect(quorumProblems([{ count: 2, proven: true }], "approvals.quorum", { notAuthor: true, proven: true })).toEqual([]);
    expect(quorumProblems([{ count: 2, proven: "yes" }], "approvals.quorum", { notAuthor: true, proven: true })).toEqual(["`approvals.quorum[0].proven` must be true or false"]);
    expect(quorumProblems([{ count: 1, who: 1 }], "approvals.quorum", { notAuthor: true, proven: true })).toEqual([
      "`approvals.quorum[0].who` is not a quorum field; use targets, count, roles, notAuthor or proven",
    ]);
    expect(gateApprovalProblems({ quorum: [{ count: 2, proven: true }] } as never)).toEqual([expect.stringMatching(/proven` is not read here/)]);
    expect(quorumProblems({ count: 2, proven: true }, "identity.gates.ship.quorum", { notAuthor: false })).toEqual([expect.stringMatching(/proven` is not read here/)]);
  });
});

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const spec: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [{ name: "prod", runs: [{ target: "prod-eu" }, { target: "prod-us" }] }],
};
const set = waveSetDigest([
  { member: "prod-eu", planDigest: digest("e") },
  { member: "prod-us", planDigest: digest("u") },
]);

function harness(atBase: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-proven-"));
  const calls: string[] = [];
  const exec: OpWaveExec = (argv, dir) => {
    calls.push(argv.join(" "));
    if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: digest(argv[2] === "prod-eu" ? "e" : "u") }));
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(atBase) });
  return { cwd, exec, show, applies: () => calls.filter((c) => c.startsWith("tool apply")).length, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

const noTrust = (): TrustPolicy =>
  ({ base: "b".repeat(40), signersPath: ".chant/allowed_signers", active: false, signers: [], excluded: [], roles: {}, adopted: [], runners: [], excludedRunners: [], admitted: {}, problems: [] }) as TrustPolicy;
const reviews = (merged: MergedReview | null): ReviewSource => ({ kind: "github", mergedReview: async () => merged });
const plainLine = (who: string, when: string) => ({ version: 1 as const, op: "migrations", gate: "migrations-wave-1", resolvedBy: who, timestamp: when, planDigest: set });

describe("Op waves with proven approvers (#5349)", () => {
  test("two plain chant approve lines meet count 2, and with proven at base they do not", async () => {
    const lines = [plainLine("alice", "2026-11-19T01:00:00Z"), plainLine("bob", "2026-11-19T01:30:00Z")];
    const plain = harness({ ...spec, approvals: { quorum: [{ count: 2 }] } });
    const before = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: plain.cwd, exec: plain.exec, show: plain.show, gates: memoryGateLedgerPort({ resolutions: lines }), trust: noTrust, now: "2026-11-19T02:00:00Z" });
    expect(before.exitCode).toBe(0);
    plain.done();

    const strict = harness({ ...spec, approvals: { quorum: [{ count: 2, proven: true }] } });
    const logs: string[] = [];
    const held = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: strict.cwd, exec: strict.exec, show: strict.show, gates: memoryGateLedgerPort({ resolutions: lines }), trust: noTrust, now: "2026-11-19T02:00:00Z", log: (l) => logs.push(l) });
    expect(held.exitCode).toBe(3);
    expect(strict.applies()).toBe(0);
    expect(held.decision?.quorumProgress?.[0]).toMatchObject({ approvers: [], met: false, proven: true });
    expect(logs.some((l) => /needs 2 more proven/.test(l))).toBe(true);
    expect(held.decision?.approve).toMatch(/--sign/);
    strict.done();
  });

  test("under pr-review, two approving reviewers of the merged pull request meet a proven count of 2", async () => {
    const atBase: OpWavesSpec = { ...spec, waves: [{ ...spec.waves[0]!, approval: "pr-review" }], approvals: { quorum: [{ count: 2, proven: true }] } };
    const h = harness(atBase);
    const merged: MergedReview = { pr: 9, head: "h".repeat(40), author: "github:dana", approvers: ["github:alice", "github:bob"], refused: [] };
    const headPlans = async () => ({ version: 1 as const, name: "migrations", head: merged.head, timestamp: "2026-11-19T00:00:00Z", waves: [{ wave: 1, name: "prod", digest: set }] });
    const result = await runOpWave({ spec: atBase, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, head: "m".repeat(40), headPlans, gates: memoryGateLedgerPort(), reviews: reviews(merged), trust: noTrust, now: "2026-11-19T02:00:00Z" });
    expect(result.exitCode).toBe(0);
    expect(result.decision?.approvedBy).toBe("github:alice, github:bob");
    expect(h.applies()).toBe(2);
    h.done();
  });

  test("the spec takes proven, true or false", () => {
    expect(() => assertOpWavesSpec({ ...spec, approvals: { quorum: [{ count: 2, proven: true }] } })).not.toThrow();
    expect(() => assertOpWavesSpec({ ...spec, approvals: { quorum: [{ count: 2, proven: "yes" }] } } as unknown as OpWavesSpec)).toThrow(/proven` must be true or false/);
  });
});

describe("opWavesQuorumWarnings (#5349)", () => {
  test("warns on a count above 1 under a mode that takes plain approval lines", () => {
    const warnings = opWavesQuorumWarnings({ ...spec, approvals: { quorum: [{ targets: ["prod-*"], count: 2 }] } });
    expect(warnings).toEqual([expect.stringMatching(/^wave 1 \(prod\): approvals.quorum\[0\] asks for 2 approvers under `ledger`.*proven: true/)]);
    for (const approval of ["pr-review", "pull-request"] as const) {
      expect(opWavesQuorumWarnings({ ...spec, waves: [{ ...spec.waves[0]!, approval }], approvals: { quorum: [{ count: 3 }] } })).toHaveLength(1);
    }
  });

  test("says nothing for proven, roles, sealed, a count of 1, or a rule the wave does not take", () => {
    const quiet = (s: Partial<OpWavesSpec>) => opWavesQuorumWarnings({ ...spec, ...s });
    expect(quiet({ approvals: { quorum: [{ count: 2, proven: true }] } })).toEqual([]);
    expect(quiet({ approvals: { quorum: [{ count: 2, roles: ["platform"] }] } })).toEqual([]);
    expect(quiet({ approvals: { quorum: [{ count: 1 }] } })).toEqual([]);
    expect(quiet({ approvals: { quorum: [{ targets: ["dev"], count: 2 }] } })).toEqual([]);
    expect(quiet({ waves: [{ ...spec.waves[0]!, approval: "sealed" }], approvals: { quorum: [{ count: 2 }] } })).toEqual([]);
    expect(quiet({})).toEqual([]);
  });
});
