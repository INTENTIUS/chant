/**
 * The pieces of terragucci's gate that move onto chant's (terragucci issue
 * 1303): `approvals.involved` and `approvals.reviewLedger` on a wave that no
 * `approvals.quorum` rule covers, and the after-plan wave answer's
 * `approvals`, which chant records at the gate before it decides it (a
 * covered round, the rest of a stopped apply, a review the product read).
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort, type GateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { TrustPolicy } from "../workspace/trust/policy";
import type { MergedReview, ReviewSource } from "./gate-review";
import { opWaveAfterPlanWaveResultProblems, type OpWaveAfterPlanHook, type OpWaveAnswerApproval } from "./op-waves-after-plan";

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const NOW = "2026-11-08T00:00:00.000Z";

const part = (member: string): ChangeSetPart => ({
  member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("9"), holes: [] },
  entries: [{ member, address: `aws_s3_bucket.${member}`, type: "aws_s3_bucket", action: "create" } as ChangeSetPart["entries"][number]],
});

const registry = (): { registry: CapabilityRegistry; ran: string[] } => {
  const ran: string[] = [];
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(_ctx, input) {
      const root = String(input.root);
      return { member: root, planDigest: digest(root === "network" ? "1" : "2"), artifact: { planFile: `${root}.tfplan` }, changeSet: part(root) };
    },
    async run(_ctx, input) {
      ran.push(String(input.root));
      return {};
    },
  };
  return { registry: new CapabilityRegistry().register(cap), ran };
};

/** terragucci's spec on the step: `tf-apply`, gate `wave-1`, no approval rules. */
const spec = (approvals: OpWavesSpec["approvals"], approval: "ledger" | "pr-review" = "ledger"): OpWavesSpec =>
  ({
    name: "tf-apply",
    op: "tf-apply",
    gateName: "wave-{k}",
    step: { kind: "fake-apply", root: "{target}" },
    ...(approvals ? { approvals } : {}),
    waves: [{ name: "wave-1", runs: [{ target: "network" }, { target: "app" }], gate: "always", approval }],
  }) as OpWavesSpec;

const trust = (): TrustPolicy =>
  ({ base: "b".repeat(40), signersPath: ".chant/allowed_signers", active: false, signers: [], excluded: [], roles: {}, adopted: [], runners: [], excludedRunners: [], admitted: {}, problems: [] }) as TrustPolicy;

const merged: MergedReview = { pr: 7, head: "r".repeat(40), author: "github:dana", approvers: [], refused: [] };
const reviews: ReviewSource = { kind: "github", mergedReview: async () => merged };

function harness(s: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-gate-port-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(s) });
  return { cwd, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** A memory port whose `read(op)` returns that op's lines only, as the lifecycle branch's `_gates/<op>.jsonl` does. */
function ledger(): GateLedgerPort {
  const inner = memoryGateLedgerPort();
  return { ...inner, async read(op) { const r = await inner.read(op); return { ...r, resolutions: r.resolutions.filter((x) => x.op === op), pending: r.pending.filter((x) => x.op === op) }; } };
}

const run = (h: ReturnType<typeof harness>, s: OpWavesSpec, gates: GateLedgerPort, o: Partial<Parameters<typeof runOpWave>[0]> = {}) => {
  const { registry: capabilities, ran } = registry();
  const logs: string[] = [];
  return runOpWave({
    spec: s, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates, capabilities, now: NOW, head: "m".repeat(40), reviews, trust, commits: () => [], log: (l) => logs.push(l), ...o,
  }).then((result) => ({ result, ran, logs }));
};

const approve = (gates: GateLedgerPort, by: string, planDigest: string, extra: Partial<GateResolutionRecord> = {}) =>
  gates.appendResolution!({ op: "tf-apply", gate: "wave-1", resolvedBy: by, timestamp: "2026-11-08T01:00:00.000Z", planDigest, approver: { kind: "human" }, ...extra } as never);

describe("approvals.involved and approvals.reviewLedger without approval rules (terragucci issue 1303)", () => {
  test("an approval by the agent's account does not count, and one by someone else does", async () => {
    const s = spec({ involved: { agents: ["tg-bot"], exclude: true } });
    const h = harness(s);
    const gates = ledger();
    const waiting = await run(h, s, gates);
    expect(waiting.result.exitCode).toBe(3);
    const set = waiting.result.decision!.digest;
    await approve(gates, "github:tg-bot", set);
    const agent = await run(h, s, gates);
    expect(agent.result.exitCode).toBe(3);
    expect(agent.ran).toEqual([]);
    expect(agent.logs.some((l) => /github:tg-bot is an account an agent acts as, so github:tg-bot's approval does not count/.test(l))).toBe(true);
    // The decision record names who counts as involved, and claims no approval rules.
    expect(agent.result.decision?.involved).toEqual({ agents: ["tg-bot"], exclude: true });
    expect(agent.result.decision?.quorum).toBeUndefined();
    expect(agent.result.decision?.quorumProgress).toBeUndefined();
    await approve(gates, "github:alice", set, { timestamp: "2026-11-08T02:00:00.000Z" });
    const alice = await run(h, s, gates);
    expect(alice.result.exitCode).toBe(0);
    expect(alice.result.decision?.approvedBy).toBe("github:alice");
    expect(alice.ran).toEqual(["network", "app"]);
    h.done();
  });

  test("the pull request's author's approval does not count", async () => {
    const s = spec({ involved: { exclude: true } });
    const h = harness(s);
    const gates = ledger();
    const set = (await run(h, s, gates)).result.decision!.digest;
    await approve(gates, "github:dana", set);
    const r = await run(h, s, gates);
    expect(r.result.exitCode).toBe(3);
    expect(r.logs.some((l) => /github:dana wrote the change, so github:dana.s approval does not count/.test(l))).toBe(true);
    h.done();
  });

  test("under pr-review, a review the product recorded on its review ledger approves the wave", async () => {
    const s = spec({ reviewLedger: "tf-reviews", involved: { agents: ["tg-bot"], exclude: true } }, "pr-review");
    const h = harness(s);
    const gates = ledger();
    const set = (await run(h, s, gates)).result.decision!.digest;
    await gates.appendResolution!({ op: "tf-reviews", gate: "wave-1", resolvedBy: "alice,tg-bot", timestamp: "2026-11-08T01:00:00.000Z", planDigest: set, via: "pr-review", pr: 7, head: "r".repeat(40), reviewers: ["alice", "tg-bot"] } as never);
    const r = await run(h, s, gates);
    expect(r.result.exitCode).toBe(0);
    expect(r.result.decision?.approvedBy).toBe("github:alice");
    h.done();
  });

  test("a spec at base with neither waits for any approval as before, and an agent's approval counts", async () => {
    const s = spec(undefined);
    const h = harness(s);
    const gates = ledger();
    const set = (await run(h, s, gates)).result.decision!.digest;
    await approve(gates, "github:tg-bot", set);
    const r = await run(h, s, gates);
    expect(r.result.exitCode).toBe(0);
    expect(r.result.decision?.approvedBy).toBe("github:tg-bot");
    expect(r.result.decision?.involved).toBeUndefined();
    h.done();
  });
});

describe("approvals a product settled before the gate, in the wave answer (terragucci issue 1303)", () => {
  const covered: OpWaveAnswerApproval = { resolvedBy: "github:alice", note: "covered by the approval of sha256:aaaa by github:alice: only network.vpc_id differs" };
  const hook = (approvals: OpWaveAnswerApproval[]): OpWaveAfterPlanHook => ({ name: "terragucci", run: () => {}, wave: () => ({ approvals }) });

  test("chant records each at the gate for the digest it decides, and the wave applies under it", async () => {
    const s = spec(undefined);
    const h = harness(s);
    const gates = ledger();
    const r = await run(h, s, gates, { afterPlan: hook([covered]) });
    expect(r.result.exitCode).toBe(0);
    expect(r.result.decision?.approvedBy).toBe("github:alice");
    const lines = (await gates.read("tf-apply")).resolutions;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ op: "tf-apply", gate: "wave-1", resolvedBy: "github:alice", planDigest: r.result.decision!.digest, note: covered.note, timestamp: NOW });
    expect(r.logs).toContain(`wave 1 (wave-1): github:alice's approval recorded for ${r.result.decision!.digest}: ${covered.note}`);
    h.done();
  });

  test("an approval already recorded for the digest is not written again", async () => {
    const s = spec(undefined);
    const h = harness(s);
    const gates = ledger();
    const set = (await run(h, s, gates)).result.decision!.digest;
    await approve(gates, "github:alice", set, { note: covered.note });
    await run(h, s, gates, { afterPlan: hook([covered]) });
    expect((await gates.read("tf-apply")).resolutions).toHaveLength(1);
    h.done();
  });

  test("an approval the hook gives by someone involved is recorded and still left out", async () => {
    const s = spec({ involved: { agents: ["tg-bot"], exclude: true } });
    const h = harness(s);
    const gates = ledger();
    const r = await run(h, s, gates, { afterPlan: hook([{ resolvedBy: "github:tg-bot", note: "the rest of the apply of sha256:bbbb, which github:tg-bot approved" }]) });
    expect(r.result.exitCode).toBe(3);
    expect((await gates.read("tf-apply")).resolutions.map((x) => x.resolvedBy)).toEqual(["github:tg-bot"]);
    h.done();
  });

  test("a review the hook read is written as the product's review line, which a review ledger counts under pr-review", async () => {
    const s = spec({ reviewLedger: "tf-apply" }, "pr-review");
    const h = harness(s);
    const gates = ledger();
    const review: OpWaveAnswerApproval = { resolvedBy: "alice,carol", note: "approved by the review of pull request 7", url: "https://github.com/acme/infra/pull/7", review: { pr: 7, head: "r".repeat(40), reviewers: ["alice", "carol"] } };
    const r = await run(h, s, gates, { afterPlan: hook([review]) });
    expect(r.result.exitCode).toBe(0);
    expect(r.result.decision?.approvedBy).toBe("github:alice, github:carol");
    const line = (await gates.read("tf-apply")).resolutions.find((x) => x.resolvedBy === "alice,carol");
    expect(line).toMatchObject({ via: "pr-review", pr: 7, head: "r".repeat(40), reviewers: ["alice", "carol"], url: review.url });
    h.done();
  });

  test("a gate that passes without an approval records none", async () => {
    const s = { ...spec(undefined), waves: [{ name: "wave-1", runs: [{ target: "network" }], gate: "never" }] } as OpWavesSpec;
    const h = harness(s);
    const gates = ledger();
    const r = await run(h, s, gates, { afterPlan: hook([covered]) });
    expect(r.result.exitCode).toBe(0);
    expect((await gates.read("tf-apply")).resolutions).toEqual([]);
    h.done();
  });

  test("the answer's approvals are checked", () => {
    expect(opWaveAfterPlanWaveResultProblems({ approvals: [covered] }, [])).toEqual([]);
    expect(opWaveAfterPlanWaveResultProblems({ approvals: "alice" }, [])).toEqual(["`approvals` must be a list of { resolvedBy, note, url?, review? }"]);
    expect(opWaveAfterPlanWaveResultProblems({ approvals: [{ resolvedBy: " ", note: "" }] }, [])).toEqual([
      "approvals[0].resolvedBy must name the approver",
      "approvals[0].note must say why the approval stands for these plans",
    ]);
    expect(opWaveAfterPlanWaveResultProblems({ approvals: [{ ...covered, url: "ftp://x", review: { pr: 0, head: "", reviewers: [] } }] }, [])).toEqual([
      "approvals[0].url must be an http or https URL",
      "approvals[0].review.pr must be the pull request's number",
      "approvals[0].review.head must be the commit the review approved",
      "approvals[0].review.reviewers must list the reviewers",
    ]);
  });

  test("the floor is the next release", async () => {
    const entry = await import("./index");
    const { NEXT_RELEASE } = await import("../release-floors");
    expect(entry.OP_WAVE_ANSWER_APPROVALS_FLOOR).toBe(NEXT_RELEASE);
  });
});
