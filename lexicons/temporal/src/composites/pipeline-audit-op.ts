/**
 * PipelineAuditOp composite — the live include/component audit of GitLab
 * pipelines as a chant Op + an optional TemporalSchedule (#303).
 *
 * The gitlab post-synth checks (#297) own everything answerable from the
 * deterministic build. This Op owns *only* the checks that require live
 * resolution against a moving upstream truth — a pinned component/include ref
 * that no longer resolves, an archived or moved upstream project, or a new
 * advisory covering a component/image in use. It sits at **observe** on the
 * lifecycle dial, with a finding-mode (`report | issue | merge-request`) as the
 * **reconcile** step — for GitLab the PR mode is a merge request.
 *
 * Runs one-shot on the local Op executor via `chant run`; on Temporal when a
 * `schedule` is given.
 *
 * @example
 * ```typescript
 * export const { op, schedule } = PipelineAuditOp({
 *   name: "pipeline-audit",
 *   schedule: "0 6 * * *",
 *   onFinding: "merge-request",
 * });
 * ```
 *
 * @see #297 — the deterministic counterpart this freshens.
 */

import { Op, phase, OpResource } from "@intentius/chant/op";
import { TemporalSchedule } from "../resources";
import type { PipelineAuditMode } from "../op/activities/pipeline-audit";

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export interface PipelineAuditOpConfig {
  /** Op name (kebab-case). Used as workflow function name, task queue, schedule id base. */
  name: string;
  /** Cron expression. When set, a TemporalSchedule fires the workflow; omit for one-shot. */
  schedule?: string;
  /**
   * Path to the emitted `.gitlab-ci.yml` to audit at run time.
   * @default ".gitlab-ci.yml"
   */
  pipelineFile?: string;
  /**
   * What to produce on findings. Default: "report".
   * @default "report"
   */
  onFinding?: PipelineAuditMode;
  /** Override the task queue. Defaults to `name`. */
  taskQueue?: string;
}

export interface PipelineAuditOpResources {
  /** Op resource — generates the audit workflow on `chant build`. */
  op: InstanceType<typeof OpResource>;
  /** Temporal schedule, present only when `schedule` was given. */
  schedule?: InstanceType<typeof TemporalSchedule>;
}

export function PipelineAuditOp(config: PipelineAuditOpConfig): PipelineAuditOpResources {
  const taskQueue = config.taskQueue ?? config.name;
  const onFinding = config.onFinding ?? "report";

  const op = Op({
    name: config.name,
    overview: "Resolve pipeline include/component/image references against live upstreams and report drift",
    taskQueue,
    searchAttributes: {
      Audit: "true",
      Surface: "gitlab-pipeline",
    },
    phases: [
      phase("Audit", [
        {
          kind: "activity",
          fn: "pipelineSupplyChainAudit",
          args: { pipelineFile: config.pipelineFile ?? ".gitlab-ci.yml", mode: onFinding },
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
