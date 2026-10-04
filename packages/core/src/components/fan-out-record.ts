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
 */

import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readWaveRecords, type WaveRecord } from "../gated-waves";

export interface FanOutAttempt {
  digest: string;
  completed: string[];
  failed: string[];
  outputs: Record<string, Record<string, unknown>>;
  /** Gated-wave fan-outs only (#3049). */
  waves?: WaveRecord[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read an attempt record, or `undefined` when there is none yet. Throws on a file that is not JSON. */
export function readFanOutAttempt(path: string): FanOutAttempt | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FanOutAttempt>;
  const outputs: Record<string, Record<string, unknown>> = {};
  if (isRecord(parsed.outputs)) {
    for (const [name, value] of Object.entries(parsed.outputs)) if (isRecord(value)) outputs[name] = value;
  }
  const waves = readWaveRecords(parsed.waves);
  return {
    digest: typeof parsed.digest === "string" ? parsed.digest : "",
    completed: Array.isArray(parsed.completed) ? parsed.completed.filter((n): n is string => typeof n === "string") : [],
    failed: Array.isArray(parsed.failed) ? parsed.failed.filter((n): n is string => typeof n === "string") : [],
    outputs,
    ...(waves.length > 0 ? { waves } : {}),
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
