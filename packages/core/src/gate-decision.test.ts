/**
 * #3763: `@intentius/chant/gate-decision` decides a plan-bound gate as chant's
 * own wave gate does. Each ledger is decided both ways, by
 * {@link decideGateApproval} and by `evaluateGate` with the port `chant run
 * wave` builds, and the seal rule is read at a real base commit.
 */

import { describe, expect, test, afterEach } from "vitest";
import {
  baseCommit,
  decideGateApproval,
  gateSealPayload,
  gateSignersAt,
  identityGatesAt,
  reviewApproval,
  appliedGateApplies,
  parseAppliedGateLines,
  GATE_SEAL_NAMESPACE,
  type AppliedGateRecord,
  type GateApprovalInput,
  type GateResolutionRecord,
  type MergedReview,
  type PendingGateRecord,
} from "./gate-decision";
import { evaluateGate, memoryGateLedgerPort, type GateLedgerPort } from "./op/gate";
import { sealedApprovalRule, trustPolicyAt } from "./op/gate-review";
import { hasSshKeygen, TestRepo } from "./workspace/trust/test-repo";
import { deriveGateAudit } from "./lifecycle/gate-audit";

const GATE = "migrations-wave-1";
const D1 = "jcs1-sha256:1111";
const D2 = "jcs1-sha256:2222";
const NOW = "2026-10-11T12:00:00.000Z";

const pending = (timestamp: string, planDigest = D1, extra: Partial<PendingGateRecord> = {}): PendingGateRecord => ({
  version: 1, kind: "pending", op: "migrations", gate: GATE, timestamp, expiresAt: "2026-10-13T00:00:00.000Z", planDigest, ...extra,
});
const approved = (timestamp: string, planDigest: string | undefined = D1, extra: Partial<GateResolutionRecord> = {}): GateResolutionRecord => ({
  version: 1, op: "migrations", gate: GATE, resolvedBy: "alice", timestamp, ...(planDigest ? { planDigest } : {}), ...extra,
});

/** evaluateGate's answer, reduced to what decideGateApproval also says. */
async function evaluated(port: GateLedgerPort, input: { planDigest: string; environment?: string }) {
  const check = await evaluateGate(port, { op: "migrations", gate: GATE, now: NOW, ...input });
  return check.satisfied
    ? { status: "approved", by: check.resolution.resolvedBy, at: check.resolution.timestamp }
    : { status: "waiting", mismatched: check.mismatch?.resolvedBy ?? null, recorded: check.recorded };
}

function decided(input: GateApprovalInput) {
  const d = decideGateApproval({ now: NOW, ...input });
  return d.status === "approved"
    ? { status: "approved", by: d.via === "ledger" ? d.resolution.resolvedBy : d.review.approvers?.[0], at: d.via === "ledger" ? d.resolution.timestamp : undefined }
    : { status: "waiting", mismatched: d.mismatched?.resolvedBy ?? null, recorded: d.standing === undefined };
}

describe("under ledger, the decision is evaluateGate's", () => {
  const ledgers: Array<[string, { resolutions: GateResolutionRecord[]; pending: PendingGateRecord[] }, { planDigest: string; environment?: string }]> = [
    ["an approval of this digest after the pending fact", { pending: [pending("2026-10-11T10:00:00.000Z")], resolutions: [approved("2026-10-11T11:00:00.000Z")] }, { planDigest: D1 }],
    ["an approval from before the gate last asked", { pending: [pending("2026-10-11T10:00:00.000Z")], resolutions: [approved("2026-10-11T09:00:00.000Z")] }, { planDigest: D1 }],
    ["an approval of another digest", { pending: [pending("2026-10-11T10:00:00.000Z", D2)], resolutions: [approved("2026-10-11T11:00:00.000Z")] }, { planDigest: D2 }],
    ["an approval that names no plan", { pending: [], resolutions: [approved("2026-10-11T11:00:00.000Z", undefined)] }, { planDigest: D1 }],
    ["the newest of several", { pending: [], resolutions: [approved("2026-10-11T08:00:00.000Z"), approved("2026-10-11T11:00:00.000Z", D1, { resolvedBy: "bob" }), approved("2026-10-11T11:30:00.000Z", D2)] }, { planDigest: D1 }],
    ["a standing pending fact for this digest", { pending: [pending("2026-10-11T10:00:00.000Z")], resolutions: [] }, { planDigest: D1 }],
    ["an expired pending fact", { pending: [{ ...pending("2026-10-08T10:00:00.000Z"), expiresAt: "2026-10-09T00:00:00.000Z" }], resolutions: [] }, { planDigest: D1 }],
    ["another environment's approval", { pending: [], resolutions: [approved("2026-10-11T11:00:00.000Z", D1, { environment: "staging" })] }, { planDigest: D1, environment: "prod" }],
    ["this environment's approval", { pending: [pending("2026-10-11T10:00:00.000Z", D1, { environment: "staging" })], resolutions: [approved("2026-10-11T09:00:00.000Z", D1, { environment: "prod" })] }, { planDigest: D1, environment: "prod" }],
  ];

  test.each(ledgers)("%s", async (_name, ledger, input) => {
    expect(decided({ ledger, gate: GATE, ...input })).toEqual(await evaluated(memoryGateLedgerPort(ledger), input));
  });
});

describe("pr-review", () => {
  const merged = (over: Partial<MergedReview> = {}): MergedReview => ({ pr: 7, head: "c".repeat(40), author: "github:carol", approvers: ["github:bob"], refused: [], ...over });

  test("a writer's review of a head that planned this digest approves it", () => {
    expect(reviewApproval(merged(), D1, D1)).toEqual({ approved: true, review: { pr: 7, head: "c".repeat(40), approvers: ["github:bob"] } });
  });

  test("a review approves nothing when nobody counted, no plans were recorded, or the plan moved", () => {
    expect(reviewApproval(merged({ approvers: [], refused: ["github:carol is the author, whose own review never counts"] }), D1, D1).review.reason).toBe(
      "no writer other than its author approved the head of #7: github:carol is the author, whose own review never counts",
    );
    expect(reviewApproval(merged(), undefined, D1).review.reason).toMatch(/no plans are recorded for the head cccccccccccc of #7/);
    expect(reviewApproval(merged(), D2, D1).review.reason).toBe(`the plan moved after the review: the head planned ${D2}, and the merge plans ${D1}`);
  });

  test("the ledger is read first, and the review only when no approval counts", () => {
    const ledger = { pending: [], resolutions: [approved("2026-10-11T11:00:00.000Z")] };
    const review = reviewApproval(merged(), D1, D1);
    expect(decideGateApproval({ ledger, gate: GATE, planDigest: D1, mode: "pr-review", review, now: NOW })).toMatchObject({ status: "approved", via: "ledger" });
    expect(decideGateApproval({ ledger: { pending: [], resolutions: [] }, gate: GATE, planDigest: D1, mode: "pr-review", review, now: NOW })).toMatchObject({ status: "approved", via: "pr-review" });
    const moved = reviewApproval(merged(), D2, D1);
    expect(decideGateApproval({ ledger: { pending: [], resolutions: [] }, gate: GATE, planDigest: D1, mode: "pr-review", review: moved, now: NOW })).toMatchObject({ status: "waiting", review: { reason: expect.stringMatching(/plan moved/) } });
    // Under ledger, a review is not consulted.
    expect(decideGateApproval({ ledger: { pending: [], resolutions: [] }, gate: GATE, planDigest: D1, mode: "ledger", review, now: NOW }).status).toBe("waiting");
  });
});

describe("spent approvals (#3784)", () => {
  const appliedUnder = (r: GateResolutionRecord, timestamp = "2026-10-11T11:30:00.000Z", extra: Partial<AppliedGateRecord> = {}): AppliedGateRecord => ({
    version: 1, kind: "applied", op: "migrations", gate: GATE, planDigest: r.planDigest!, approvedAt: r.timestamp, approvedBy: r.resolvedBy, timestamp, ...extra,
  });
  const a1 = approved("2026-10-11T11:00:00.000Z");

  test("with spend, an approval a wave applied under does not pass the same digest twice", () => {
    const ledger = { pending: [pending("2026-10-11T10:00:00.000Z")], resolutions: [a1], applied: [appliedUnder(a1)] };
    expect(decideGateApproval({ ledger, gate: GATE, planDigest: D1, now: NOW })).toMatchObject({ status: "approved" });
    expect(decideGateApproval({ ledger, gate: GATE, planDigest: D1, spend: true, now: NOW })).toMatchObject({ status: "waiting", spent: a1, standing: { planDigest: D1 } });
    // A newer approval of the digest is not spent by the older apply.
    const again = approved("2026-10-11T11:45:00.000Z", D1, { resolvedBy: "bob" });
    expect(decideGateApproval({ ledger: { ...ledger, resolutions: [a1, again] }, gate: GATE, planDigest: D1, spend: true, now: NOW })).toMatchObject({ status: "approved", resolution: { resolvedBy: "bob" } });
  });

  test("a spent approval of another digest stands as no mismatch, as in terragucci's decideGate", () => {
    const a2 = approved("2026-10-11T11:00:00.000Z", D2);
    const ledger = { pending: [], resolutions: [a2], applied: [appliedUnder(a2)] };
    expect(decideGateApproval({ ledger, gate: GATE, planDigest: D1, now: NOW })).toMatchObject({ status: "waiting", mismatched: a2 });
    const d = decideGateApproval({ ledger, gate: GATE, planDigest: D1, spend: true, now: NOW });
    expect(d).toMatchObject({ status: "waiting", spent: a2 });
    expect(d).not.toHaveProperty("mismatched");
  });

  test("decideGateApproval and evaluateGate spend the same approvals", async () => {
    const ledger = { pending: [], resolutions: [a1] };
    const spent = [appliedUnder(a1)];
    expect(decided({ ledger: { ...ledger, applied: spent }, gate: GATE, planDigest: D1, spend: true })).toEqual(
      await evaluatedSpending(memoryGateLedgerPort(ledger), { planDigest: D1, spent }),
    );
  });

  test("a pull request review a wave applied this digest under is spent", () => {
    const head = "c".repeat(40);
    const review = reviewApproval({ pr: 7, head, author: "github:carol", approvers: ["github:bob"], refused: [] }, D1, D1);
    const recorded = approved("2026-10-11T11:00:00.000Z", D1, { resolvedBy: "github:bob", review: { pr: 7, head, approvers: ["github:bob"] } });
    const ledger = { pending: [], resolutions: [recorded], applied: [appliedUnder(recorded, undefined, { review: { pr: 7, head } })] };
    const d = decideGateApproval({ ledger, gate: GATE, planDigest: D1, mode: "pr-review", review, spend: true, now: NOW });
    expect(d).toMatchObject({ status: "waiting", review: { reason: expect.stringMatching(/review is spent/) } });
  });

  test("the applied lines parse, and gate-audit reads them as applies under their approval", () => {
    const line = appliedUnder(a1);
    const text = `${JSON.stringify(line)}\nnot json\n${JSON.stringify({ ...line, kind: "finished" })}\n`;
    expect(parseAppliedGateLines(text)).toEqual([line]);
    const audit = deriveGateAudit({
      ledgers: [{ op: "migrations", lines: [{ record: pending("2026-10-11T10:00:00.000Z") }, { record: a1 }] }],
      applies: appliedGateApplies(parseAppliedGateLines(text)),
    });
    const approvedEntry = audit.entries.find((e) => e.kind === "approved")!;
    expect(audit.entries.find((e) => e.kind === "applied")).toMatchObject({ gate: GATE, digest: D1, under: approvedEntry.id, detail: { approvedAt: a1.timestamp, approvedBy: "alice" } });
    expect(audit.gaps).toEqual([]);
  });
});

async function evaluatedSpending(port: GateLedgerPort, input: { planDigest: string; spent: AppliedGateRecord[] }) {
  const check = await evaluateGate(port, { op: "migrations", gate: GATE, now: NOW, ...input });
  return check.satisfied
    ? { status: "approved", by: check.resolution.resolvedBy, at: check.resolution.timestamp }
    : { status: "waiting", mismatched: check.mismatch?.resolvedBy ?? null, recorded: check.recorded };
}

describe.skipIf(!hasSshKeygen)("sealed, read at base", () => {
  const repos: TestRepo[] = [];
  afterEach(() => {
    while (repos.length) repos.pop()!.cleanup();
  });

  function setup(files: Record<string, string>) {
    const r = new TestRepo("3763-sealed");
    repos.push(r);
    const alice = r.key("alice");
    const mallory = r.key("mallory");
    for (const [path, text] of Object.entries(files)) r.write(path, text.replace("<alice>", alice.pub));
    const base = r.commit("base");
    // The change being applied adds mallory, who must not count.
    r.write(".chant/allowed_signers", `alice ${alice.pub}\nmallory ${mallory.pub}\n`);
    r.commit("adds mallory");
    const seal = (a: GateResolutionRecord, key = alice, signer = a.resolvedBy) => ({ ...a, seal: { signer, key: "k", signature: r.sshSign(key, gateSealPayload(a), GATE_SEAL_NAMESPACE) } });
    return { r, base, alice, mallory, seal };
  }

  test("only a seal by a signer at base counts, as it does for chant run wave", async () => {
    const { r, base, mallory, seal } = setup({ ".chant/allowed_signers": "alice <alice>\n" });
    expect(baseCommit(r.dir)).toBe(base);
    const signers = gateSignersAt(r.dir, base);
    expect(signers).toMatchObject({ base, active: true, signersPath: ".chant/allowed_signers" });
    expect(signers.signers.map((s) => s.principal)).toEqual(["alice"]);

    const rule = sealedApprovalRule(GATE, trustPolicyAt(r.dir, base));
    const chantWave = (ledger: { resolutions: GateResolutionRecord[]; pending: PendingGateRecord[] }): GateLedgerPort => ({
      ...memoryGateLedgerPort(ledger),
      approvalRule: async (g) => (g === GATE ? rule : null),
    });

    const unsigned = approved("2026-10-11T11:00:00.000Z");
    const byMallory = seal(approved("2026-10-11T11:10:00.000Z", D1, { resolvedBy: "mallory" }), mallory);
    const byAlice = seal(approved("2026-10-11T11:20:00.000Z"));
    const ledgers = [[unsigned], [unsigned, byMallory], [unsigned, byMallory, byAlice], [{ ...byAlice, planDigest: D2 }]];
    for (const resolutions of ledgers) {
      const ledger = { pending: [], resolutions };
      expect(decided({ ledger, gate: GATE, planDigest: D1, mode: "sealed", signers })).toEqual(await evaluated(chantWave(ledger), { planDigest: D1 }));
    }

    const waiting = decideGateApproval({ ledger: { pending: [], resolutions: [unsigned, byMallory] }, gate: GATE, planDigest: D1, mode: "sealed", signers, now: NOW });
    expect(waiting.status === "waiting" && waiting.uncounted.map((u) => u.reason)).toEqual([
      `the approval of gate ${GATE} by alice carries no seal`,
      "mallory has no key in .chant/allowed_signers at base, so the seal can't count",
    ]);
    // With no signers handed in, a sealed gate passes nothing.
    expect(decideGateApproval({ ledger: { pending: [], resolutions: [byAlice] }, gate: GATE, planDigest: D1, mode: "sealed", now: NOW }).status).toBe("waiting");
  });

  test("the signers path trust.json names, and a trust.json chant would refuse", () => {
    const named = setup({ ".chant/trust.json": JSON.stringify({ schema: 1, signers: "ops/signers" }), "ops/signers": "alice <alice>\n" });
    expect(gateSignersAt(named.r.dir, named.base)).toMatchObject({ active: true, signersPath: "ops/signers" });
    expect(trustPolicyAt(named.r.dir, named.base)).toMatchObject({ active: true, signersPath: "ops/signers" });

    const invalid = setup({ ".chant/trust.json": JSON.stringify({ schema: 1, roles: { Admin: ["alice"] } }), ".chant/allowed_signers": "alice <alice>\n" });
    expect(gateSignersAt(invalid.r.dir, invalid.base)).toMatchObject({ active: false, problems: [expect.stringMatching(/trust\.json is invalid: roles/)] });
    expect(trustPolicyAt(invalid.r.dir, invalid.base).active).toBe(false);

    const none = setup({ "README.md": "x\n" });
    expect(gateSignersAt(none.r.dir, none.base)).toMatchObject({ active: false, signers: [] });
  });

  test("identity.gates at base", () => {
    const { r, base } = setup({
      "chant.workspace.json": JSON.stringify({ identity: { gates: { [GATE]: {}, deploy: { class: "human" } } } }),
      ".chant/allowed_signers": "alice <alice>\n",
    });
    expect(identityGatesAt(r.dir, base)).toEqual([{ gate: GATE, class: null }, { gate: "deploy", class: "human" }]);
    const empty = setup({ "README.md": "x\n" });
    expect(identityGatesAt(empty.r.dir, empty.base)).toEqual([]);
  });
});
