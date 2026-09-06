/**
 * The built-in `local` op runtime (#2121, epic #2114).
 *
 * Wraps `runOpLocally` (../local-executor.ts) in the {@link OpRuntimeProvider}
 * contract so `chant run <op>` has one dispatch path whether the run is hosted
 * here or by a lexicon's `opRuntime`. Behaviour is the executor's, unchanged:
 * activities and profiles come from the project's configured lexicons, a gate
 * is still refused up front (gate-as-fact is #2119), and Ctrl-C aborts through
 * the caller's `AbortSignal`.
 *
 * Status, log and list are derived from the `OpRunResult` this process
 * produced, held in memory for the lifetime of the process. #2118 owns the
 * ledger-backed shape; reconcile at merge — at that point these three read the
 * run ledger and survive the process instead.
 */

import { loadChantConfig } from "../../config";
import { loadActivities, loadProfiles } from "../activity-registry";
import {
  runOpLocally,
  findGate,
  LocalGateUnsupportedError,
  OpRunFailure,
  type OpRunResult,
} from "../local-executor";
import { runComponents } from "../../components/cli-support";
import type { OpConfig } from "../types";
import type {
  OpRunHandle,
  OpRunRecord,
  OpRunStartOptions,
  OpRunStatus,
  OpRuntimeProvider,
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
    state: result.ok ? "completed" : "failed",
    startedAt,
    endedAt: new Date().toISOString(),
    records: result.records,
    result,
  };
}

function toRecord(status: OpRunStatus): OpRunRecord {
  return {
    op: status.op,
    runId: status.runId,
    state: status.state,
    startedAt: status.startedAt,
    ...(status.endedAt ? { endedAt: status.endedAt } : {}),
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

  return {
    name: "local",

    async start(op: OpConfig, startOpts: OpRunStartOptions): Promise<OpRunHandle> {
      // Gates need a durable fact, not an in-process wait. Refused before any
      // step runs, with the executor's own message (#2119 replaces this with a
      // pending-gate fact and a `gated` run state).
      const gate = findGate(op);
      if (gate) throw new LocalGateUnsupportedError(gate.signalName);

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

      const settled = (async (): Promise<OpRunStatus> => {
        try {
          const result = await runOpLocally(
            op,
            activities,
            profiles,
            startOpts.signal,
            startOpts.progress,
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
      const history = runs.get(op);
      return history?.[history.length - 1];
    },

    async log(op: string, logOpts?: { limit?: number }): Promise<OpRunRecord[]> {
      const history = [...(runs.get(op) ?? [])].reverse().map(toRecord);
      return logOpts?.limit === undefined ? history : history.slice(0, logOpts.limit);
    },

    async list(ops: OpConfig[]): Promise<Map<string, OpRunStatus | undefined>> {
      const out = new Map<string, OpRunStatus | undefined>();
      for (const op of ops) {
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
