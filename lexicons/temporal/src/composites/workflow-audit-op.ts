/**
 * WorkflowAuditOp composite — the live supply-chain audit of GitHub workflows
 * as a chant Op + an optional TemporalSchedule (#292).
 *
 * The github post-synth checks (#286-#291) own everything answerable from the
 * deterministic build. This Op owns *only* the checks that require live
 * resolution against a moving upstream truth — stale SHA pins, impostor refs,
 * symbolic-ref confusion, pin/comment mismatch, advisories, archived upstreams.
 * It sits at **observe** on the lifecycle dial, with a finding-mode (mirroring
 * `ReconcileOp`: `report | issue | pull-request`) as the **reconcile** step.
 *
 * Runs one-shot on the local Op executor via `chant run`; on Temporal when a
 * `schedule` is given, for continuous re-audit between change windows.
 *
 * @example
 * ```typescript
 * // one-shot, local executor
 * export const { op } = WorkflowAuditOp({ name: "actions-audit" });
 *
 * // scheduled daily on Temporal, open a PR that bumps a stale pin
 * export const { op, schedule } = WorkflowAuditOp({
 *   name: "actions-audit",
 *   schedule: "0 6 * * *",
 *   onFinding: "pull-request",
 * });
 * ```
 *
 * @see #286 — the deterministic counterpart this freshens.
 */

import { Op, phase, activity, OpResource } from "@intentius/chant/op";
import { TemporalSchedule } from "../resources";
import type { WorkflowAuditMode } from "../op/activities/workflow-audit";

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export interface WorkflowAuditOpConfig {
  /** Op name (kebab-case). Used as workflow function name, task queue, schedule id base. */
  name: string;
  /**
   * Cron expression. When set, a TemporalSchedule fires the workflow for
   * continuous re-audit; omit for one-shot `chant run` on the local executor.
   */
  schedule?: string;
  /**
   * Directory of emitted workflow files to audit at run time.
   * @default ".github/workflows"
   */
  workflowsDir?: string;
  /**
   * What to produce on findings. Default: "report".
   * @default "report"
   */
  onFinding?: WorkflowAuditMode;
  /** Override the task queue. Defaults to `name`. */
  taskQueue?: string;
}

export interface WorkflowAuditOpResources {
  /** Op resource — generates the audit workflow on `chant build`. */
  op: InstanceType<typeof OpResource>;
  /** Temporal schedule, present only when `schedule` was given. */
  schedule?: InstanceType<typeof TemporalSchedule>;
}

export function WorkflowAuditOp(config: WorkflowAuditOpConfig): WorkflowAuditOpResources {
  const taskQueue = config.taskQueue ?? config.name;
  const onFinding = config.onFinding ?? "report";

  const op = Op({
    name: config.name,
    overview: "Resolve workflow action references against live upstreams and report supply-chain drift",
    taskQueue,
    searchAttributes: {
      Audit: "true",
      Surface: "github-workflows",
    },
    phases: [
      phase("Audit", [
        {
          kind: "activity",
          fn: "workflowSupplyChainAudit",
          args: { workflowsDir: config.workflowsDir ?? ".github/workflows", mode: onFinding },
          // Surface the finding count as a workflow-level search attribute so
          // "show me audits that found drift" is a one-filter UI query.
          outcomeAttribute: { name: "Findings", from: "findings" },
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
