/**
 * The soak at a gate (#5326): what a promote into the next stage, and the
 * next wave's job, run before their own gate.
 *
 * The soak has a gate of its own on the gate ledger: `<stage>-soak` under
 * the pipeline's op for a stage, `<gate>-wave-<k>-soak` under the spec's op
 * for wave `k`. Its approval is how a person ends the soak early, bound to
 * the release's digest (or the wave's). A product maps its own comment,
 * such as `/terragucci skip-soak`, onto that approval. The approval names
 * who, and the promote records it as spent on `_gates/<op>/applied.jsonl`.
 *
 * A soak that holds records the gate's pending fact with the soak's state
 * on it (`soak`: the clock, the time left, the holds, the checks that
 * failed), and the run exits 3. The next run reads that state back: a
 * `restart` check that failed and now passes starts the clock over.
 *
 * Ending a soak early, or a soak passing, opens nothing by itself: the next
 * stage's gate, or the next wave's, still waits for its approval. A soak
 * only ever adds a wait.
 *
 * A check that starts failing also records a `verify-failed` fact for the
 * agent (#5339, `../ci-agent-verify-failed.ts`), when the job's
 * `CHANT_AGENT_FACTS` names `verify-failed` and it holds the relay key. The
 * fact is read from the same change the notice is sent for, and the soak's
 * outcome is the same with or without it.
 */

import { createHash } from "node:crypto";
import { approveCommand, evaluateGate, type GateLedgerPort } from "../op/gate";
import type { GateQuorumNode } from "../op/gate-quorum";
import type { PendingGateRecord, PendingGateSoak } from "../lifecycle/gate-ledger";
import { makeNotifyEvent, sendNotify, type NotifyConfig, type NotifyEvent } from "../notify";
import { decideSoak, soakHoldLines, type Soak, type SoakCheckReader, type SoakClockState, type SoakDecision, type SoakSubject } from "./soak";

/** How long a soak's pending fact stands before a run records it again. Longer than any soak a stage declares in practice. */
export const SOAK_FACT_EXPIRY = "30d";

/** The gate a stage's soak is ended early through. */
export function stageSoakGate(stage: string): string {
  return `${stage}-soak`;
}

/** The gate wave `k`'s soak is ended early through, from the wave's own gate name. */
export function waveSoakGate(waveGate: string): string {
  return `${waveGate}-soak`;
}

export interface SoakGateInput {
  /** The op the soak's gate is recorded under: the pipeline's name, or the op-waves spec's op. */
  op: string;
  /** The soak's gate: {@link stageSoakGate} or {@link waveSoakGate}. */
  gate: string;
  soak: Soak | undefined;
  /** The environment that soaks: the stage's name, or the wave's environment. */
  stage: string;
  /** What the soak holds, as the output names it: `stage staging`, `wave 3 (prod)`. */
  holds: string;
  /** On a stage's soak: the stage promoted into. On a wave's: the wave that soaks. */
  to?: string;
  wave?: number;
  /** The digest an early end binds: the release's, or the promoted digests', or the wave's. */
  digest: string;
  releaseDigest?: string;
  /** The members that applied, with when. */
  subjects: readonly SoakSubject[];
  /** The approval rules an early end takes. Absent: one approval. */
  quorum?: GateQuorumNode[];
  port: GateLedgerPort;
  read: SoakCheckReader;
  now: Date;
  gitSha?: string;
  /** Where a failed check's notice goes. Absent: none is sent. */
  notify?: { config: NotifyConfig | undefined; source: string; project?: string; send?: (config: NotifyConfig | undefined, event: NotifyEvent) => Promise<unknown> };
  /**
   * Where a failing check's `verify-failed` fact is recorded (#5339): the
   * job's variables (default the process's), the checkout, and where the
   * line it logs goes (default stderr). Without `CHANT_AGENT_FACTS` naming
   * `verify-failed`, nothing is recorded.
   */
  agentFacts?: { env?: Record<string, string | undefined>; cwd?: string; say?: (line: string) => void };
}

/** What {@link soakAtGate} decided: passed, with what it says, or held with exit 3. */
export type SoakGateOutcome =
  | { passed: true; lines: string[]; decision: SoakDecision }
  | { passed: false; exitCode: 3; code: "pipeline-soak-waiting"; message: string; hint: string; lines: string[]; decision: SoakDecision; recorded?: PendingGateRecord };

/** The gate ledger with every read and no write: an early end is looked for without recording a fact. */
function readOnly(port: GateLedgerPort): GateLedgerPort {
  const { appendResolution: _r, appendApplied: _a, appendFinished: _f, storeRequestAttachment: _s, writeCheckpoint: _c, ...reads } = port;
  return {
    ...reads,
    async appendPending(input) {
      return { record: { version: 1, kind: "pending", ...input } as PendingGateRecord, pushed: false, pushWarning: "not recorded" };
    },
  };
}

function sameState(a: SoakClockState, b: SoakClockState): boolean {
  return (a.restartedAt ?? "") === (b.restartedAt ?? "") && JSON.stringify(a.failing ?? []) === JSON.stringify(b.failing ?? []);
}

/** Decide the soak in front of a gate, read and record its fact, and notify a failed check. See the module comment. */
export async function soakAtGate(input: SoakGateInput): Promise<SoakGateOutcome> {
  const { port, op, gate, digest, stage } = input;
  const now = input.now.toISOString();
  const approval = input.quorum && input.quorum.length > 0 ? { approval: { quorum: input.quorum, mode: "enforce" as const } } : {};
  const gateInput = {
    op,
    gate,
    planDigest: digest,
    environment: stage,
    now,
    ...(input.releaseDigest ? { releaseDigest: input.releaseDigest } : {}),
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
    ...approval,
  };
  if (!input.soak) return { passed: true, lines: [], decision: await decideSoak({ soak: undefined, subjects: [], environment: stage, now: input.now, read: input.read }) };

  // A person's early end wins over everything else.
  const early = await evaluateGate(readOnly(port), gateInput);
  const ledger = await port.read(op);
  const facts = ledger.pending.filter((p) => p.gate === gate && p.environment === stage && p.planDigest === digest && p.soak);
  const last = facts.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1)?.soak;
  const prior: SoakClockState = { ...(last?.restartedAt ? { restartedAt: last.restartedAt } : {}), ...(last?.failing ? { failing: [...last.failing] } : {}) };
  const decision = await decideSoak({
    soak: input.soak,
    subjects: input.subjects,
    environment: stage,
    now: input.now,
    state: prior,
    read: input.read,
    ...(early.satisfied ? { ended: { by: early.resolution.resolvedBy } } : {}),
  });

  if (decision.outcome === "release") {
    if (decision.via === "ended" && early.satisfied) {
      await port.appendApplied?.({ version: 1, kind: "applied", op, gate, planDigest: digest, approvedAt: early.resolution.timestamp, approvedBy: early.resolution.resolvedBy, timestamp: now, ...(input.gitSha ? { commit: input.gitSha } : {}) });
      return { passed: true, lines: [`the soak of ${stage} was ended early by ${early.resolution.resolvedBy} through ${op} ${gate}`], decision };
    }
    const rule = decision.rules[0]?.rule;
    return { passed: true, lines: [`${stage} soaked${rule && rule.durationMs > 0 ? ` for ${rule.duration}` : ""} since ${decision.clockStart}, and its checks pass`], decision };
  }

  const lines = soakHoldLines(decision);
  const time = decision.holds.find((h) => h.reason === "time");
  const soakFact: PendingGateSoak = {
    stage,
    ...(input.wave !== undefined ? { wave: input.wave } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
    clockStart: decision.clockStart,
    due: decision.due,
    ...(time && time.reason === "time" ? { leftMs: time.leftMs } : {}),
    holds: lines,
    ...decision.state,
  };
  const description = `${input.holds} waits for the soak of ${stage}: ${lines.join("; ")}`;
  const got = await evaluateGate(port, { ...gateInput, description, timeout: SOAK_FACT_EXPIRY, fields: { soak: soakFact } });
  if (got.satisfied) {
    // Approved between the read above and now: ended early all the same.
    await port.appendApplied?.({ version: 1, kind: "applied", op, gate, planDigest: digest, approvedAt: got.resolution.timestamp, approvedBy: got.resolution.resolvedBy, timestamp: now, ...(input.gitSha ? { commit: input.gitSha } : {}) });
    return { passed: true, lines: [`the soak of ${stage} was ended early by ${got.resolution.resolvedBy} through ${op} ${gate}`], decision: { ...decision, outcome: "release", via: "ended", holds: [], endedBy: { by: got.resolution.resolvedBy } } };
  }
  let recorded: PendingGateRecord | undefined = got.recorded ? got.pending : undefined;
  if (!got.recorded && !sameState(prior, decision.state)) {
    // The standing fact is reused while it lives; a change in the clock's state is recorded on a fresh one, so the next run reads it.
    const { version: _v, kind: _k, ...standing } = got.pending;
    recorded = (await port.appendPending({ ...standing, timestamp: now, description, soak: soakFact })).record;
  }

  // A check newly failed: tell people, once per change.
  const checks = decision.holds.filter((h) => h.reason === "check");
  const fresh = (decision.state.failing ?? []).filter((f) => !(prior.failing ?? []).includes(f));
  // #5339: a check that newly failed (not one that reads unknown) is a fact for the verify-failed agent. Recording never changes the soak.
  const newlyFailed = checks.filter((h) => h.reason === "check" && h.status === "failed" && fresh.includes(h.member ? `${h.check}@${h.member}` : h.check));
  if (newlyFailed.length > 0) {
    const { recordVerifyFailed, soakFailedRecords } = await import("../ci-agent-verify-failed");
    const records = soakFailedRecords({
      stage,
      holds: input.holds,
      ...(input.wave !== undefined ? { wave: input.wave } : {}),
      ...(input.releaseDigest ? { releaseDigest: input.releaseDigest } : {}),
      checks: newlyFailed.flatMap((h) => (h.reason === "check" ? [{ check: h.check, kind: h.kind, detail: h.detail, ...(h.member ? { member: h.member } : {}), ...(h.targets ? { targets: h.targets } : {}) }] : [])),
    });
    const line = await recordVerifyFailed(records, { ...(input.agentFacts?.env ? { env: input.agentFacts.env } : {}), ...(input.agentFacts?.cwd ? { cwd: input.agentFacts.cwd } : {}), now: input.now });
    if (line) (input.agentFacts?.say ?? ((l: string) => console.error(l)))(line);
  }
  if (input.notify && checks.length > 0 && fresh.length > 0) {
    const event = makeNotifyEvent({
      source: input.notify.source,
      event: "soak",
      summary: `${input.holds} is held: a soak check of ${stage} failed`,
      environment: stage,
      ...(input.notify.project ? { project: input.notify.project } : {}),
      targets: [...new Set(checks.flatMap((h) => (h.reason === "check" ? (h.targets ?? []) : [])))],
      digest,
      // The id covers the failing checks, so a receiver drops a repeat and hears a new failure.
      id: createHash("sha256").update(JSON.stringify([input.notify.source, op, gate, digest, decision.state.failing ?? []])).digest("hex"),
      soak: {
        stage,
        ...(input.wave !== undefined ? { wave: input.wave } : {}),
        holds: input.holds,
        clockStart: decision.clockStart,
        due: decision.due,
        checks: checks.map((h) => (h.reason === "check" ? { name: h.check, kind: h.kind, onFail: h.onFail, status: h.status, detail: h.detail, ...(h.member ? { member: h.member } : {}), ...(h.targets ? { targets: h.targets } : {}) } : undefined)).filter((c): c is NonNullable<typeof c> => c !== undefined),
      },
      reason: lines.join("; "),
      exitCode: 3,
    }, { now: input.now });
    try {
      await (input.notify.send ?? sendNotify)(input.notify.config, event);
    } catch {
      // A notice never changes the outcome.
    }
  }

  return {
    passed: false,
    exitCode: 3,
    code: "pipeline-soak-waiting",
    message: `${input.holds} waits for the soak of ${stage}: ${lines.join("; ")}`,
    hint: `Run it again once the soak is up, or end the soak early with: ${approveCommand(op, gate, stage, digest)}`,
    lines,
    decision,
    ...(recorded ? { recorded } : {}),
  };
}
