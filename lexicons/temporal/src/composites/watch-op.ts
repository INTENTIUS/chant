/**
 * WatchOp composite — periodic state observation via a chant Op + a
 * TemporalSchedule.
 *
 * Composes existing pieces:
 *   - The Op codegen (#7) emits a workflow that runs phases sequentially
 *   - The auto-emit search-attribute behavior (#28) tags each phase
 *   - The pre-built stateSnapshot + stateDiff activities (this commit)
 *   - TemporalSchedule fires the workflow on a cron schedule
 *
 * @example
 * ```typescript
 * export const { op, schedule } = WatchOp({
 *   name: "prod-watch",
 *   env: "prod",
 *   schedule: "0,15,30,45 * * * *", // every 15 minutes
 * });
 * ```
 *
 * @see #31 — Continuous observation (the issue this composite addresses)
 */

import { Op, phase, activity, OpResource } from "@intentius/chant/op";
import { TemporalSchedule } from "../resources";

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export interface WatchOpConfig {
  /**
   * Op name (kebab-case). Used as workflow function name (camelCase),
   * task queue, and schedule id base.
   */
  name: string;
  /** Environment to snapshot + diff (e.g. "prod"). */
  env: string;
  /**
   * Cron expression controlling how often the watch runs.
   * @example "0,15,30,45 * * * *" — every 15 minutes
   * @example "0 * * * *" — hourly
   */
  schedule: string;
  /**
   * Override the task queue. Defaults to `name`.
   */
  taskQueue?: string;
  /**
   * Run `chant state diff --live` (queries cloud APIs) instead of the
   * default digest-only diff. Recommended for real drift detection.
   * @default true
   */
  live?: boolean;
}

export interface WatchOpResources {
  /** Op resource — generates the snapshot+diff workflow on `chant build`. */
  op: InstanceType<typeof OpResource>;
  /** Temporal schedule that fires the workflow on the configured cron. */
  schedule: InstanceType<typeof TemporalSchedule>;
}

export function WatchOp(config: WatchOpConfig): WatchOpResources {
  const taskQueue = config.taskQueue ?? config.name;
  const live = config.live ?? true;

  const op = Op({
    name: config.name,
    overview: `Periodically snapshot and diff the ${config.env} environment`,
    taskQueue,
    searchAttributes: {
      Watch: "true",
      Env: config.env,
    },
    phases: [
      phase("Snapshot", [activity("stateSnapshot", { env: config.env })]),
      phase("Diff", [activity("stateDiff", { env: config.env, live })]),
    ],
  });

  const schedule = new TemporalSchedule({
    scheduleId: `${config.name}-schedule`,
    spec: { cronExpressions: [config.schedule] },
    action: {
      workflowType: kebabToCamel(config.name) + "Workflow",
      taskQueue,
    },
  } as Record<string, unknown>);

  return { op, schedule };
}
