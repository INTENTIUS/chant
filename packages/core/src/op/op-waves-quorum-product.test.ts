import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort, type GateLedgerPort } from "./gate";
import { changeInvolvement, recordedReviewApprovals, requestedByTrailers, trustQuorumJudge } from "./gate-quorum";
import { waveSetDigest } from "../gated-waves";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { TrustPolicy } from "../workspace/trust/policy";
import type { MergedReview, ReviewSource } from "./gate-review";

// A review a product records itself (terragucci's `tf-apply` ledger under
// `pr-review`), and everyone involved in a change (#4333), as terragucci's
// ruleApprovers (apply.ts) and Involved (involved.ts) judge them.

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const spec: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [{ name: "prod", approval: "pr-review", runs: [{ target: "prod-eu" }] }],
};
const set = waveSetDigest([{ member: "prod-eu", planDigest: digest("e") }]);
const atBase: OpWavesSpec = {
  ...spec,
  approvals: {
    quorum: [{ count: 2, roles: ["platform"], notAuthor: true }],
    reviewLedger: "tf-apply",
    involved: { agents: ["tg-bot"], exclude: true },
  },
};
const headSha = "r".repeat(40);

function harness(base: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-product-"));
  const exec: OpWaveExec = (argv, dir) => {
    if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: digest("e") }));
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(base) });
  return { cwd, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

const trust = (): TrustPolicy =>
  ({
    base: "b".repeat(40), signersPath: ".chant/allowed_signers", active: false, signers: [], excluded: [],
    roles: { platform: ["github:alice", "github:bob", "github:carol", "github:dana", "github:tg-bot"] },
    adopted: [], runners: [], excludedRunners: [], admitted: {}, problems: [],
  }) as TrustPolicy;

/** A port whose `read(op)` returns that op's lines, as the lifecycle branch's `_gates/<op>.jsonl` does. */
function ledgerPort(lines: GateResolutionRecord[]): GateLedgerPort & { resolved: GateResolutionRecord[] } {
  const inner = memoryGateLedgerPort({ resolutions: lines });
  return { ...inner, resolved: inner.resolved, async read(op) { const r = await inner.read(op); return { ...r, resolutions: r.resolutions.filter((x) => x.op === op) }; } };
}

/** What terragucci writes under `pr-review`: one line, every reviewer, none of them `resolvedBy` on their own. */
const productReview = (reviewers: string[], at: string, o: Partial<Record<string, unknown>> = {}): GateResolutionRecord =>
  ({ version: 1, kind: "resolution", op: "tf-apply", gate: "migrations-wave-1", resolvedBy: reviewers.join(","), timestamp: at, planDigest: set, via: "pr-review", pr: 7, head: headSha, reviewers, ...o }) as unknown as GateResolutionRecord;

const merged: MergedReview = { pr: 7, head: headSha, author: "github:dana", approvers: [], refused: [] };
const reviews: ReviewSource = { kind: "github", mergedReview: async () => merged };
const requestedByBob = () => [{ sha: "abc1234def", message: "feat: widen the pool\n\nRequested-by: bob" }];

const run = (h: ReturnType<typeof harness>, gates: GateLedgerPort, o: Partial<Parameters<typeof runOpWave>[0]> = {}) =>
  runOpWave({ spec: atBase, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates, head: "m".repeat(40), reviews, trust: trust, commits: requestedByBob, now: "2026-10-22T02:00:00Z", ...o });

describe("a review a product records, and everyone involved in a change (#4333)", () => {
  test("the spec checks approvals.reviewLedger and approvals.involved", () => {
    expect(() => assertOpWavesSpec(atBase)).not.toThrow();
    expect(() => assertOpWavesSpec({ ...spec, approvals: { reviewLedger: "../x" } })).toThrow(/reviewLedger must name an op/);
    expect(() => assertOpWavesSpec({ ...spec, approvals: { involved: { agents: [] } } })).toThrow(/involved.agents/);
    expect(() => assertOpWavesSpec({ ...spec, approvals: { involved: { exclude: "yes" } } } as unknown as OpWavesSpec)).toThrow(/involved.exclude/);
  });

  test("Requested-by trailers and an agent's account are involved, as terragucci's Involved reads them", () => {
    expect(requestedByTrailers("fix\n\nRequested-by: bob\nrequested-by: Bob\nRequested-by: not a login!")).toEqual(["bob"]);
    const principal = (l: string) => `github:${l}`;
    const inv = changeInvolvement({ author: "github:dana", commits: requestedByBob(), agents: ["github:tg-bot"], principal });
    expect(inv).toEqual([
      { who: "github:dana", why: "github:dana opened the change" },
      { who: "github:bob", why: "bob asked for abc1234" },
      { who: "github:tg-bot", why: "github:tg-bot is an account an agent acts as" },
    ]);
  });

  test("the judge proves a reviewer from a recorded review, and leaves out the involved, as ruleApprovers does", () => {
    const principal = (l: string) => `github:${l}`;
    const read = recordedReviewApprovals([productReview(["alice", "bob", "tg-bot"], "2026-10-22T01:00:00Z")], principal);
    expect(read.records.map((r) => r.resolvedBy)).toEqual(["github:alice", "github:bob", "github:tg-bot"]);
    const judge = trustQuorumJudge({
      signers: trust(),
      roles: trust().roles,
      authors: ["github:dana"],
      involved: changeInvolvement({ commits: requestedByBob(), agents: ["github:tg-bot"], principal }),
      excludeInvolved: true,
      recorded: read.reviews,
    });
    const j = (who: string) => judge(read.records.find((r) => r.resolvedBy === who)!);
    expect(j("github:alice")).toEqual({ proven: true, roles: ["platform"], author: false });
    expect(j("github:bob")).toMatchObject({ proven: true, author: true, excluded: "bob asked for abc1234, so github:bob's approval does not count" });
    expect(j("github:tg-bot").excluded).toMatch(/account an agent acts as/);
    // Without a recorded review the same approval proves nobody.
    const none = trustQuorumJudge({ signers: trust(), roles: trust().roles });
    expect(none(read.records[0]!)).toEqual({ proven: false, roles: [] });
  });

  test("a wave counts each reviewer of a recorded review, leaves out the requester and the agent, and passes on a second", async () => {
    const h = harness(atBase);
    const logs: string[] = [];
    // alice reviewed with bob (who asked for the change) and the agent's account: only alice counts.
    const gates = ledgerPort([productReview(["alice", "bob", "tg-bot"], "2026-10-22T01:00:00Z")]);
    const one = await run(h, gates, { log: (l) => logs.push(l) });
    expect(one.exitCode).toBe(3);
    expect(one.decision?.quorumProgress?.[0]).toMatchObject({ approvers: ["github:alice"], met: false });
    expect(logs.some((l) => /bob asked for abc1234, so github:bob's approval does not count/.test(l))).toBe(true);
    expect(logs.some((l) => /github:tg-bot is an account an agent acts as/.test(l))).toBe(true);
    // carol reviews later, in a second line: two distinct, proven, uninvolved approvers.
    const two = ledgerPort([productReview(["alice", "bob", "tg-bot"], "2026-10-22T01:00:00Z"), productReview(["carol"], "2026-10-22T01:30:00Z")]);
    const done = await run(h, two);
    expect(done.exitCode).toBe(0);
    expect(done.decision?.approvedBy).toBe("github:alice, github:carol");
    h.done();
  });

  test("the pull request's author never counts, though a recorded review names them", async () => {
    const h = harness(atBase);
    const gates = ledgerPort([productReview(["dana", "alice"], "2026-10-22T01:00:00Z")]);
    const r = await run(h, gates);
    expect(r.exitCode).toBe(3);
    expect(r.decision?.quorumProgress?.[0]?.approvers).toEqual(["github:alice"]);
    h.done();
  });

  test("the ledger and the exclusion are read at base: a change that names its own ledger or agents gains nothing", async () => {
    // Base sets a quorum and nothing else; the change adds reviewLedger and drops involved.
    const baseOnly: OpWavesSpec = { ...spec, approvals: { quorum: [{ count: 1, roles: ["platform"] }] } };
    const h = harness(baseOnly);
    const gates = ledgerPort([productReview(["alice"], "2026-10-22T01:00:00Z")]);
    const r = await run(h, gates, { spec: { ...baseOnly, approvals: { quorum: [{ count: 1 }], reviewLedger: "tf-apply" } } });
    expect(r.exitCode).toBe(3);
    expect(r.decision?.reviewLedger).toBeUndefined();
    expect(gates.resolved).toEqual([]);
    h.done();
  });

  test("a review of another digest, or a ledger line with no reviewers, proves nobody", async () => {
    const h = harness(atBase);
    const gates = ledgerPort([productReview(["alice", "carol"], "2026-10-22T01:00:00Z", { planDigest: digest("0") }), productReview([], "2026-10-22T01:10:00Z")]);
    const r = await run(h, gates);
    expect(r.exitCode).toBe(3);
    expect(r.decision?.quorumProgress?.[0]?.approvers).toEqual([]);
    h.done();
  });
});
