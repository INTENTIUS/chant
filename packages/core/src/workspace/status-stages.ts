/**
 * The release view per stage for `chant workspace status` (#5342): for each
 * stage of a member's pipeline, the release it runs, its gate, the change
 * risk the gate reads, its soak and the time left, the canary soaks that
 * hold it, a pause, and a rollback request.
 *
 * Everything is read from what the runs recorded on `chant/lifecycle`, at
 * the branch tip `status` names, and nothing is written:
 *
 * - the stage's release ledger, `<stage>/releases.jsonl` under the member's
 *   prefix, for the release it runs;
 * - the pipeline's gate ledger, `_gates/<pipeline>.jsonl`, for gate
 *   `<stage>`, the soak's gate `<stage>-soak` (#5326, the soak's state is on
 *   its pending fact) and the rollback's gate `<stage>-rollback` (#5328);
 * - the release cuts, for labels and each release's change risk (#5387);
 * - the stage's own ledger, `<stage>/stage.jsonl` (#5355, #5328), for a
 *   pause and a rollback request.
 *
 * Status never reads a soak check: a soak's state is the one the last run
 * that read it recorded, and the time left is counted from its `due` to now.
 * The pipeline itself is read from the member's working tree, as
 * `promotionOrder` reads it.
 */

import { execFileSync } from "node:child_process";
import { latestPerComponent, type ReleaseRecord } from "../lifecycle/release-ledger";
import type { ReleaseCut } from "../lifecycle/release-store";
import { releaseRiskAt, stageRiskSettings } from "../lifecycle/release-risk";
import type { PipelineSpec, PipelineStage } from "../pipeline/spec";
import { canaryStagesBefore, stageUpstreams } from "../pipeline/spec";
import { soakCheckCount, soakSpan } from "../pipeline/soak";
import { stageSoakGate } from "../pipeline/soak-gate";
import { parseStagePauseLines, stagePaused, STAGE_LEDGER_FILE, waitingReleases, type StagePauseLine } from "../pipeline/stage-ledger";
import { requestedRollbackCommand, stageOnVerifyFail, stageRollbackGate, standingRollbackRequest } from "../pipeline/verify-rollback";
import { approveCommand, type GateState, type StatusGate } from "./status-gates";
import type { OpWaveGatePolicy } from "../op/op-waves";

/** A release a stage line names: its digest and label. */
export interface StatusStageReleaseRef {
  digest: string;
  label: string | null;
}

/** The release a stage runs, from its release ledger. */
export interface StatusStageRunning {
  /** The release the newest deploy in the stage was made from, or null when that deploy named none. */
  releaseDigest: string | null;
  label: string | null;
  /** The commit of the newest deploy. */
  gitSha: string;
  /** When the newest deploy was recorded. */
  at: string;
  /** The components whose newest deploy is of that same release (or commit, when it named none), sorted. */
  components: string[];
  /** True when the stage's components run more than one release. */
  mixed: boolean;
}

/** The stage's gate, `<stage>` under the pipeline's op. */
export interface StatusStageGate {
  /** The gate's name: the stage's. */
  name: string;
  /** The stage's gate policy, `always` when it declares none. */
  policy: OpWaveGatePolicy;
  /** The state of the newest pending fact for the gate, or null when no promote has reached it. */
  state: GateState | null;
  /** The release that fact binds, or null when it names none or there is no fact. */
  releaseDigest: string | null;
  label: string | null;
  /** The digest the fact binds: the release's, or the promoted digests'. */
  planDigest: string | null;
  recordedAt: string | null;
  approvals: number;
  needed: number;
  /** The `chant approve` line for the fact, or null when there is none. */
  approve: string | null;
}

/** The change risk the stage's gate reads, for one release (#5387). */
export interface StatusStageRisk {
  /** The release read: the one at the stage's gate while its fact is pending, else the one the stage runs. */
  releaseDigest: string;
  label: string | null;
  score: number;
  level: "low" | "medium" | "high";
  /** True when the stage sets `holds.risk`, so its gate reads the score. */
  reads: boolean;
  approveAbove: number | null;
  /** True when the gate takes more approvals for this release. False when `reads` is false. */
  over: boolean;
  overBy: string[];
}

/**
 * A soak's state, as the last run that read it recorded it:
 *
 * - `unread`: no standing fact for the stage's release; no promote out of the stage has read the soak since it ran that release;
 * - `soaking`: the last run held it, and time is left;
 * - `due`: the last run held it for time only, and the time is up; the next promote reads the checks;
 * - `failing`: the last run held it on a check that failed or could not be read;
 * - `clock-unknown`: the last run found no apply time, so no clock could be counted;
 * - `ended`: a person ended it early through its gate.
 */
export type StatusSoakState = "unread" | "soaking" | "due" | "failing" | "clock-unknown" | "ended";

/** A stage's soak (#5326). */
export interface StatusStageSoak {
  /** The gate a person ends it early through: `<stage>-soak` under the pipeline's op. */
  gate: string;
  /** As declared. */
  duration: string;
  /** How many checks it reads, its own and its overrides'. */
  checks: number;
  state: StatusSoakState;
  /** The release the standing fact binds, or null. */
  releaseDigest: string | null;
  /** The stage the promotion it held waits to go into, or null. */
  to: string | null;
  clockStart: string | null;
  due: string | null;
  /** Milliseconds from now to `due`, at least 0; null without a due time. */
  leftMs: number | null;
  /** Why the last run held it, one line each. */
  holds: string[];
  /** The checks that failed on the last run, as `<check>` or `<check>@<member>`. */
  failing: string[];
  recordedAt: string | null;
  /** On `ended`: who ended it. */
  endedBy: string | null;
}

/** A canary stage upstream whose soak holds a promote into this stage (#5327). */
export interface StatusCanaryHold {
  stage: string;
  state: StatusSoakState;
  due: string | null;
  leftMs: number | null;
  /** True when the canary's soak holds the stage now: `soaking`, `failing` or `clock-unknown`. */
  holding: boolean;
}

/** A pause on the stage (#5355). */
export interface StatusStagePause {
  by: string;
  at: string;
  reason: string | null;
  /** `rollback` when a rollback of a stage with `pauseAfterRollback` paused it. */
  cause: "rollback" | null;
  /** The releases that waited while it is paused, oldest first. The newest enters on resume. */
  waiting: StatusStageReleaseRef[];
}

/** A rollback request that no rollback has carried out yet (#5328). */
export interface StatusStageRollback {
  id: string;
  requestedAt: string;
  by: string;
  failure: "verify" | "soak" | null;
  /** The release that failed in the stage. */
  failed: StatusStageReleaseRef | null;
  /** The release the rollback goes back to. */
  to: StatusStageReleaseRef;
  /** Each member, its state after the failure, and whether the rollback restores it. */
  members: { member: string; state: string; rollback?: string }[];
  /** The gate it waits at, `<stage>-rollback` under the pipeline's op. */
  gate: string;
  /** The gate's state, or null when its pending fact is not on the ledger. */
  state: GateState | null;
  approve: string;
  /** The command that carries it out once the gate passes. */
  command: string;
}

/** A failure for which no rollback could be requested (#5328). */
export interface StatusStageRollbackHeld {
  failureId: string;
  at: string;
  reason: string;
  failure: "verify" | "soak" | null;
  failed: StatusStageReleaseRef | null;
}

/** One stage of a member's pipeline, as `workspace status` shows it (#5342). */
export interface StatusStage {
  name: string;
  canary: boolean;
  /** The stages a release succeeds in before this one opens: its `after`, else the stage before it. */
  after: string[];
  /** The release it runs, or null when its ledger records no deploy or can't be read. */
  release: StatusStageRunning | null;
  gate: StatusStageGate;
  /** The change risk the gate reads, or null when the release read carries none. */
  risk: StatusStageRisk | null;
  /** The stage's soak, or null when it declares none. */
  soak: StatusStageSoak | null;
  /** Each canary stage upstream, in pipeline order. Empty when there is none. */
  canaryHolds: StatusCanaryHold[];
  /** The standing pause, or null. */
  paused: StatusStagePause | null;
  onVerifyFail: "hold" | "rollback";
  /** The standing rollback request, or null. */
  rollback: StatusStageRollback | null;
  /** The newest failure, when no rollback could be requested for it and none has run since; else null. */
  rollbackHeld: StatusStageRollbackHeld | null;
}

/** A member's pipeline as `workspace status` shows it (#5342). */
export interface StatusPipeline {
  /** The pipeline's name, the op its stage gates are recorded under. */
  name: string;
  /** Every stage, in pipeline order. */
  stages: StatusStage[];
}

/** Reads one file on the branch at `commit`: its text, or null when it isn't there. */
export type StageLedgerReader = (path: string, commit: string, cwd: string) => Promise<string | null>;

export const defaultStageLedgerReader: StageLedgerReader = async (path, commit, cwd) => {
  try {
    return execFileSync("git", ["cat-file", "blob", `${commit}:${path}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};

export interface StageViewInput {
  spec: PipelineSpec;
  /** The member's ledger prefix: `_members/<member>/`, or "" for the flat layout. */
  prefix: string;
  /** The branch tip read, or null when the checkout has no ledger branch. */
  commit: string | null;
  cwd: string;
  now: string;
  /** The member's gates read for every stage, before any filtering. */
  gates: readonly StatusGate[];
  /** The member's release cuts, or null when they can't be read. */
  cuts: readonly ReleaseCut[] | null;
  /** Reads one stage's release ledger, by its path on the branch. */
  readReleases: (path: string) => Promise<ReleaseRecord[] | null>;
  readStageLedger?: StageLedgerReader;
}

const ms = (iso: string | null | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

function running(records: ReleaseRecord[], labels: ReadonlyMap<string, string>): StatusStageRunning | null {
  const latest = [...latestPerComponent(records).values()];
  if (latest.length === 0) return null;
  const newest = latest.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
  const key = (r: ReleaseRecord) => r.releaseDigest ?? `git:${r.gitSha}`;
  return {
    releaseDigest: newest.releaseDigest ?? null,
    label: newest.releaseDigest !== undefined ? (labels.get(newest.releaseDigest) ?? null) : null,
    gitSha: newest.gitSha,
    at: newest.timestamp,
    components: latest.filter((r) => key(r) === key(newest)).map((r) => r.component).sort(),
    mixed: new Set(latest.map(key)).size > 1,
  };
}

/** The soak of `stage` as its gate's newest fact records it. */
function soakView(stage: PipelineStage, gate: StatusGate | undefined, runs: StatusStageRunning | null, now: number): StatusStageSoak | null {
  if (!stage.soak) return null;
  const base: StatusStageSoak = {
    gate: stageSoakGate(stage.name),
    duration: stage.soak.duration,
    checks: soakCheckCount(stage.soak),
    state: "unread",
    releaseDigest: null,
    to: null,
    clockStart: null,
    due: null,
    leftMs: null,
    holds: [],
    failing: [],
    recordedAt: null,
    endedBy: null,
  };
  if (!gate || gate.state === "expired" || gate.state === "superseded") return base;
  // A fact for another release than the one the stage runs says nothing about this one's soak.
  if (gate.releaseDigest !== undefined && runs?.releaseDigest && gate.releaseDigest !== runs.releaseDigest) return base;
  const fact = gate.soak;
  const due = fact?.due ?? null;
  const dueAt = ms(due);
  const view: StatusStageSoak = {
    ...base,
    releaseDigest: gate.releaseDigest ?? null,
    to: fact?.to ?? null,
    clockStart: fact?.clockStart ?? null,
    due,
    leftMs: dueAt === undefined ? null : Math.max(0, dueAt - now),
    holds: [...(fact?.holds ?? [])],
    failing: [...(fact?.failing ?? [])],
    recordedAt: gate.recordedAt,
  };
  if (gate.state === "approved") return { ...view, state: "ended", endedBy: gate.approvals.at(-1)?.principal ?? null };
  if (!fact) return base;
  if (dueAt === undefined) return { ...view, state: "clock-unknown" };
  if (view.failing.length > 0) return { ...view, state: "failing" };
  return { ...view, state: view.leftMs! > 0 ? "soaking" : "due" };
}

const HOLDING: readonly StatusSoakState[] = ["soaking", "failing", "clock-unknown"];

/** Every stage of `spec`, read from the ledgers. Never throws on a ledger: what can't be read is null. */
export async function readStageViews(input: StageViewInput): Promise<StatusStage[]> {
  const { spec, prefix, commit, cwd } = input;
  const now = Date.parse(input.now);
  const cuts = input.cuts ?? [];
  const labels = new Map<string, string>();
  for (const c of cuts) if (c.label !== null && !labels.has(c.releaseDigest)) labels.set(c.releaseDigest, c.label);
  const riskOf = new Map(cuts.filter((c) => c.risk).map((c) => [c.releaseDigest, c.risk!]));
  const ref = (r: { digest: string; label?: string | null } | undefined): StatusStageReleaseRef | null => (r ? { digest: r.digest, label: r.label ?? labels.get(r.digest) ?? null } : null);
  const gateOf = (name: string, env: string) => input.gates.find((g) => g.component === spec.name && g.name === name && g.env === env);
  const readLedger = input.readStageLedger ?? defaultStageLedgerReader;

  const stages: StatusStage[] = [];
  for (const stage of spec.stages) {
    const records = await input.readReleases(`${prefix}${stage.name}/releases.jsonl`).catch(() => null);
    const release = records ? running(records, labels) : null;

    const g = gateOf(stage.name, stage.name);
    const gate: StatusStageGate = {
      name: stage.name,
      policy: stage.gate?.policy ?? "always",
      state: g?.state ?? null,
      releaseDigest: g?.releaseDigest ?? null,
      label: g?.releaseDigest !== undefined ? (labels.get(g.releaseDigest) ?? null) : null,
      planDigest: g?.planDigest ?? null,
      recordedAt: g?.recordedAt ?? null,
      approvals: g?.approvals.length ?? 0,
      needed: g?.needed ?? 1,
      approve: g?.approve ?? null,
    };

    // The release the gate decides on while it waits, else the one the stage runs.
    const riskRelease = gate.releaseDigest !== null && gate.state === "pending" ? gate.releaseDigest : release?.releaseDigest ?? null;
    const record = riskRelease ? riskOf.get(riskRelease) : undefined;
    let risk: StatusStageRisk | null = null;
    if (riskRelease && record) {
      const settings = stageRiskSettings(spec, stage.name);
      const read = settings ? releaseRiskAt(record, settings) : undefined;
      risk = {
        releaseDigest: riskRelease,
        label: labels.get(riskRelease) ?? null,
        score: record.score,
        level: record.level,
        reads: settings !== undefined,
        approveAbove: read?.approveAbove ?? null,
        over: read?.over ?? false,
        overBy: read?.overBy ? [...read.overBy] : [],
      };
    }

    const text = commit === null ? null : await readLedger(`${prefix}${stage.name}/${STAGE_LEDGER_FILE}`, commit, cwd).catch(() => null);
    const lines: StagePauseLine[] = parseStagePauseLines(text).lines.filter((l) => l.pipeline === spec.name && l.stage === stage.name);
    const pause = stagePaused(lines);
    const paused: StatusStagePause | null = pause
      ? { by: pause.by, at: pause.timestamp, reason: pause.reason ?? null, cause: pause.cause ?? null, waiting: waitingReleases(lines).map((r) => ref(r)!) }
      : null;

    const failureOf = (id: string | undefined) => (id === undefined ? undefined : lines.find((l) => l.kind === "failed" && l.id === id));
    const request = standingRollbackRequest(lines);
    let rollback: StatusStageRollback | null = null;
    if (request?.id && request.release) {
      const rgate = request.gate ?? stageRollbackGate(stage.name);
      const fact = gateOf(rgate, stage.name);
      const bound = fact && fact.planDigest === request.release.digest ? fact : undefined;
      rollback = {
        id: request.id,
        requestedAt: request.timestamp,
        by: request.by,
        failure: failureOf(request.failureId)?.failure ?? null,
        failed: ref(request.failed),
        to: ref(request.release)!,
        members: (request.members ?? []).map((m) => ({ member: m.member, state: m.state, ...(m.rollback !== undefined ? { rollback: m.rollback } : {}) })),
        gate: rgate,
        state: bound?.state ?? null,
        approve: bound?.approve ?? approveCommand(spec.name, rgate, stage.name, request.release.digest, stage.gate?.approval === "sealed"),
        command: requestedRollbackCommand(stage.name),
      };
    }
    let rollbackHeld: StatusStageRollbackHeld | null = null;
    const lastFailure = [...lines].reverse().find((l) => l.kind === "failed");
    if (lastFailure?.id) {
      const at = lines.indexOf(lastFailure);
      const held = lines.slice(at + 1).find((l) => l.kind === "rollback-held" && l.failureId === lastFailure.id);
      const since = lines.slice(at + 1).some((l) => l.kind === "rolled-back" || l.kind === "rollback-requested");
      if (held && !since) {
        rollbackHeld = { failureId: lastFailure.id, at: held.timestamp, reason: held.held ?? "", failure: lastFailure.failure ?? null, failed: ref(lastFailure.failed) };
      }
    }

    stages.push({
      name: stage.name,
      canary: stage.canary === true,
      after: stageUpstreams(spec, stage.name),
      release,
      gate,
      risk,
      soak: null,
      canaryHolds: [],
      paused,
      onVerifyFail: stageOnVerifyFail(stage),
      rollback,
      rollbackHeld,
    });
  }

  // Soaks next, since a canary's is read against the release the canary runs.
  for (const [i, stage] of spec.stages.entries()) {
    stages[i]!.soak = soakView(stage, gateOf(stageSoakGate(stage.name), stage.name), stages[i]!.release, now);
  }
  for (const [i, stage] of spec.stages.entries()) {
    stages[i]!.canaryHolds = canaryStagesBefore(spec, stage.name).map((c) => {
      const soak = stages.find((s) => s.name === c.name)!.soak;
      const state = soak?.state ?? "unread";
      return { stage: c.name, state, due: soak?.due ?? null, leftMs: soak?.leftMs ?? null, holding: HOLDING.includes(state) };
    });
  }
  return stages;
}

const releaseName = (r: { label: string | null; digest?: string; releaseDigest?: string | null } | null): string => {
  if (!r) return "-";
  const digest = r.digest ?? r.releaseDigest ?? null;
  return r.label ?? (digest ? digest.slice(0, 24) : "-");
};

function soakCell(s: StatusStageSoak | null): string {
  if (!s) return "-";
  switch (s.state) {
    case "unread":
      return `${s.duration}, not read yet`;
    case "soaking":
      return `${soakSpan(s.leftMs ?? 0)} left`;
    case "due":
      return "time up, checks read on the next promote";
    case "failing":
      return `failing: ${s.failing.join(", ")}`;
    case "clock-unknown":
      return "no apply time, clock not started";
    case "ended":
      return `ended early by ${s.endedBy ?? "an approval"}`;
  }
}

/** The text view's table: one line per stage of each member's pipeline. */
export function stageRows(members: readonly { name: string; pipeline?: StatusPipeline }[]): string[][] {
  const rows: string[][] = [["MEMBER", "STAGE", "RUNS", "GATE", "RISK", "SOAK", "CANARY", "ROLLBACK"]];
  for (const m of members) {
    if (!m.pipeline) continue;
    for (const s of m.pipeline.stages) {
      const runs = s.release ? `${s.release.label ?? s.release.releaseDigest?.slice(0, 24) ?? s.release.gitSha.slice(0, 8)}${s.release.mixed ? " (mixed)" : ""}` : "-";
      const gate = s.paused
        ? `paused by ${s.paused.by}${s.paused.waiting.length > 0 ? `, ${s.paused.waiting.length} waiting` : ""}`
        : s.gate.state
          ? `${s.gate.state} ${s.gate.approvals}/${s.gate.needed}${s.gate.releaseDigest ? ` ${releaseName({ label: s.gate.label, releaseDigest: s.gate.releaseDigest })}` : ""}`
          : s.gate.policy === "never"
            ? "open"
            : "-";
      const risk = s.risk ? `${s.risk.score.toFixed(2)} ${s.risk.level}${s.risk.reads && s.risk.approveAbove !== null ? ` ${s.risk.over ? "over" : "within"} ${s.risk.approveAbove}` : s.risk.over ? " over" : ""}` : "-";
      const holding = s.canaryHolds.filter((c) => c.holding);
      const canary = s.canary
        ? "canary"
        : holding.length > 0
          ? `held by ${holding.map((c) => `${c.stage}${c.leftMs !== null && c.state === "soaking" ? ` (${soakSpan(c.leftMs)} left)` : ` (${c.state})`}`).join(", ")}`
          : "-";
      const rollback = s.rollback
        ? `to ${releaseName(s.rollback.to)}, ${s.rollback.state ?? "pending"}`
        : s.rollbackHeld
          ? "held, none requested"
          : "-";
      rows.push([m.name, s.name, runs, gate, risk, soakCell(s.soak), canary, rollback]);
    }
  }
  return rows;
}
