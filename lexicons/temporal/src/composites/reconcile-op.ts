/**
 * ReconcileOp composite — the cloud → code workflow as an Op.
 *
 * Keeps source tracking reality: when live drifts from declarations, open a PR
 * that regenerates the affected TypeScript. Mirrors the {@link WatchOp} shape.
 *
 * Phases: snapshot → plan → regenerate (live import) → open PR. The
 * regenerate-and-PR step is the `reconcilePr` activity (#122), which derives
 * the change set from `chant lifecycle plan` and opens a reviewable PR.
 *
 * Runs on the local Op executor for a one-shot `chant run`; on Temporal when a
 * `schedule` is given (the cron + run history are the value, as with WatchOp).
 *
 * @example
 * ```typescript
 * // one-shot, local executor
 * export const { op } = ReconcileOp({ name: "prod-reconcile", env: "prod" });
 *
 * // scheduled on Temporal
 * export const { op, schedule } = ReconcileOp({
 *   name: "prod-reconcile",
 *   env: "prod",
 *   schedule: "0 * * * *",        // hourly
 *   scope: { owned: true },
 * });
 * ```
 *
 * @see #112 — stateless-authoritative state model + live import
 */

import { Op, phase, activity, OpResource } from "@intentius/chant/op";
import { TemporalSchedule } from "../resources";
import type { ReconcileMode } from "../op/activities/reconcile";

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export interface ReconcileOpConfig {
  /** Op name (kebab-case). Used as workflow function name, task queue, schedule id base. */
  name: string;
  /** Environment to reconcile (e.g. "prod"). */
  env: string;
  /**
   * Cron expression. When set, a TemporalSchedule fires the workflow; omit for
   * one-shot `chant run` on the local executor.
   */
  schedule?: string;
  /**
   * What to produce on drift. Default: "pull-request".
   * @default "pull-request"
   */
  onDrift?: ReconcileMode;
  /** Restrict reconciliation to chant-owned resources. */
  scope?: { owned?: boolean };
  /** Override the task queue. Defaults to `name`. */
  taskQueue?: string;
}

export interface ReconcileOpResources {
  /** Op resource — generates the snapshot→plan→regenerate→PR workflow. */
  op: InstanceType<typeof OpResource>;
  /** Temporal schedule, present only when `schedule` was given. */
  schedule?: InstanceType<typeof TemporalSchedule>;
}

export function ReconcileOp(config: ReconcileOpConfig): ReconcileOpResources {
  const taskQueue = config.taskQueue ?? config.name;
  const onDrift = config.onDrift ?? "pull-request";
  const owned = config.scope?.owned ?? false;

  // The reconcile's headline output is the opened PR (or issue) URL. Expose it as
  // an outcome attribute so it prints in `chant run` and is queryable on Temporal.
  // `report` mode opens nothing, so it has no URL outcome.
  const reconcileOutcome =
    onDrift === "pull-request"
      ? { name: "PR", from: "prUrl" }
      : onDrift === "issue"
        ? { name: "Issue", from: "issueUrl" }
        : undefined;

  const op = Op({
    name: config.name,
    overview: `Reconcile the ${config.env} environment into source (cloud → code)`,
    taskQueue,
    searchAttributes: {
      Reconcile: "true",
      Env: config.env,
    },
    phases: [
      phase("Snapshot", [activity("lifecycleSnapshot", { env: config.env })]),
      phase("Plan", [
        {
          kind: "activity",
          fn: "lifecycleDiff",
          args: { env: config.env, live: true },
          outcomeAttribute: { name: "Drift", from: "drifted" },
        },
      ]),
      phase("Reconcile", [
        // reconcilePr derives the change set from `chant lifecycle plan`,
        // regenerates via `chant import --from`, and opens a PR. Surface the
        // opened PR/issue URL as an outcome so `chant run` prints it and it lands
        // as a Temporal search attribute — the reconcile's result is the link.
        {
          kind: "activity" as const,
          fn: "reconcilePr",
          args: { env: config.env, mode: onDrift, owned },
          ...(reconcileOutcome ? { outcomeAttribute: reconcileOutcome } : {}),
        },
      ]),
    ],
  });

  if (!config.schedule) {
    return { op };
  }

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
