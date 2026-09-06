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
 * Runs one-shot on the local Op executor for a `chant run`; with a `schedule`
 * the cadence rides on the Op itself (#2120) for whichever runtime honours it.
 *
 * @example
 * ```typescript
 * // one-shot, local executor
 * export const { op } = ReconcileOp({ name: "prod-reconcile", env: "prod" });
 *
 * // hourly
 * export const { op } = ReconcileOp({
 *   name: "prod-reconcile",
 *   env: "prod",
 *   schedule: "0 * * * *",
 *   scope: { owned: true },
 * });
 * ```
 *
 * @see #112 — stateless-authoritative state model + live import
 */

import { Op, phase, activity } from "../builders";
import type { OpResource } from "../resource";
import type { ReconcileMode } from "../activities/reconcile";

export interface ReconcileOpConfig {
  /** Op name (kebab-case). Also the generated workflow function name, camelCased. */
  name: string;
  /** Environment to reconcile (e.g. "prod"). */
  env: string;
  /**
   * Cron expression. When set, it lands on the Op as `schedule`; omit for
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
}

export interface ReconcileOpResources {
  /** Op resource — generates the snapshot→plan→regenerate→PR workflow. */
  op: InstanceType<typeof OpResource>;
}

export function ReconcileOp(config: ReconcileOpConfig): ReconcileOpResources {
  const onDrift = config.onDrift ?? "pull-request";
  const owned = config.scope?.owned ?? false;

  // The reconcile's headline output is the opened PR (or issue) URL. Expose it as
  // an outcome attribute so it prints in `chant run` and lands on the ledger.
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
    labels: {
      Reconcile: "true",
      Env: config.env,
    },
    ...(config.schedule ? { schedule: { cron: config.schedule, overlap: "skip" as const } } : {}),
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
        // opened PR/issue URL as an outcome so `chant run` prints it — the
        // reconcile's result is the link.
        {
          kind: "activity" as const,
          fn: "reconcilePr",
          args: { env: config.env, mode: onDrift, owned },
          ...(reconcileOutcome ? { outcomeAttribute: reconcileOutcome } : {}),
        },
      ]),
    ],
  });

  return { op };
}
