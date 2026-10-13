/**
 * A gate's checkpoint (#3947): the step outputs a run held when it stopped at
 * a gate that resumes, kept on `chant/lifecycle` at
 * `_gates/<op>/checkpoints/<runId>.json`.
 *
 * The run writes the file just before it appends the pending fact, and puts
 * the file's digest on that fact as `checkpointDigest`. `chant approve`
 * copies the digest onto the approval, the way it copies the plan digest, and
 * a seal covers it (`../workspace/trust/gate-seal.ts`). A later run that
 * resumes at the gate reads the file back and checks it against the digest
 * the approver saw, so a value pushed onto the branch after the approval is
 * refused rather than carried into the steps after the gate.
 *
 * Only the outputs some step after the gate references are stored, worked
 * out from the Op's references (`../op/gate-checkpoint.ts`). An output that
 * an activity contract marks secret is never stored: the gate doesn't
 * resume, and the next run starts at the first phase.
 *
 * Pure apart from the two git helpers at the bottom.
 */

import { canonicalJson } from "../effect-receipt";
import { contentDigest } from "../content-digest";
import { sortedJsonReplacer } from "../utils";
import { readBlobFromPath, writeBlobToPath } from "./git";

/** One gate checkpoint file. */
export interface GateCheckpoint {
  version: 1;
  /** The op the gate belongs to. */
  op: string;
  /** The gate's name. */
  gate: string;
  /** The run that stopped at the gate, and the file's name. The pending fact names the same run. */
  runId: string;
  /** The commit the run ran at. A resumed run must be at the same one. */
  commit: string;
  /** The environment the run was started for (`--env`), when it named one. */
  environment?: string;
  /** The plan the run reached the gate with, when the gate binds one. */
  planDigest?: string;
  /** Step id to the output that step returned, for each step a later step references. */
  outputs: Record<string, unknown>;
}

/** The prefix a checkpoint digest is written with: the JCS form of the file, hashed with SHA-256. */
export const CHECKPOINT_DIGEST_PREFIX = "jcs1-sha256:";

const CHECKPOINT_DIGEST_PATTERN = /^jcs1-sha256:[0-9a-f]{64}$/;

/** Whether `raw` is a checkpoint digest this code wrote. */
export function isCheckpointDigest(raw: unknown): raw is string {
  return typeof raw === "string" && CHECKPOINT_DIGEST_PATTERN.test(raw);
}

/** The digest of a checkpoint: SHA-256 over its RFC 8785 (JCS) form. Throws when an output can't be put in JSON. */
export function gateCheckpointDigest(checkpoint: GateCheckpoint): string {
  return CHECKPOINT_DIGEST_PREFIX + contentDigest(canonicalJson(checkpoint)).slice("sha256:".length);
}

/**
 * A run id is the checkpoint's file name, so it may hold only letters,
 * digits, `.`, `_` and `-`, and may not start with a dot. A run named
 * otherwise (a caller-chosen id with a slash in it) gets no checkpoint.
 */
export function isCheckpointRunId(runId: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(runId) && runId.length <= 200;
}

/** Where the checkpoint of `runId` lives on `chant/lifecycle`: the directory and the file, as `writeBlobToPath` takes them. */
export function gateCheckpointPath(op: string, runId: string): { dir: string; file: string } {
  return { dir: `_gates/${op}/checkpoints`, file: `${runId}.json` };
}

/** The file's text: the checkpoint as JSON, keys sorted, one value per line. */
export function gateCheckpointText(checkpoint: GateCheckpoint): string {
  return `${JSON.stringify(checkpoint, sortedJsonReplacer, 2)}\n`;
}

/**
 * Put `outputs` in the form a checkpoint stores: each value as JSON would
 * carry it. Returns the step whose output JSON can't hold (a cycle, a bigint)
 * instead, so the caller can say which one blocks the gate's resume.
 */
export function checkpointOutputs(outputs: ReadonlyMap<string, unknown>, ids: readonly string[]): { outputs: Record<string, unknown> } | { unstorable: string } {
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    if (!outputs.has(id)) continue;
    const value = outputs.get(id);
    try {
      const text = JSON.stringify(value === undefined ? null : value);
      const parsed: unknown = JSON.parse(text);
      canonicalJson(parsed);
      out[id] = parsed;
    } catch {
      return { unstorable: id };
    }
  }
  return { outputs: out };
}

/** A checkpoint file's text read back, or null when it isn't one. */
export function parseGateCheckpoint(text: string): GateCheckpoint | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw as Partial<GateCheckpoint> | null;
  if (
    r === null || typeof r !== "object" || r.version !== 1 || typeof r.op !== "string" || typeof r.gate !== "string" ||
    typeof r.runId !== "string" || typeof r.commit !== "string" ||
    r.outputs === null || typeof r.outputs !== "object" || Array.isArray(r.outputs) ||
    (r.environment !== undefined && typeof r.environment !== "string") ||
    (r.planDigest !== undefined && typeof r.planDigest !== "string")
  ) {
    return null;
  }
  return r as GateCheckpoint;
}

/** Write a checkpoint to the local `chant/lifecycle` branch. Does not push: the pending fact appended after it does. */
export async function writeGateCheckpoint(checkpoint: GateCheckpoint, opts?: { cwd?: string }): Promise<void> {
  const { dir, file } = gateCheckpointPath(checkpoint.op, checkpoint.runId);
  await writeBlobToPath(dir, file, gateCheckpointText(checkpoint), `Gate checkpoint for ${checkpoint.gate}`, opts);
}

/** The text of `runId`'s checkpoint for `op`, or null when there is none. */
export async function readGateCheckpointText(op: string, runId: string, opts?: { cwd?: string }): Promise<string | null> {
  const { dir, file } = gateCheckpointPath(op, runId);
  return readBlobFromPath(dir, file, opts);
}
