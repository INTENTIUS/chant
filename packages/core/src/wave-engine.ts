/**
 * The wave engine (#3766): what `chant run wave` (the Op waves spec,
 * `./op/op-waves-run.ts`) and `chant components fan-out --wave-gate`
 * (`./components/fan-out-run.ts`) share once a wave is planned.
 *
 * - Gate naming: {@link waveGateName} and {@link waveGateNameFrom}.
 * - The set digest: {@link waveSetDigest} over {@link waveDigestMembers}.
 * - The share split of a wide wave: {@link waveShare}.
 * - The gate decision call: {@link decideWaveGate}.
 * - The record file a wave job hands the next one: {@link writeWaveRecordFile}.
 * - The loop itself: {@link runWaveLoop} plans a wave, takes its set digest,
 *   decides its gate and applies it, then goes on to the next wave or plans
 *   the same one again, as the entry point's steps say.
 *
 * The parts that need neither the gate ledger nor the filesystem live in
 * `./gated-waves.ts`, which terragucci bundles on its own (#3421), and
 * `./wave-layout.ts`, which imports nothing so the Op waves spec module can
 * use it without the change-set code; this module re-exports both so a
 * runner imports the engine from one place.
 *
 * What stays with each entry point, as the steps it hands {@link runWaveLoop}:
 * how a wave is planned (Op runs' plan commands, or each component's
 * capabilities), which members its digest covers, the gate policy, approval
 * mode, decision point, hooks and spend rule (Op waves only), how it applies,
 * and the shape of the record each writes. Those shapes are read by jobs and
 * approvals already in the wild, so the engine writes what it is handed.
 */

import { dirname } from "node:path";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { evaluateGate, type GateCheck, type GateLedgerPort } from "./op/gate";
import type { AppliedGateRecord } from "./lifecycle/gate-applied";
import type { ResolvedGateApproval } from "./op/gate-approval";
import type { GateQuorumJudge } from "./op/gate-quorum";

export { WAVE_GATE_NAME_PATTERN, waveGateNameFrom, waveShare } from "./wave-layout";
export {
  layerWaves,
  waveGateName,
  waveDigestMembers,
  waveSetDigest,
  readWaveRecords,
  withWaveRecord,
  describeChangedWave,
  type WaveDigestOver,
  type WaveMember,
  type WaveNode,
  type WaveRecord,
  type WaveStatus,
} from "./gated-waves";

/** What a wave asks its gate. */
export interface WaveGateRequest {
  /** The op the gate is recorded under: the fan-out's op, or the Op waves spec's name. */
  op: string;
  /** The wave's full gate name. */
  gate: string;
  /** The wave's set digest. */
  digest: string;
  /** The pending fact's description. */
  description: string;
  /** The pending fact's expiry, as a gate's `timeout`. */
  timeout?: string;
  now?: string;
  /** Approvals a wave already applied under, which count for nothing (#3784). */
  spent?: readonly AppliedGateRecord[];
  /** Fields the pending fact carries (#3821). */
  fields?: Record<string, unknown>;
  /** The pending fact carries `neverOverMcp` (#3821). */
  neverOverMcp?: boolean;
  /** The approval rules the wave takes (#4290), as an `approval` block with a quorum. */
  approval?: ResolvedGateApproval;
  /** Judges approvals for those rules (#4290). */
  judge?: GateQuorumJudge;
}

/**
 * Decide a wave's gate: an approval of `digest` under `gate` on `op`'s
 * ledger, or the pending fact that stands for it. A field left out of the
 * request is left out of the call, so each entry point's pending facts are
 * the ones it always wrote.
 */
export function decideWaveGate(port: GateLedgerPort, request: WaveGateRequest): Promise<GateCheck> {
  return evaluateGate(port, {
    op: request.op,
    gate: request.gate,
    planDigest: request.digest,
    description: request.description,
    ...(request.timeout ? { timeout: request.timeout } : {}),
    ...(request.now !== undefined ? { now: request.now } : {}),
    ...(request.spent ? { spent: request.spent } : {}),
    ...(request.fields ? { fields: request.fields } : {}),
    ...(request.neverOverMcp ? { neverOverMcp: true } : {}),
    ...(request.approval ? { approval: request.approval } : {}),
    ...(request.judge ? { judge: request.judge } : {}),
  });
}

/**
 * Write a wave record file as indented JSON, through a temporary file and a
 * rename, so a job killed during the write leaves the previous record whole.
 * The fan-out attempt record and an Op wave's decision record both go
 * through it.
 */
export function writeWaveRecordFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, path);
}

/**
 * What a step hands {@link runWaveLoop}: `go` carries a value into the
 * wave's next step; `end` ends the wave with its outcome, and nothing after
 * that step runs for it.
 */
export type WaveStep<T, R> = { go: T } | { end: R };

/** Where the loop is: wave `k` (1-based), its `pass`, and the outcome of the pass before when the wave is planned again. */
export interface WaveAttempt<R> {
  k: number;
  /** 0 on a wave's first plan. */
  pass: number;
  /** The outcome of the pass that asked to plan again. */
  prior?: R;
}

/**
 * The steps an entry point hands {@link runWaveLoop}, typed by what planning
 * gives (`P`), what deciding gives (`D`) and a wave's outcome (`R`).
 *
 * The two entry points differ in each step, on purpose:
 *
 * - `chant run wave` (Op waves) plans with argv commands and hooks, takes
 *   the digest under `digest.over` with the plans file's extras, decides
 *   with the approval mode, decision point, spend rule, denials and pending
 *   fields read at base, and runs one wave per job (a `rest` wave walks on,
 *   an apply may ask to plan again; a share job applies under its deciding
 *   job's decision).
 * - `chant components fan-out --wave-gate` plans each component's
 *   capabilities, takes the digest over every member (a wave where nothing
 *   planned has the empty digest, and one where nothing is left to run skips
 *   its gate), asks the plain ledger, and walks every wave in one job.
 */
export interface WaveLoopSteps<P, D, R> {
  /** The first wave's number. */
  first: number;
  /** Plan the wave, or end it before it has a set (nothing to run, a hook failed or waits). */
  plan(at: WaveAttempt<R>): Promise<WaveStep<P, R>>;
  /** The wave's set digest over what was planned. */
  digest(at: WaveAttempt<R>, planned: P): string;
  /** Decide the wave's gate against its digest: what the apply goes ahead under, or the outcome when the wave stops here. */
  decide(at: WaveAttempt<R>, planned: P, digest: string): Promise<WaveStep<D, R>>;
  /** Apply the decided wave. */
  apply(at: WaveAttempt<R>, planned: P, decided: D): Promise<R>;
  /** Whether the outcome asks for the same wave to be planned again in this job. Absent: never. */
  replan?(at: WaveAttempt<R>, outcome: R): boolean;
  /** How many passes one wave gets before a replan is refused. Default 1. */
  maxPasses?: number;
  /** The wave asked to plan again after its last pass: the outcome it ends with. */
  passesSpent?(at: WaveAttempt<R>, outcome: R): R;
  /** Called before another pass at the same wave. */
  replanning?(at: WaveAttempt<R>, outcome: R): void;
  /** The wave ended with `outcome`: whether the job goes on to wave `k + 1`. */
  onward(k: number, outcome: R): boolean;
}

/**
 * The wave loop both entry points run (#3766): for each wave, plan it, take
 * its set digest, decide its gate and apply it; plan it again while its
 * outcome asks to, up to `maxPasses`; then go on to the next wave while
 * `onward` says so. Returns the outcome of the last wave it ran. A step that
 * throws ends the loop with that error.
 */
export async function runWaveLoop<P, D, R>(steps: WaveLoopSteps<P, D, R>): Promise<R> {
  for (let k = steps.first; ; k++) {
    let outcome: R;
    let prior: R | undefined;
    for (let pass = 0; ; pass++) {
      const at: WaveAttempt<R> = { k, pass, ...(prior !== undefined ? { prior } : {}) };
      outcome = await runWave(steps, at);
      if (!steps.replan?.(at, outcome)) break;
      if (pass + 1 >= (steps.maxPasses ?? 1)) {
        outcome = steps.passesSpent ? steps.passesSpent(at, outcome) : outcome;
        break;
      }
      steps.replanning?.(at, outcome);
      prior = outcome;
    }
    if (!steps.onward(k, outcome)) return outcome;
  }
}

/** One pass at one wave: plan, digest, decide, apply. */
async function runWave<P, D, R>(steps: WaveLoopSteps<P, D, R>, at: WaveAttempt<R>): Promise<R> {
  const planned = await steps.plan(at);
  if ("end" in planned) return planned.end;
  const digest = steps.digest(at, planned.go);
  const decided = await steps.decide(at, planned.go, digest);
  if ("end" in decided) return decided.end;
  return steps.apply(at, planned.go, decided.go);
}
