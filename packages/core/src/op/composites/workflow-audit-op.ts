/**
 * WorkflowAuditOp composite — the live supply-chain audit of GitHub workflows
 * as a chant Op with an optional schedule (#292).
 *
 * The github post-synth checks (#286-#291) own everything answerable from the
 * deterministic build. This Op owns *only* the checks that require live
 * resolution against a moving upstream truth — stale SHA pins, impostor refs,
 * symbolic-ref confusion, pin/comment mismatch, advisories, archived upstreams.
 * It sits at **observe** on the lifecycle dial, with a finding-mode (mirroring
 * `ReconcileOp`: `report | issue | pull-request`) as the **reconcile** step.
 *
 * Runs one-shot on the local Op executor via `chant run`; a `schedule` puts
 * the cadence on the Op itself (#2120), for continuous re-audit between
 * change windows.
 *
 * @example
 * ```typescript
 * // one-shot, local executor
 * export const { op } = WorkflowAuditOp({ name: "actions-audit" });
 *
 * // daily, opening a PR that bumps a stale pin
 * export const { op } = WorkflowAuditOp({
 *   name: "actions-audit",
 *   schedule: "0 6 * * *",
 *   onFinding: "pull-request",
 * });
 * ```
 *
 * @see #286 — the deterministic counterpart this freshens.
 */

import { Op, phase } from "../builders";
import type { OpResource } from "../resource";
import type { WorkflowAuditMode } from "../activities/workflow-audit";

export interface WorkflowAuditOpConfig {
  /** Op name (kebab-case). Names the Op's output directory and is what `chant run` takes. */
  name: string;
  /**
   * Cron expression. When set, it lands on the Op as `schedule` for
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
}

export interface WorkflowAuditOpResources {
  /** Op resource — generates the audit workflow on `chant build`. */
  op: InstanceType<typeof OpResource>;
}

export function WorkflowAuditOp(config: WorkflowAuditOpConfig): WorkflowAuditOpResources {
  const onFinding = config.onFinding ?? "report";

  const op = Op({
    name: config.name,
    overview: "Resolve workflow action references against live upstreams and report supply-chain drift",
    labels: {
      Audit: "true",
      Surface: "github-workflows",
    },
    ...(config.schedule ? { schedule: { cron: config.schedule, overlap: "skip" as const } } : {}),
    phases: [
      phase("Audit", [
        {
          kind: "activity",
          fn: "workflowSupplyChainAudit",
          args: { workflowsDir: config.workflowsDir ?? ".github/workflows", mode: onFinding },
          // Surface the finding count as the run's `Findings` outcome on the
          // run ledger, so a reader can pick out the audits that found
          // something.
          outcomeAttribute: { name: "Findings", from: "findings" },
        },
      ]),
    ],
  });

  return { op };
}
