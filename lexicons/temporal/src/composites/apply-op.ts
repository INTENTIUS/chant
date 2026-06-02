/**
 * ApplyOp composite — the code → cloud workflow as an Op.
 *
 * Compute the plan, then apply via the target's native mechanism. Authority
 * stays with the platform (the CloudFormation stack, the Kubernetes API
 * server, the ARM resource group) — chant never hosts a state file.
 *
 * Phases: build → plan → [approve] → apply. Deletes are limited to chant-owned
 * orphans, ridden on the native prune/complete path scoped to the ownership
 * marker, so a foreign resource is never touched.
 *
 * An ungated apply may run on the local Op executor; a gated apply needs
 * Temporal for the durable approval wait (added in #125).
 *
 * @example
 * ```typescript
 * // additive, local executor
 * export const { op } = ApplyOp({ name: "prod-apply", env: "prod", target: "kubectl" });
 *
 * // gated destructive apply on Temporal
 * export const { op } = ApplyOp({
 *   name: "prod-apply",
 *   env: "prod",
 *   target: "kubectl",
 *   delete: "gated",
 *   gate: { signalName: "approve-apply", description: "Approve prod apply with deletes" },
 * });
 * ```
 *
 * @see #112 — stateless-authoritative state model + live import
 */

import { Op, phase, activity, gate, OpResource } from "@intentius/chant/op";
import type { ApplyTarget, DeleteMode } from "../op/activities/apply";

export interface ApplyOpConfig {
  /** Op name (kebab-case). */
  name: string;
  /** Environment — CFN stack name / ARM resource group / kube context env. */
  env: string;
  /** Native apply mechanism. Default: "kubectl". */
  target?: ApplyTarget;
  /** Built manifest/template path (or directory for kubectl). Default: "dist". */
  output?: string;
  /** Project directory to build. Default: ".". */
  path?: string;
  /** Delete handling. Default: "never". */
  delete?: DeleteMode;
  /**
   * Approval gate before the apply. Implied when `delete: "gated"`; may also be
   * set explicitly. Omit `signalName` to default to `approve-<name>`.
   */
  gate?: { signalName?: string; timeout?: string; description?: string };
  /**
   * Saga-style rollback on partial apply failure, run as an `onFailure` phase.
   * Defaults on whenever the apply is destructive (`delete !== "never"`). Pass
   * `{ command }` to supply a rollback command for targets without a native one
   * (kubectl, ARM); `false` to disable.
   */
  compensate?: boolean | { command?: string };
  /** Override the task queue. Defaults to `name`. */
  taskQueue?: string;
}

export interface ApplyOpResources {
  /** Op resource — generates the build→plan→[approve]→apply workflow. */
  op: InstanceType<typeof OpResource>;
}

export function ApplyOp(config: ApplyOpConfig): ApplyOpResources {
  const taskQueue = config.taskQueue ?? config.name;
  const target = config.target ?? "kubectl";
  const output = config.output ?? "dist";
  const deleteMode = config.delete ?? "never";
  const gated = deleteMode === "gated" || config.gate !== undefined;

  const phases = [
    phase("Build", [activity("chantBuild", { path: config.path ?? "." })]),
    phase("Plan", [
      {
        kind: "activity" as const,
        fn: "stateDiff",
        args: { env: config.env, live: true },
        outcomeAttribute: { name: "Drift", from: "drifted" },
      },
    ]),
  ];

  if (gated) {
    phases.push(
      phase("Approve", [
        gate(config.gate?.signalName ?? `approve-${config.name}`, {
          ...(config.gate?.timeout ? { timeout: config.gate.timeout } : {}),
          description:
            config.gate?.description ?? `Approve apply to ${config.env} (delete mode: ${deleteMode})`,
        }),
      ]),
    );
  }

  phases.push(
    phase("Apply", [
      activity("nativeApply", { target, env: config.env, output, deleteMode }, "longInfra"),
    ]),
  );

  // Compensation defaults on for destructive applies — a partial failure should
  // unwind rather than leave the cloud half-applied.
  const compensateDefault = deleteMode !== "never";
  const compensateEnabled = config.compensate === undefined ? compensateDefault : config.compensate !== false;
  const compensateCommand =
    typeof config.compensate === "object" ? config.compensate.command : undefined;

  const op = Op({
    name: config.name,
    overview: `Apply declared source to the ${config.env} environment (code → cloud)`,
    taskQueue,
    searchAttributes: {
      Apply: "true",
      Env: config.env,
    },
    phases,
    ...(compensateEnabled
      ? {
          onFailure: [
            phase("Rollback", [
              activity("compensateApply", {
                target,
                env: config.env,
                ...(compensateCommand ? { command: compensateCommand } : {}),
              }),
            ]),
          ],
        }
      : {}),
  });

  return { op };
}
