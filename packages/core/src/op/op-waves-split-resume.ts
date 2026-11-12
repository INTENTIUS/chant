/**
 * How `chant run resume` starts a killed split apply again (#5052), on the
 * forges whose gate job's run locator alone does not do it.
 *
 * Under `approvals.remainder` (#5047) a split wave's gate job writes the
 * applied line, and its applying job is the one that may be killed. On
 * GitHub the line names the gate job's run, and a re-run of its failed jobs
 * runs the applying and record jobs again. GitLab retries one job by its id,
 * and the gate job knows only the names of the jobs after it; Forgejo has no
 * re-run and dispatches the workflow on the branch, which before merge is
 * not the decided head. So the generator tells the gate job, in
 * {@link OP_WAVES_RESUME_ENV}, what a resume needs:
 *
 * - GitLab: the names of the wave's applying jobs and its record job. The
 *   line's locator carries them as `retry`, and the resume retries the
 *   newest try of each applying job that failed or was cancelled, then the
 *   record job.
 * - Forgejo: the product's names of the dispatch inputs. The line's locator
 *   carries the run's own inputs (the decided head of a before-merge run,
 *   the wave and commit of a follow-on) as `inputs`, and the resume
 *   dispatches with them, so the new run plans the same commit and its gate
 *   job applies the rest under the same approval.
 *
 * Without the variable, the gate job's line names no run on those forges,
 * as before.
 */

import { BEFORE_MERGE_DIGEST_ENV, BEFORE_MERGE_HEAD_ENV, BEFORE_MERGE_PR_ENV } from "./before-merge";
import { OP_WAVES_COMMIT_ENV, OP_WAVES_WAVE_ENV } from "./follow-on-run";
import type { GateRunLocator } from "./gate-run-locator";
import type { OpWaveSplitJob } from "./op-waves-split";

export { OP_WAVES_SPLIT_RESUME_FLOOR } from "../release-floors";

/** The variable a split wave's gate job reads what a resume needs from, as JSON. */
export const OP_WAVES_RESUME_ENV = "CHANT_WAVES_RESUME";

/** The dispatch inputs a Forgejo resume fills, by chant's names. */
export type OpWaveResumeInput = "pr" | "head" | "digest" | "wave" | "commit";

/** What {@link OP_WAVES_RESUME_ENV} holds: GitLab's job names, or Forgejo's input names (each chant's own when left out). */
export interface OpWaveSplitResume {
  apply?: string[];
  record?: string;
  inputs?: Partial<Record<OpWaveResumeInput, string>>;
}

/**
 * The variable a split wave's gate job carries (#5052): on GitLab the names
 * of wave `gate.wave`'s applying jobs and its record job, on Forgejo the
 * product's dispatch input names. Empty on GitHub, whose re-run needs none,
 * and for a job that is no gate job.
 */
export function opWaveSplitResumeEnv(
  split: readonly Pick<OpWaveSplitJob, "jobName" | "phase" | "wave">[],
  gate: Pick<OpWaveSplitJob, "phase" | "wave">,
  forge: "github" | "forgejo" | "gitlab",
  inputs?: Partial<Record<OpWaveResumeInput, string>>,
): Record<string, string> {
  if (gate.phase !== "gate" || forge === "github") return {};
  if (forge === "forgejo") return { [OP_WAVES_RESUME_ENV]: JSON.stringify(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}) };
  const apply = split.filter((j) => j.wave === gate.wave && j.phase === "apply").map((j) => j.jobName);
  const record = split.find((j) => j.wave === gate.wave && j.phase === "record")?.jobName;
  return { [OP_WAVES_RESUME_ENV]: JSON.stringify({ apply, ...(record ? { record } : {}) }) };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Read {@link OP_WAVES_RESUME_ENV}; undefined when unset or not one. */
export function parseOpWaveSplitResume(raw: string | undefined): OpWaveSplitResume | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const apply = Array.isArray(o.apply) && o.apply.every((n) => typeof n === "string" && n.trim() !== "") ? (o.apply as string[]) : undefined;
  const record = typeof o.record === "string" && o.record.trim() !== "" ? o.record : undefined;
  const inputs =
    o.inputs && typeof o.inputs === "object" && !Array.isArray(o.inputs) && Object.entries(o.inputs).every(([k, n]) => ["pr", "head", "digest", "wave", "commit"].includes(k) && typeof n === "string" && NAME.test(n))
      ? (o.inputs as Partial<Record<OpWaveResumeInput, string>>)
      : undefined;
  return { ...(apply ? { apply } : {}), ...(record ? { record } : {}), ...(inputs ? { inputs } : {}) };
}

/**
 * The run locator a split wave's gate job writes on its applied line
 * (#5052), from its own locator and what {@link OP_WAVES_RESUME_ENV} says:
 * GitHub's as it is; GitLab's with `retry`, when the variable names applying
 * jobs; Forgejo's with the run's own dispatch inputs, when the variable is
 * set. Undefined where a resume could not start the applying jobs again.
 */
export function opWaveSplitResumeLocator(locator: GateRunLocator | undefined, env: Record<string, string | undefined> = process.env): GateRunLocator | undefined {
  if (!locator) return undefined;
  if (locator.forge === "github") return locator;
  const told = parseOpWaveSplitResume(env[OP_WAVES_RESUME_ENV]);
  if (!told) return undefined;
  if (locator.forge === "gitlab") return told.apply && told.apply.length > 0 ? { ...locator, retry: { apply: told.apply, ...(told.record ? { record: told.record } : {}) } } : undefined;
  const of: Record<OpWaveResumeInput, string> = { pr: BEFORE_MERGE_PR_ENV, head: BEFORE_MERGE_HEAD_ENV, digest: BEFORE_MERGE_DIGEST_ENV, wave: OP_WAVES_WAVE_ENV, commit: OP_WAVES_COMMIT_ENV };
  const inputs: Record<string, string> = {};
  for (const [input, variable] of Object.entries(of) as Array<[OpWaveResumeInput, string]>) {
    const value = env[variable]?.trim();
    if (value) inputs[told.inputs?.[input] ?? input] = value;
  }
  return { ...locator, inputs };
}
