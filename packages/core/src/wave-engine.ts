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
 *
 * The parts that need neither the gate ledger nor the filesystem live in
 * `./gated-waves.ts`, which terragucci bundles on its own (#3421), and
 * `./wave-layout.ts`, which imports nothing so the Op waves spec module can
 * use it without the change-set code; this module re-exports both so a
 * runner imports the engine from one place.
 *
 * What stays with each entry point: how a wave is planned (Op runs' plan
 * commands, or each component's capabilities), the gate policy, approval
 * mode, decision point, hooks and spend rule (Op waves only), and the shape
 * of the record each writes. Those shapes are read by jobs and approvals
 * already in the wild, so the engine writes what it is handed.
 */

import { dirname } from "node:path";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { evaluateGate, type GateCheck, type GateLedgerPort } from "./op/gate";
import type { AppliedGateRecord } from "./lifecycle/gate-applied";

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
