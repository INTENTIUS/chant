/**
 * PipelineAuditOp composite — the live include/component audit of GitLab
 * pipelines as a chant Op with an optional schedule (#303).
 *
 * The gitlab post-synth checks (#297) own everything answerable from the
 * deterministic build. This Op owns *only* the checks that require live
 * resolution against a moving upstream truth — a pinned component/include ref
 * that no longer resolves, an archived or moved upstream project, or a new
 * advisory covering a component/image in use. It sits at **observe** on the
 * lifecycle dial, with a finding-mode (`report | issue | merge-request`) as the
 * **reconcile** step — for GitLab the PR mode is a merge request.
 *
 * Runs one-shot on the local Op executor via `chant run`; a `schedule` puts
 * the cadence on the Op itself (#2120).
 *
 * @example
 * ```typescript
 * export const { op } = PipelineAuditOp({
 *   name: "pipeline-audit",
 *   schedule: "0 6 * * *",
 *   onFinding: "merge-request",
 * });
 * ```
 *
 * @see #297 — the deterministic counterpart this freshens.
 */

import { Op, phase } from "../builders";
import type { OpResource } from "../resource";
import type { PipelineAuditMode } from "../activities/pipeline-audit";

export interface PipelineAuditOpConfig {
  /** Op name (kebab-case). Names the Op's output directory and is what `chant run` takes. */
  name: string;
  /** Cron expression. When set, it lands on the Op as `schedule`; omit for one-shot. */
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
}

export interface PipelineAuditOpResources {
  /** Op resource — the audit Op, emitted on `chant build`. */
  op: InstanceType<typeof OpResource>;
}

export function PipelineAuditOp(config: PipelineAuditOpConfig): PipelineAuditOpResources {
  const onFinding = config.onFinding ?? "report";

  const op = Op({
    name: config.name,
    overview: "Resolve pipeline include/component/image references against live upstreams and report drift",
    labels: {
      Audit: "true",
      Surface: "gitlab-pipeline",
    },
    ...(config.schedule ? { schedule: { cron: config.schedule, overlap: "skip" as const } } : {}),
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

  return { op };
}
