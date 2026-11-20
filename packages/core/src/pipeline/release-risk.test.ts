/**
 * A release carries its change risk, and a promote gate reads it (#5387):
 * the record bound at the cut, read at each stage gate with `holds.risk`,
 * and the rules every reading keeps: risk only adds approval requirements,
 * a low score passes no gate, nothing reads the score as leave to apply
 * unattended, and a permit that reads it counts only from a person
 * `.chant/trust.json` proves.
 */
import { describe, expect, test } from "vitest";
import { memoryGateLedgerPort, type GateLedgerPort } from "../op/gate";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { GateRejectionRecord } from "../lifecycle/gate-rejection";
import { scoreChangeRisk, type ChangeRisk } from "../change-risk";
import {
  asPipelineSpec,
  laterStageRisk,
  laterStageRiskLines,
  memoryStageLogPort,
  pipelinePromoteGates,
  pipelineSpecProblems,
  pipelineStageEntry,
  releaseRiskOf,
  stageRiskRead,
  RELEASE_RISK_FLOOR,
  type PipelineSpec,
  type ReleaseRisk,
  type WaveRiskLine,
} from "../pipeline";
import { parseCuts } from "../lifecycle/release-store";
import { opWaveRiskLines, type OpWaveReleaseRequest } from "../op/op-waves-release";
import { NEXT_RELEASE } from "../release-floors";
import type { GateQuorumJudge } from "../op/gate-quorum";

const COMMIT = "c".repeat(40);
const DIGEST = "sha256:" + "d".repeat(64);
const now = new Date("2026-11-20T10:00:00Z");

const deletes = (n: number): ChangeRisk =>
  scoreChangeRisk({
    changeSet: {
      members: [{ member: "shop", lexicon: "pulumi" } as never],
      entries: Array.from({ length: n }, (_, i) => ({ member: "shop", address: `r${i}`, type: "t", action: "delete" }) as never),
    },
  });

const line = (risk: ChangeRisk, wave = 1, timestamp = "2026-11-20T09:00:00Z", op = "shop-dev"): WaveRiskLine => ({ version: 1, commit: COMMIT, timestamp, op, wave, name: `w${wave}`, digest: `sha256:w${wave}`, risk });
const record = (risk: ChangeRisk): ReleaseRisk => releaseRiskOf(COMMIT, [line(risk)])!;
const LOW = record(deletes(0));
const HIGH = record(deletes(3));

type Policy = "never" | "always" | "on-destructive";
function shop(prod: { policy?: Policy; risk?: Record<string, unknown>; quorum?: unknown[] } = {}): PipelineSpec {
  return asPipelineSpec({
    name: "shop",
    defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } },
    stages: [
      // The first stage scores each merge, so a release carries a score.
      { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never", holds: { risk: {} } } },
      { name: "staging", waves: [{ name: "staging", runs: [{ target: "staging" }] }], gate: { policy: "never" } },
      {
        name: "prod",
        waves: [{ name: "prod", runs: [{ target: "prod" }] }],
        gate: { policy: prod.policy ?? "always", ...(prod.quorum ? { quorum: prod.quorum } : {}), ...(prod.risk ? { holds: { risk: prod.risk } } : {}) },
      },
    ],
  });
}

const approval = (by: string, extra: Partial<GateResolutionRecord> = {}): GateResolutionRecord =>
  ({ version: 1, op: "shop", gate: "prod", resolvedBy: by, timestamp: "2026-11-20T09:30:00Z", planDigest: DIGEST, environment: "prod", ...extra }) as GateResolutionRecord;

const promote = (spec: PipelineSpec, port: GateLedgerPort, risk?: ReleaseRisk, at: Date = now) => pipelinePromoteGates({ spec, to: "prod", skipped: [], digest: DIGEST, port, now: at, ...(risk ? { risk } : {}) });

describe("the release's record", () => {
  test("combines the newest score of each wave, so a wave only raises it", () => {
    const one = deletes(1);
    const two = deletes(2);
    const got = releaseRiskOf(COMMIT, [line(two, 1, "2026-11-20T08:00:00Z"), line(one, 1, "2026-11-20T09:00:00Z"), line(one, 2), { ...line(two), commit: "e".repeat(40) }])!;
    expect(got.waves.map((w) => [w.wave, w.risk.score])).toEqual([[1, one.score], [2, one.score]]);
    expect(got.score).toBe(Math.round((1 - (1 - one.score) ** 2) * 10_000) / 10_000);
    expect(got.score).toBeGreaterThanOrEqual(one.score);
    expect(releaseRiskOf(COMMIT, [])).toBeUndefined();
  });

  test("rides each wave's release requests once per wave and commit", () => {
    const risk = { op: "shop-dev", wave: 1, name: "dev", digest: "sha256:w1", risk: deletes(1) };
    const req = (target: string, extra: Partial<OpWaveReleaseRequest> = {}): OpWaveReleaseRequest => ({ env: "dev", component: target, target, planDigest: "sha256:p", gitSha: COMMIT, risk, ...extra });
    const lines = opWaveRiskLines([req("a"), req("b"), req("c", { risk: undefined }), req("d", { gitSha: undefined })], "2026-11-20T09:00:00Z");
    expect(lines).toEqual([{ version: 1, commit: COMMIT, timestamp: "2026-11-20T09:00:00Z", ...risk }]);
  });

  test("is bound on the cut line, and a cut whose record does not read is not read at all", () => {
    const cut = { version: 1, releaseDigest: DIGEST, label: "v1", actor: "ci", timestamp: "2026-11-20T09:10:00Z", runId: null, runOrigin: null, signature: null };
    const parsed = parseCuts([JSON.stringify({ ...cut, risk: HIGH }), JSON.stringify({ ...cut, label: "v0" }), JSON.stringify({ ...cut, label: "v2", risk: { version: 1, score: 0 } })].join("\n"));
    expect(parsed.cuts.map((c) => [c.label, c.risk?.score ?? null])).toEqual([["v1", HIGH.score], ["v0", null]]);
    expect(parsed.malformed).toBe(1);
  });

  test("is exported with its floor", () => {
    expect(RELEASE_RISK_FLOOR).toBe(NEXT_RELEASE);
  });
});

describe("a promote gate reads it", () => {
  test("over the stage's threshold, the promote waits and the stage's extra rules are added", async () => {
    const spec = shop({ risk: { approveAbove: 0.5, quorum: [{ count: 2 }] } });
    const port = memoryGateLedgerPort({ resolutions: [approval("alice")] });
    const out = await promote(spec, port, HIGH);
    expect(out).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-gate-waiting", message: expect.stringContaining("so the gate waits for 2 approvals") });
    expect(port.appended[0]?.approval).toMatchObject({ quorum: [{ count: 2 }], mode: "enforce", risk: { approveAbove: 0.5 }, context: { changeRisk: { level: HIGH.level, over: true } } });

    const two = memoryGateLedgerPort({ pending: port.appended, resolutions: [approval("alice", { timestamp: "2026-11-20T10:01:00Z" }), approval("bob", { timestamp: "2026-11-20T10:02:00Z" })] });
    await expect(promote(spec, two, HIGH, new Date("2026-11-20T10:05:00Z"))).resolves.toMatchObject({ passed: true });
  });

  test("a release with no record reads as no score, and the gate is as it was", async () => {
    const spec = shop({ policy: "never", risk: { approveAbove: 0.1, quorum: [{ count: 2 }] } });
    const port = memoryGateLedgerPort();
    const out = await promote(spec, port);
    expect(out).toMatchObject({ passed: true, lines: [expect.stringContaining("carries no change risk"), "stage prod: its gate never waits"] });
    expect(port.appended).toEqual([]);

    // A stage with no holds.risk never reads the record, whatever it holds.
    const plain = memoryGateLedgerPort({ resolutions: [approval("alice")] });
    await expect(promote(shop(), plain, HIGH)).resolves.toEqual({ passed: true, lines: ["stage prod: shop prod approved by alice"] });
  });

  test("the record is read through pipelineStageEntry from the release", async () => {
    const spec = shop({ policy: "never", risk: { approveAbove: 0.5 } });
    const port = memoryGateLedgerPort();
    const out = await pipelineStageEntry({ spec, to: "prod", skipped: [], digest: DIGEST, release: { releaseDigest: DIGEST, commit: COMMIT, risk: HIGH }, port, log: memoryStageLogPort(), now });
    expect(out).toMatchObject({ passed: false, code: "pipeline-gate-waiting" });
  });

  test("a skipped stage's gate reads it too", async () => {
    const spec = asPipelineSpec({ ...shop(), stages: shop().stages.map((s) => (s.name === "staging" ? { ...s, gate: { policy: "never" as const, holds: { risk: { approveAbove: 0.5 } } } } : s)) });
    const port = memoryGateLedgerPort();
    const out = await pipelinePromoteGates({ spec, to: "prod", skipped: [spec.stages[1]!], digest: DIGEST, port, now, risk: HIGH });
    expect(out).toMatchObject({ passed: false, message: expect.stringContaining("staging-skip") });
  });
});

describe("the rules a reading keeps, on the promote path", () => {
  const policies: Policy[] = ["never", "always", "on-destructive"];
  const records = [LOW, record(deletes(1)), HIGH];
  const seeds: GateResolutionRecord[][] = [[], [approval("alice")], [approval("alice"), approval("bob")]];

  test("risk only adds approval requirements: no gate passes with a record that waits without one", async () => {
    for (const policy of policies) {
      for (const risk of records) {
        for (const approveAbove of [0, 0.3, 0.9]) {
          for (const seed of seeds) {
            const spec = shop({ policy, risk: { approveAbove, quorum: [{ count: 2 }] } });
            const without = await promote(spec, memoryGateLedgerPort({ resolutions: seed }));
            const withRisk = await promote(spec, memoryGateLedgerPort({ resolutions: seed }), risk);
            if (withRisk.passed) expect(without.passed, `${policy} ${risk.score} ${approveAbove} ${seed.length}`).toBe(true);
          }
        }
      }
    }
  });

  test("a low score passes no gate: an always gate still waits for its approval", async () => {
    expect(LOW.score).toBe(0);
    const spec = shop({ policy: "always", risk: { approveAbove: 0.5 } });
    const out = await promote(spec, memoryGateLedgerPort(), LOW);
    expect(out).toMatchObject({ passed: false, code: "pipeline-gate-waiting" });
    expect(stageRiskRead(spec, "prod", LOW)?.line).toContain("asks for nothing more, and approves nothing");
  });

  test("allow_unattended never reads the score: the key is refused in a later stage's holds.risk", () => {
    for (const key of ["allow_unattended", "allowUnattended", "approveBelow"]) {
      const problems = pipelineSpecProblems({ ...shop(), stages: shop().stages.map((s) => (s.name === "prod" ? { ...s, gate: { holds: { risk: { approveAbove: 0.5, [key]: true } } } } : s)) });
      expect(problems.join("; ")).toContain(`holds.risk.${key}`);
    }
    // The reading's settings are approveAbove and quorum; the record has no field a gate could read as leave to apply.
    const read = stageRiskRead(shop({ risk: { approveAbove: 0.5 } }), "prod", LOW)!;
    expect(Object.keys(read.settings)).toEqual(["approveAbove"]);
    expect(read.rules).toEqual([]);
  });

  test("a permit that reads the score counts only from a person .chant/trust.json proves", async () => {
    const spec = shop({ risk: { approveAbove: 0.5, quorum: [{ count: 1, proven: true }] } });
    const judged: string[] = [];
    const judge: GateQuorumJudge = (r) => {
      judged.push(r.resolvedBy);
      return { proven: r.resolvedBy === "carol", roles: [] };
    };
    const withJudge = (seed: GateResolutionRecord[]): GateLedgerPort => ({ ...memoryGateLedgerPort({ resolutions: seed }), quorumJudge: async () => judge });
    const permit = { policyDecision: { decision: "allow", mode: "enforce", version: "v1", contextDigest: "x" } } as Partial<GateResolutionRecord>;

    // An agent's approval with a recorded permit, and a person trust.json does not prove: the gate waits.
    const agent = approval("review-bot", { approver: { kind: "agent" }, ...permit } as never);
    await expect(promote(spec, withJudge([agent, approval("mallory")]), HIGH)).resolves.toMatchObject({ passed: false });
    expect(judged).toContain("mallory");
    // A person trust.json proves passes it.
    await expect(promote(spec, withJudge([agent, approval("carol")]), HIGH)).resolves.toMatchObject({ passed: true });
    // Reading the score marks the gate's permit as one that needs a proven person (#5325's rule).
    const port = withJudge([]);
    await promote(spec, port, LOW);
    const { gatePermitReadsRisk } = await import("../op/gate-approval");
    expect(gatePermitReadsRisk((port as ReturnType<typeof memoryGateLedgerPort>).appended[0]!.approval!)).toBe(true);
  });
});

describe("rejections and the urgent path come before any risk reading", () => {
  const rejection = (gate = "prod"): GateRejectionRecord => ({
    version: 1,
    kind: "rejection",
    op: "shop",
    gate,
    rejectedBy: "alice",
    reason: "the migration locks the orders table",
    timestamp: "2026-11-20T09:40:00Z",
    planDigest: DIGEST,
    environment: "prod",
    releaseDigest: DIGEST,
    approver: { kind: "human" },
  });

  test("a rejected release stays rejected whatever its score", async () => {
    for (const policy of ["never", "always"] as const) {
      for (const risk of [LOW, HIGH, undefined]) {
        const spec = shop({ policy, risk: { approveAbove: 0.5 } });
        const port = memoryGateLedgerPort({ rejections: [rejection()], resolutions: [approval("bob", { releaseDigest: DIGEST }), approval("carol", { releaseDigest: DIGEST })] });
        const out = await pipelinePromoteGates({ spec, to: "prod", skipped: [], digest: DIGEST, releaseDigest: DIGEST, port, now, ...(risk ? { risk } : {}) });
        expect(out, `${policy} ${risk?.score}`).toMatchObject({ passed: false, exitCode: 8, code: "pipeline-release-rejected" });
        // Stopped before the risk was read: no line about it.
        expect(out.passed === false && (out.lines ?? []).some((l) => l.includes("change risk"))).toBe(false);
      }
    }
  });

  test("the urgent rule stands in for the gate before the risk is read", async () => {
    const base = shop({ risk: { approveAbove: 0.1, quorum: [{ count: 3 }] } });
    const spec = asPipelineSpec({ ...base, stages: base.stages.map((s) => (s.name === "prod" ? { ...s, gate: { ...s.gate, urgent: { role: "sre-lead" } } } : s)) });
    const urgent = approval("github:erin", { gate: "prod-urgent", approver: { kind: "human" }, releaseDigest: DIGEST });
    const port: GateLedgerPort = { ...memoryGateLedgerPort({ resolutions: [urgent] }), quorumJudge: async () => (r) => ({ proven: r.resolvedBy === "github:erin", roles: r.resolvedBy === "github:erin" ? ["sre-lead"] : [] }) };
    const out = await pipelinePromoteGates({ spec, to: "prod", skipped: [], digest: DIGEST, releaseDigest: DIGEST, port, now, urgent: true, risk: HIGH });
    expect(out).toMatchObject({ passed: true, urgent: { role: "sre-lead" } });
    expect(out.passed && out.lines.some((l) => l.includes("change risk"))).toBe(false);
  });
});

describe("a later stage's holds.risk needs a first stage that scores", () => {
  const stages = (dev: Record<string, unknown>, prod: Record<string, unknown>) => [
    { name: "dev", waves: [{ name: "dev" }], ...dev },
    { name: "staging", waves: [{ name: "staging" }] },
    { name: "prod", waves: [{ name: "prod" }], ...prod },
  ];
  const riskGate = { gate: { holds: { risk: { approveAbove: 0.5 } } } };

  test("is refused at fold when the first stage scores nothing, naming the later stage", () => {
    const problems = pipelineSpecProblems({ name: "shop", stages: stages({ gate: { policy: "never" } }, riskGate) });
    expect(problems).toEqual([expect.stringContaining('stage "prod" reads holds.risk at its gate')]);
    expect(problems[0]).toContain("the first stage must score with holds.risk for a release to carry a score");
    // A first stage with holds of its own but no risk does not take the defaults' risk, while a later stage
    // with no holds of its own does, so staging (from defaults) and prod (its own) are both refused.
    const overridden = pipelineSpecProblems({ name: "shop", defaults: { holds: { risk: {} } }, stages: stages({ gate: { holds: { policy: true } } }, riskGate) });
    expect(overridden.map((p) => /stage "(\w+)"/.exec(p)?.[1])).toEqual(["staging", "prod"]);
  });

  test("folds when the first stage scores, of its own or from defaults", () => {
    expect(pipelineSpecProblems({ name: "shop", stages: stages({ gate: { holds: { risk: {} } } }, riskGate) })).toEqual([]);
    expect(pipelineSpecProblems({ name: "shop", defaults: { holds: { risk: {} } }, stages: stages({}, riskGate) })).toEqual([]);
    // No later stage reads a score: nothing to refuse.
    expect(pipelineSpecProblems({ name: "shop", stages: stages({}, {}) })).toEqual([]);
  });
});

describe("each later stage's reading, for the plan note and workspace status", () => {
  test("names each later stage with holds.risk and what the score asks for there", () => {
    const spec = asPipelineSpec({ ...shop({ risk: { approveAbove: 0.5, quorum: [{ count: 2, roles: ["sre"] }] } }), stages: shop({ risk: { approveAbove: 0.5, quorum: [{ count: 2, roles: ["sre"] }] } }).stages.map((s) => (s.name === "staging" ? { ...s, gate: { holds: { risk: { approveAbove: 0.95 } } } } : s)) });
    const views = laterStageRisk(spec, { score: HIGH.score, reasons: HIGH.waves[0]!.risk.reasons });
    expect(views).toEqual([
      { stage: "staging", approveAbove: 0.95, over: false, quorum: [] },
      { stage: "prod", approveAbove: 0.5, over: true, quorum: [{ count: 2, roles: ["sre"] }] },
    ]);
    const lines = laterStageRiskLines(views, HIGH.score);
    expect(lines).toContain("| staging | 0.95 | nothing more |");
    expect(lines).toContain("| prod | 0.5 | 2 approvals with the role sre on top of the gate's own |");
    expect(laterStageRisk(shop(), { score: 1, reasons: [] })).toEqual([]);
  });
});
