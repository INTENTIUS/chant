/**
 * The fan-out attempt record (`--resume`, #2420, #2417, #3049): what an
 * attempt left behind and what the next one reads.
 *
 * It lives here rather than in the CLI handler so a caller that runs a wave
 * per CI job (#3183) reads and writes the same file without importing the
 * command.
 *
 * The digest is stored alongside the progress because progress is only
 * meaningful for the plan it was made against. A fan-out derived from different
 * source is a different fan-out, and carrying "cluster-a already applied" into
 * it would be a claim about work nobody did.
 *
 * `outputs` holds what each completed component exposed. A component left to
 * run may read one of them through `stackOutput()`, and without the record the
 * re-run would resolve that reference to nothing unless somebody supplied the
 * value by hand with `--seed-outputs`.
 *
 * `waves`, for a gated-wave fan-out, holds one entry per wave reached: its set
 * digest, its members, its gate and where it got to. A resumed attempt plans
 * a wave afresh rather than trusting this, since the point of the gate is the
 * plan now. The entries are for whoever reads the record, the plan report
 * (#3349) among them.
 *
 * `carried` holds what a step asked to keep for its member (#3459). It rides
 * in the record rather than beside it because the record is the one file a
 * per-wave CI job hands to the next.
 *
 * `inputs` holds, for each component in `completed`, the input digest it
 * applied (#4081, ./fan-out-inputs.ts). The plan digest only identifies the
 * derivation, and two different changes with the same shape derive the same
 * one, so the digest alone would carry "cluster-a already applied" into a
 * change that never applied it. A resumed attempt carries a component only
 * when its input digest is the same now. A record written before #4081 has
 * no `inputs`, and none of its progress carries.
 */

import { existsSync, readFileSync } from "node:fs";
import { readWaveRecords, writeWaveRecordFile, type WaveRecord } from "../wave-engine";
import type { ChangeSetDocument } from "../change-set";
import type { PrMember, PrWave } from "../pr-loop";

/** What a pull request's apply approved, kept so a re-run can finish it (#3464). */
export interface PrApplyRecord {
  /** The gate's op and name: `pr-<n>` and `pr-apply` unless the pipeline names another. */
  op: string;
  gate: string;
  /** The commit the apply ran on. A record from another commit does not carry. */
  head: string;
  /** The change-set digest the approval stands for. */
  digest: string;
  approvedBy: string[];
  /** Every member of the approved set, as planned. */
  members: PrMember[];
  /** The approved change-set document. Its entries are what a re-planned member is checked against. */
  changeSet: ChangeSetDocument;
  /**
   * The outputs the approved plans read. The members left are planned
   * against them again, so an unchanged member plans to the same digest.
   */
  planOutputs: Record<string, Record<string, unknown>>;
  /**
   * With `--wave-gate` (#4003): each wave reached so far and the approval it
   * applied or waits under, so the next wave's job reports every wave.
   */
  waves?: PrWave[];
}

export interface FanOutAttempt {
  digest: string;
  completed: string[];
  failed: string[];
  outputs: Record<string, Record<string, unknown>>;
  /** Gated-wave fan-outs only (#3049). */
  waves?: WaveRecord[];
  /**
   * What steps kept per member through `DeployContext.carry` (#3459), handed
   * back as `DeployContext.carried` on the next attempt. For a choudoufu
   * root, choudoufu's wave resume file.
   */
  carried?: Record<string, unknown>;
  /** A pull request's apply only (#3464). */
  prApply?: PrApplyRecord;
  /**
   * The input digest each completed component applied (#4081), keyed by
   * name. Absent on a record written before it, which then carries nothing.
   */
  inputs?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** The `prApply` entry, when it has every field a resume needs. Anything else reads as no entry. */
function readPrApplyRecord(value: unknown): PrApplyRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { op, gate, head, digest, approvedBy, members, changeSet, planOutputs } = value;
  if (typeof op !== "string" || typeof gate !== "string" || typeof head !== "string" || typeof digest !== "string") return undefined;
  if (!isStringArray(approvedBy) || !Array.isArray(members) || !members.every(isRecord)) return undefined;
  if (!isRecord(changeSet) || changeSet.digest !== digest || !Array.isArray(changeSet.members) || !Array.isArray(changeSet.entries)) return undefined;
  const outputs: Record<string, Record<string, unknown>> = {};
  if (isRecord(planOutputs)) {
    for (const [name, v] of Object.entries(planOutputs)) if (isRecord(v)) outputs[name] = v;
  }
  const waves = Array.isArray(value.waves) ? value.waves.map(readPrWave).filter((w): w is PrWave => w !== undefined) : [];
  return {
    op,
    gate,
    head,
    digest,
    approvedBy,
    members: members as unknown as PrMember[],
    changeSet: changeSet as unknown as ChangeSetDocument,
    planOutputs: outputs,
    ...(waves.length > 0 ? { waves } : {}),
  };
}

const WAVE_STATUSES: ReadonlySet<string> = new Set(["applied", "failed", "plan-failed", "waiting"]);

/** One `prApply.waves` entry, or `undefined` when it is malformed. */
function readPrWave(value: unknown): PrWave | undefined {
  if (!isRecord(value)) return undefined;
  const { wave, components, status, approval, gate, digest } = value;
  if (typeof wave !== "number" || !isStringArray(components) || typeof status !== "string" || !WAVE_STATUSES.has(status)) return undefined;
  if ((approval !== "pull-request" && approval !== "wave") || typeof gate !== "string" || typeof digest !== "string") return undefined;
  return {
    wave,
    components,
    status: status as PrWave["status"],
    approval,
    gate,
    digest,
    ...(isStringArray(value.approvedBy) ? { approvedBy: value.approvedBy } : {}),
    ...(typeof value.approved === "string" ? { approved: value.approved } : {}),
    ...(isStringArray(value.moved) ? { moved: value.moved } : {}),
  };
}

/** Read an attempt record, or `undefined` when there is none yet. Throws on a file that is not JSON. */
export function readFanOutAttempt(path: string): FanOutAttempt | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FanOutAttempt>;
  const outputs: Record<string, Record<string, unknown>> = {};
  if (isRecord(parsed.outputs)) {
    for (const [name, value] of Object.entries(parsed.outputs)) if (isRecord(value)) outputs[name] = value;
  }
  const waves = readWaveRecords(parsed.waves);
  const prApply = readPrApplyRecord(parsed.prApply);
  let inputs: Record<string, string> | undefined;
  if (isRecord(parsed.inputs)) {
    inputs = {};
    for (const [name, value] of Object.entries(parsed.inputs)) if (typeof value === "string") inputs[name] = value;
  }
  return {
    digest: typeof parsed.digest === "string" ? parsed.digest : "",
    completed: Array.isArray(parsed.completed) ? parsed.completed.filter((n): n is string => typeof n === "string") : [],
    failed: Array.isArray(parsed.failed) ? parsed.failed.filter((n): n is string => typeof n === "string") : [],
    outputs,
    ...(waves.length > 0 ? { waves } : {}),
    ...(isRecord(parsed.carried) && Object.keys(parsed.carried).length > 0 ? { carried: parsed.carried } : {}),
    ...(prApply ? { prApply } : {}),
    ...(inputs ? { inputs } : {}),
  };
}

/**
 * Written through a temporary file and a rename, so a process killed during the
 * write leaves the previous record whole rather than half a JSON document.
 */
export function writeFanOutAttempt(path: string, attempt: FanOutAttempt): void {
  writeWaveRecordFile(path, attempt);
}
