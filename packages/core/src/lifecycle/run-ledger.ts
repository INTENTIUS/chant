/**
 * Op run ledger (#2118, epic #2114) — one immutable record per Op run, on the
 * `chant/lifecycle` orphan branch, modelled on `./converge-ledger.ts` down to
 * the CAS-retry loop and the "skip a malformed line, count it" reader.
 *
 * ## Why an Op run leaves a record at all
 *
 * `OpConfig` used to carry `searchAttributes`, and the generated orchestrator
 * code upserted `Phase`, `Drift`, `Approver` and `RollbackFailed` into them as
 * it ran. Those are not properties of the declaration — they are facts about
 * one run, and they only existed while a cluster held the run's history. Ops
 * now run on whatever runtime `chant run --on`
 * selects (#2121), including the plain in-process one, so the outcome has to
 * be durable somewhere chant owns. Here. What stayed on the declaration is
 * `OpConfig.labels`, the discovery half of the same field, and it is copied
 * onto every record so a reader can filter runs the way it filters
 * declarations.
 *
 * The record shape itself lives in `../op/runtime.ts`, beside the provider
 * contract that reads it back: this is the ledger, not the vocabulary.
 *
 * ## Storage
 *
 * `<env>/runs__<op>.jsonl`, beside `<env>/converge.jsonl`. The `runs__`
 * prefix folds what would read as a `runs/` subdirectory into one path
 * segment: `writeBlobToPath` (./git.ts) builds the orphan branch's tree with
 * `git mktree` over a flat `<env>/<file>` layout, and mktree rejects a slash
 * in an entry name outright, so a genuine third level would mean rewriting
 * that function's tree assembly. `__` is the same separator `./git.ts`'s
 * `snapshotKey` already uses to fold a stack name into a flat blob name.
 *
 * Per-op rather than one file per env because a run ledger's reader almost
 * always wants one op's history (`chant run <op>`'s own record, the local
 * runtime's `status`/`log`), and an env with a busy op should not make every
 * other op's read proportional to it.
 */
import { randomUUID } from "node:crypto";
import { sortedJsonReplacer } from "../utils";
import type { OpConfig } from "../op/types";
import type { StepRecord } from "../op/local-executor";
import type { OpRunRecord, OpRunRecordInput, OpRunPhaseRecord, OpRunStepRecord } from "../op/runtime";
import { readBlobFromPath, readPathSha, readBlobBySha, writeBlobToPath, RefCASConflictError } from "./git";

/** Prefix folding the per-op run ledgers into one flat name under `<env>/`. See the module doc. */
const PREFIX = "runs__";

/** Read-modify-append retry budget, same shape and reasoning as `appendConvergeRecord`'s. */
const APPEND_RETRY_ATTEMPTS = 5;

/** The env a run records against when its Op declares no `labels.Env`. */
export const DEFAULT_RUN_ENV = "local";

function fileFor(op: string): string {
  return `${PREFIX}${op}.jsonl`;
}

/** The env a run records against: the Op's own `labels.Env`, else {@link DEFAULT_RUN_ENV}. */
export function runEnvOf(config: Pick<OpConfig, "labels">): string {
  return config.labels?.Env ?? DEFAULT_RUN_ENV;
}

function phaseStatus(steps: OpRunStepRecord[]): OpRunPhaseRecord["status"] {
  if (steps.some((s) => s.status === "fail")) return "fail";
  if (steps.length > 0 && steps.every((s) => s.status === "skipped")) return "skipped";
  return "ok";
}

/**
 * Fold a run's step records into the ledger shape, pure — no clock, no git.
 * `started`/`ended` are supplied by the caller for the same reason
 * `ConvergeTickRecord.timestamp` is: library code here never calls
 * `Date.now()` itself.
 *
 * Phases are grouped by `StepRecord.phase` in first-seen order, which is
 * execution order for the sequential path and the authored order for a
 * parallel one. A compensation (`onFailure`) phase appears after the phase
 * that failed, exactly where the executor emitted its records.
 */
export function buildRunRecord(
  config: Pick<OpConfig, "name" | "labels">,
  records: readonly StepRecord[],
  times: {
    started: string;
    ended: string;
    status: OpRunRecord["status"];
    id?: string;
    gate?: OpRunRecord["gate"];
  },
): OpRunRecordInput {
  const phases: OpRunPhaseRecord[] = [];
  const byName = new Map<string, OpRunPhaseRecord>();
  const outcomes: Record<string, unknown> = {};

  for (const record of records) {
    let phase = byName.get(record.phase);
    if (!phase) {
      phase = { name: record.phase, status: "ok", steps: [] };
      byName.set(record.phase, phase);
      phases.push(phase);
    }
    phase.steps.push({
      fn: record.fn,
      status: record.status,
      durationMs: record.durationMs,
      ...(record.outcome ? { outcome: record.outcome } : {}),
      ...(record.approval ? { approval: record.approval } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    });
    if (record.outcome) outcomes[record.outcome.name] = record.outcome.value;
  }
  for (const phase of phases) phase.status = phaseStatus(phase.steps);

  return {
    ...(times.id !== undefined ? { id: times.id } : {}),
    op: config.name,
    env: runEnvOf(config),
    started: times.started,
    ended: times.ended,
    status: times.status,
    labels: { ...(config.labels ?? {}) },
    outcomes,
    phases,
    ...(times.gate ? { gate: times.gate } : {}),
  };
}

/**
 * Append one immutable run record. Does not push to the remote — call
 * `pushLifecycle` (./git.ts) afterward, the two-step shape every ledger here
 * uses.
 *
 * Mints `record.id` when the input carries none, and retries the whole
 * read-modify-write on `RefCASConflictError` re-reading fresh each attempt —
 * see `appendConvergeRecord`'s doc for why both of those live in the append
 * function rather than in its callers.
 */
export async function appendRunRecord(
  input: OpRunRecordInput,
  opts?: { cwd?: string },
): Promise<{ commit: string; record: OpRunRecord }> {
  const record: OpRunRecord = { version: 1, ...input, id: input.id ?? randomUUID() };
  const json = JSON.stringify(record, sortedJsonReplacer);
  const filename = fileFor(record.op);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= APPEND_RETRY_ATTEMPTS; attempt++) {
    try {
      const priorSha = await readPathSha(record.env, filename, opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const content = existing ? `${existing.replace(/\n$/, "")}\n${json}` : json;
      const commit = await writeBlobToPath(record.env, filename, content, `Op run record: ${record.op}`, {
        ...opts,
        expectPriorPathSha: priorSha,
      });
      return { commit, record };
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Read every run record for `op` in `environment`, oldest first. Malformed
 * lines are skipped and counted, never thrown on — a hand-edited or truncated
 * ledger degrades to a shorter history, the stance every ledger here takes.
 */
export async function readRunLedger(
  environment: string,
  op: string,
  opts?: { cwd?: string },
): Promise<{ records: OpRunRecord[]; malformed: number }> {
  const content = await readBlobFromPath(environment, fileFor(op), opts);
  if (!content) return { records: [], malformed: 0 };

  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const records: OpRunRecord[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Partial<OpRunRecord>;
      if (
        parsed.version !== 1 ||
        typeof parsed.op !== "string" ||
        typeof parsed.env !== "string" ||
        typeof parsed.started !== "string" ||
        typeof parsed.ended !== "string" ||
        typeof parsed.status !== "string" ||
        !Array.isArray(parsed.phases)
      ) {
        malformed++;
        continue;
      }
      records.push(parsed as OpRunRecord);
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}
