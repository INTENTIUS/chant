/**
 * The built-in `local` op runtime (#2121, epic #2114).
 *
 * Wraps `runOpLocally` (../local-executor.ts) in the {@link OpRuntimeProvider}
 * contract so `chant run <op>` has one dispatch path whether the run is hosted
 * here or by a lexicon's `opRuntime`. Behaviour is the executor's, unchanged:
 * activities and profiles come from the project's configured lexicons, a gate
 * is decided against the gate ledger and ends the run `gated` (#2119), and
 * Ctrl-C aborts through the caller's `AbortSignal`.
 *
 * Status, log and list read the run ledger (#2118): every run this provider
 * starts appends one `OpRunRecord` to `<env>/runs__<op>.jsonl` on the
 * lifecycle branch, so an answer here outlives the process that produced it
 * and a run started by cron, CI or another machine is visible too. The
 * in-memory history stays as the fallback for the case the ledger cannot cover
 * — a project that is not a checkout, or a run whose append failed — so a
 * `chant run` followed by `chant run status` in the same process still
 * answers.
 */

import { loadChantConfig } from "../../config";
import { loadActivities, loadProfiles } from "../activity-registry";
import { runOpLocally, OpRunFailure, type OpRunResult } from "../local-executor";
import { runComponents } from "../../components/cli-support";
import { discoverOps } from "../discover";
import { readRunLedger, runEnvOf, DEFAULT_RUN_ENV } from "../../lifecycle/run-ledger";
import type { OpConfig } from "../types";
import {
  runStateOf,
  type OpRunHandle,
  type OpRunRecord,
  type OpRunStartOptions,
  type OpRunStatus,
  type OpRuntimeProvider,
} from "../runtime";

/** Every run this process has started, newest last, keyed by op name. */
type RunLog = Map<string, OpRunStatus[]>;

function statusFrom(
  op: string,
  runId: string,
  startedAt: string,
  result: OpRunResult,
): OpRunStatus {
  return {
    op,
    runId,
    state: runStateOf(result.status),
    startedAt,
    endedAt: new Date().toISOString(),
    records: result.records,
    result,
    ...(result.gate ? { gate: { name: result.gate.gate, since: result.gate.timestamp } } : {}),
  };
}

/**
 * A ledger record read back as a runtime status. `records` and `result` are
 * absent on purpose: the ledger keeps each step's verdict, not the activity
 * return values a live `OpRunResult` carries, and inventing them would make a
 * replayed answer look like a live one.
 */
function statusFromRecord(record: OpRunRecord): OpRunStatus {
  return {
    op: record.op,
    runId: record.id,
    state: runStateOf(record.status),
    startedAt: record.started,
    endedAt: record.ended,
    ...(record.gate ? { gate: record.gate } : {}),
  };
}

/**
 * Build the local provider. `projectPath` is where `chant.config.ts` is read
 * from to decide which cloud appliers to load — the same best-effort read the
 * CLI did inline before the seam existed.
 */
export function createLocalOpRuntime(opts: { projectPath?: string } = {}): OpRuntimeProvider {
  const runs: RunLog = new Map();
  const projectPath = opts.projectPath ?? process.cwd();

  const record = (status: OpRunStatus): void => {
    const existing = runs.get(status.op);
    if (existing) existing.push(status);
    else runs.set(status.op, [status]);
  };

  // A run ledger is keyed `<env>/runs__<op>.jsonl`, and `status`/`log` are
  // handed a name rather than a config. `start` and `list` know the config and
  // seed this; otherwise the same `*.op.ts` scan that found the Op in the
  // first place resolves its `labels.Env`.
  const envs = new Map<string, string>();
  const noteEnv = (op: OpConfig): string => {
    const env = runEnvOf(op);
    envs.set(op.name, env);
    return env;
  };

  const envFor = async (op: string): Promise<string> => {
    const known = envs.get(op);
    if (known) return known;
    try {
      const { ops } = await discoverOps({ cwd: projectPath });
      for (const discovered of ops.values()) noteEnv(discovered.config);
    } catch {
      // Not a checkout — nothing to scan; fall through to the default env.
    }
    return envs.get(op) ?? DEFAULT_RUN_ENV;
  };

  /** This op's ledger history, oldest first. Empty when there is no ledger to read. */
  const ledgerFor = async (op: string, env?: string): Promise<OpRunRecord[]> => {
    try {
      const { records } = await readRunLedger(env ?? (await envFor(op)), op, { cwd: projectPath });
      return records;
    } catch {
      return [];
    }
  };

  return {
    name: "local",

    async start(op: OpConfig, startOpts: OpRunStartOptions): Promise<OpRunHandle> {
      // The project's configured lexicons decide which cloud appliers to load
      // (aws -> floci, gcp -> gcpApply, azure -> az group). Best-effort: an
      // unreadable config just yields the base activities.
      let lexicons: string[] = [];
      try {
        lexicons = (await loadChantConfig(projectPath)).config.lexicons ?? [];
      } catch {
        // No/invalid chant.config — base activities only.
      }

      const [activities, profiles] = await Promise.all([loadActivities(lexicons), loadProfiles()]);

      const runId = `local-${Date.now()}`;
      const startedAt = new Date().toISOString();
      noteEnv(op);

      const settled = (async (): Promise<OpRunStatus> => {
        try {
          const result = await runOpLocally(
            op,
            activities,
            profiles,
            startOpts.signal,
            {
              runId,
              // The run's outcome is a durable fact (#2118): the executor
              // appends it here, at the one seam every local run passes
              // through, rather than in the CLI handler above it.
              ledger: { cwd: projectPath },
              // #2301: the run-ledger append goes through the same
              // `chant/lifecycle` write as the gate does, so it dies for the
              // same reasons — and this runtime declared no sink for it, so
              // the failure was caught by `settle` and dropped on the floor.
              // A run whose outcome never reached the ledger says so now;
              // `chant run status` and `chant run log` will not have it.
              onLedgerError: (err) =>
                process.stderr.write(
                  `warning: run "${runId}" of "${op.name}" finished, but its record could not be ` +
                    `appended to the run ledger: ${err instanceof Error ? err.message : String(err)}\n`,
                ),
              ...(startOpts.progress ? { onRecord: startOpts.progress } : {}),
            },
          );
          const status = statusFrom(op.name, runId, startedAt, result);
          record(status);
          return status;
        } catch (err) {
          if (err instanceof OpRunFailure) {
            const status = statusFrom(op.name, runId, startedAt, err.result);
            record(status);
            return status;
          }
          throw err;
        }
      })();

      return { op: op.name, runId, result: () => settled };
    },

    async status(op: string): Promise<OpRunStatus | undefined> {
      const newest = (await ledgerFor(op)).at(-1);
      if (newest) return statusFromRecord(newest);
      const history = runs.get(op);
      return history?.[history.length - 1];
    },

    async log(op: string, logOpts?: { limit?: number }): Promise<OpRunRecord[]> {
      const history = (await ledgerFor(op)).reverse();
      return logOpts?.limit === undefined ? history : history.slice(0, logOpts.limit);
    },

    async list(ops: OpConfig[]): Promise<Map<string, OpRunStatus | undefined>> {
      const out = new Map<string, OpRunStatus | undefined>();
      for (const op of ops) {
        const newest = (await ledgerFor(op.name, noteEnv(op))).at(-1);
        if (newest) {
          out.set(op.name, statusFromRecord(newest));
          continue;
        }
        const history = runs.get(op.name);
        out.set(op.name, history?.[history.length - 1]);
      }
      return out;
    },

    async cancel(op: string): Promise<void> {
      throw new Error(
        `the local runtime runs "${op}" in the foreground — there is no detached run to cancel. ` +
          `Press Ctrl-C in the terminal running it, or pass --on <lexicon> for a hosted run.`,
      );
    },

    runComponents(path, selector, options) {
      return runComponents(path, selector, options);
    },
  };
}
