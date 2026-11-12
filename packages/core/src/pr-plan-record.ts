/**
 * A product plan job's run record (#4899), as the note job reads it from the
 * hand-off and keeps it on `chant/lifecycle`.
 *
 * `chant ci run plan --in-place` records a `pr-plan` job as Op `pr-plan` in
 * the run ledger (`<env>/runs__pr-plan.jsonl`). A product's plan verb runs
 * without `ci run`, and its plan job holds no token to push with, so its plan
 * step writes the record into `.chant/pr/run-record.json`
 * (`PLAN_RECORD_JS` in ./components/product-plan.ts) and the note job,
 * which holds the token, appends it (`pr-post --record-run <plan job>`).
 *
 * The record is the change's: the plan job runs its code. So it is read as
 * data, as the report is (./pr-post.ts). The note job keeps the record's id,
 * its times and the plan verb's exit code, and fills the op, environment,
 * labels, commit, run origin and status from what it knows itself. A record
 * that names another op, environment, target or commit is refused, and a
 * plan job that failed records a failed run whatever the record says.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpRunRecordInput } from "./op/runtime";
import type { RunOrigin } from "./lifecycle/release-ledger";

/** The record's file under the hand-off directory: `PLAN_RUN_RECORD_FILE` in ./components/product-plan.ts. */
export const PLAN_RUN_RECORD_FILE = "run-record.json";

/** The op a product plan job's run is recorded under: `pr-plan`'s. */
export const PLAN_RUN_OP = "pr-plan";

/** What the note job knows of the plan job it records. */
export interface PlanRunExpect {
  /** The pipeline's environment, `--env`. */
  env: string;
  /** The pull request's head, `--head`. */
  head: string;
  /** The commit the plan job checked out when it is not `head` (#5020): a GitHub `pull_request` run's merge preview. */
  planned?: string;
  /** The target, `--member`. */
  target?: string;
  /** The plan job's result as the forge says it (`needs.<job>.result`, GitLab's job status). */
  result?: string;
  /** The plan job's run, as the note job names it. */
  origin?: RunOrigin;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;

function instant(v: unknown): string | undefined {
  return typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : undefined;
}

/**
 * The run record to keep for the plan job, read from `dir`, or why it is
 * refused; undefined when the plan job wrote none.
 */
export function readPlanRunRecord(dir: string, expect: PlanRunExpect): { record: OpRunRecordInput } | { refused: string } | undefined {
  const file = join(dir, PLAN_RUN_RECORD_FILE);
  if (!existsSync(file)) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    return { refused: `the run record does not read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { refused: "the run record is not an object" };
  const r = doc as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id)) return { refused: "the run record's id is not a UUID" };
  if (r.op !== PLAN_RUN_OP) return { refused: `the run record is for op ${JSON.stringify(r.op)}, not ${PLAN_RUN_OP}` };
  if (r.env !== expect.env) return { refused: `the run record is for environment ${JSON.stringify(r.env)}, not ${expect.env}` };
  const labels = r.labels && typeof r.labels === "object" && !Array.isArray(r.labels) ? (r.labels as Record<string, unknown>) : {};
  if ((labels.Target ?? undefined) !== expect.target) return { refused: `the run record is for target ${JSON.stringify(labels.Target ?? null)}, not ${JSON.stringify(expect.target ?? null)}` };
  if (r.gitSha !== undefined && r.gitSha !== expect.head && r.gitSha !== expect.planned) return { refused: `the run record is for commit ${JSON.stringify(r.gitSha)}, not ${expect.head}` };
  if (!SHA.test(expect.head)) return { refused: `the head ${JSON.stringify(expect.head)} is not a full commit` };
  const started = instant(r.started);
  const ended = instant(r.ended);
  if (!started || !ended || Date.parse(ended) < Date.parse(started)) return { refused: "the run record's start and end are not times in order" };
  const failure = r.failure && typeof r.failure === "object" ? (r.failure as Record<string, unknown>) : undefined;
  const exitCode = typeof failure?.exitCode === "number" && Number.isInteger(failure.exitCode) && failure.exitCode > 0 && failure.exitCode < 256 ? failure.exitCode : undefined;
  const failedJob = expect.result === "failure" || expect.result === "cancelled";
  const failed = failedJob || r.status !== "ok" || exitCode !== undefined;
  const status = failed ? "fail" : "ok";
  const durationMs = Date.parse(ended) - Date.parse(started);
  return {
    record: {
      id: r.id,
      op: PLAN_RUN_OP,
      env: expect.env,
      started,
      ended,
      status,
      labels: { Env: expect.env, Pipeline: "pr", Job: "plan", ...(expect.target ? { Target: expect.target } : {}) },
      outcomes: {},
      phases: [{ name: "plan", status, steps: [{ fn: "shellCmd", status, durationMs, ...(failed ? { error: exitCode !== undefined ? `command exited ${exitCode}` : "the plan job failed" } : {}) }] }],
      gitSha: expect.head,
      ...(expect.origin ? { runOrigin: expect.origin } : {}),
      ...(failed
        ? { failure: { code: "command-failed", reason: exitCode !== undefined ? `the plan verb exited ${exitCode}` : "the plan job failed", phase: "plan", ...(exitCode !== undefined ? { exitCode } : {}) } }
        : {}),
    },
  };
}
