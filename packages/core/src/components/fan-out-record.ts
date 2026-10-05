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
 */

import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readWaveRecords, type WaveRecord } from "../gated-waves";
import type { ChangeSetDocument } from "../change-set";
import type { PrMember } from "../pr-loop";

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
  return {
    op,
    gate,
    head,
    digest,
    approvedBy,
    members: members as unknown as PrMember[],
    changeSet: changeSet as unknown as ChangeSetDocument,
    planOutputs: outputs,
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
  return {
    digest: typeof parsed.digest === "string" ? parsed.digest : "",
    completed: Array.isArray(parsed.completed) ? parsed.completed.filter((n): n is string => typeof n === "string") : [],
    failed: Array.isArray(parsed.failed) ? parsed.failed.filter((n): n is string => typeof n === "string") : [],
    outputs,
    ...(waves.length > 0 ? { waves } : {}),
    ...(isRecord(parsed.carried) && Object.keys(parsed.carried).length > 0 ? { carried: parsed.carried } : {}),
    ...(prApply ? { prApply } : {}),
  };
}

/**
 * Written through a temporary file and a rename, so a process killed during the
 * write leaves the previous record whole rather than half a JSON document.
 */
export function writeFanOutAttempt(path: string, attempt: FanOutAttempt): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(attempt, null, 2) + "\n");
  renameSync(temporary, path);
}
