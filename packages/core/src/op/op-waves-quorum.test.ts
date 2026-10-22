import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { waveSetDigest } from "../gated-waves";
import type { TrustPolicy } from "../workspace/trust/policy";
import type { MergedReview, ReviewSource } from "./gate-review";

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
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-quorum-"));
  const calls: string[] = [];
  const exec: OpWaveExec = (argv, dir) => {
    calls.push(argv.join(" "));
    if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: digest(argv[2] === "prod-eu" ? "e" : "u") }));
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(atBase) });
  return { cwd, exec, show, applies: () => calls.filter((c) => c.startsWith("tool apply")).length, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

const trust = (roles: Record<string, string[]>): (() => TrustPolicy) => () =>
  ({ base: "b".repeat(40), signersPath: ".chant/allowed_signers", active: false, signers: [], excluded: [], roles, adopted: [], runners: [], excludedRunners: [], admitted: {}, problems: [] }) as TrustPolicy;

const reviews = (merged: MergedReview | null): ReviewSource => ({ kind: "github", mergedReview: async () => merged });
const approval = (who: string, at: string) => ({ version: 1 as const, op: "migrations", gate: "migrations-wave-1", resolvedBy: who, timestamp: at, planDigest: set });

describe("Op waves approval rules (#4290)", () => {
  test("the spec checks approvals.quorum, and refuses it beside a decision point", () => {
    expect(() => assertOpWavesSpec({ ...spec, approvals: { quorum: [{ targets: ["prod-*"], count: 2, roles: ["platform"], notAuthor: true }] } })).not.toThrow();
    expect(() => assertOpWavesSpec({ ...spec, approvals: { quorum: [{ count: 0 }] } })).toThrow(/approvals.quorum\[0\].count/);
    expect(() => assertOpWavesSpec({ ...spec, approvals: { quorum: { count: 1 } } } as unknown as OpWavesSpec)).toThrow(/must be a list of rules/);
    expect(() => assertOpWavesSpec({ ...spec, point: "ship", approvals: { quorum: [{ count: 1 }] } })).toThrow(/both set/);
  });

  test("a rule at base whose glob matches a run holds the wave until two people approve", async () => {
    const atBase: OpWavesSpec = { ...spec, approvals: { quorum: [{ targets: ["prod-*"], count: 2 }, { targets: ["dev"], count: 5 }] } };
    const h = harness(atBase);
    const gates = memoryGateLedgerPort({ resolutions: [approval("alice", "2026-10-22T01:00:00Z")] });
    const logs: string[] = [];
    // The change drops the rule; the one at base holds.
    const one = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates, now: "2026-10-22T02:00:00Z", log: (l) => logs.push(l) });
    expect(one.exitCode).toBe(3);
    expect(one.decision?.quorum).toEqual([{ targets: ["prod-*"], count: 2 }]);
    expect(one.decision?.quorumProgress?.[0]).toMatchObject({ approvers: ["alice"], met: false });
    expect(logs.some((l) => /the ones at base hold/.test(l))).toBe(true);
    // Approvals made while the wave waits count, each person once.
    const two = memoryGateLedgerPort({ resolutions: [approval("alice", "2026-10-22T02:30:00Z"), approval("alice", "2026-10-22T02:45:00Z"), approval("bob", "2026-10-22T03:00:00Z")], pending: gates.appended });
    const done = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: two, now: "2026-10-22T04:00:00Z" });
    expect(done.exitCode).toBe(0);
    expect(done.decision?.approvedBy).toBe("alice, bob");
    expect(h.applies()).toBe(2);
    h.done();
  });

  test("a claimed role never counts; a role from trust.json at base counts for a reviewer of the merged pull request", async () => {
    const atBase: OpWavesSpec = { ...spec, waves: [{ ...spec.waves[0]!, approval: "pr-review" }], approvals: { quorum: [{ count: 1, roles: ["platform"], notAuthor: true }] } };
    const h = harness(atBase);
    const claimed = memoryGateLedgerPort({ resolutions: [{ ...approval("github:carol", "2026-10-22T01:00:00Z"), approver: { kind: "human", roles: ["platform"] } }] });
    const merged: MergedReview = { pr: 7, head: "h".repeat(40), author: "github:dana", approvers: ["github:alice"], refused: [] };
    const headPlans = async () => ({ version: 1 as const, name: "migrations", head: merged.head, timestamp: "2026-10-22T00:00:00Z", waves: [{ wave: 1, name: "prod", digest: set }] });
    const base = { spec: atBase, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, head: "m".repeat(40), headPlans, now: "2026-10-22T02:00:00Z" };
    // carol claims the role and is not proven; nobody reviewed.
    const waiting = await runOpWave({ ...base, gates: claimed, reviews: reviews({ ...merged, approvers: [] }), trust: trust({ platform: ["github:alice", "github:carol"] }) });
    expect(waiting.exitCode).toBe(3);
    // alice reviewed and holds the role at base; dana wrote the change.
    const gates = memoryGateLedgerPort();
    const passed = await runOpWave({ ...base, gates, reviews: reviews(merged), trust: trust({ platform: ["github:alice"] }) });
    expect(passed.exitCode).toBe(0);
    expect(passed.decision).toMatchObject({ via: "pr-review", approvedBy: "github:alice" });
    expect(gates.resolved.map((r) => r.resolvedBy)).toEqual(["github:alice"]);
    // The author reviewing their own change never meets notAuthor.
    const own = await runOpWave({ ...base, gates: memoryGateLedgerPort(), reviews: reviews({ ...merged, author: "github:alice" }), trust: trust({ platform: ["github:alice"] }) });
    expect(own.exitCode).toBe(3);
    h.done();
  });

  test("rules at base that cannot be read fail the wave", async () => {
    const h = harness({ ...spec, approvals: { quorum: [{ count: 0 }] } });
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(result.exitCode).toBe(1);
    expect(h.applies()).toBe(0);
    h.done();
  });
});
