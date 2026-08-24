/**
 * ApplyOp composite — the code → cloud workflow as an Op.
 *
 * Compute the plan, then apply via the target's native mechanism. Authority
 * stays with the platform (the CloudFormation stack, the Kubernetes API
 * server, the ARM resource group) — chant never hosts a state file.
 *
 * Phases: build → plan → [approve] → apply. Deletes ride the native
 * prune path, whose bound is per target: the ownership marker on `kubectl`,
 * the ownership tag on `arm` (chant #1448 — previously `--mode Complete`, which
 * removed resources chant never applied), the ownership label on `gcp`
 * (chant #1449), the metadata marker (machines) and managed app
 * (volumes/ips/certs/secrets) on `fly` (chant #1449), and the stack itself on
 * `cloudformation`, which a resource CFN did not create is not in. All of
 * them are owned-only. See {@link DeleteMode}.
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
import { defaultOutput, hasNativeRollback, type ApplyTarget, type DeleteMode } from "../op/activities/apply";

export interface ApplyOpConfig {
  /** Op name (kebab-case). */
  name: string;
  /** Environment — CFN stack name / ARM resource group / kube context env;
   * a log label on `gcp` and `fly`. */
  env: string;
  /** Native apply mechanism. Default: "kubectl". */
  target?: ApplyTarget;
  /** Built manifest/template path. Default per target: `dist` (dir) for kubectl,
   * `template.json` (file) for CloudFormation/ARM, `dist/gcp.yaml` for gcp,
   * `dist/fly.json` for fly. Must match your build output. */
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
   *
   * Compensation is total or refused (#1449): it only builds when the target
   * has a rollback to run — a mapped native one (`cloudformation`, the aws
   * lexicon's `rollbackStack`) or an explicit `{ command }`. Asking for it
   * (`true`, or an object without a `command`) on any other target fails at
   * build time rather than warning at rollback time.
   *
   * Defaults on for a destructive apply (`delete !== "never"`) when the target
   * has a native rollback; a destructive apply on a target without one gets no
   * compensation phase unless a `{ command }` supplies the rollback. Pass
   * `false` to disable.
   */
  compensate?: boolean | { command?: string };
  /**
   * kubectl target only (chant #1075). Let the server-side apply take
   * ownership of fields another field manager already owns, instead of failing
   * with a conflict naming them.
   *
   * Off unless set, and chant never turns it on by itself — a conflict means
   * something else in the cluster believes it owns that field, and deciding
   * otherwise is a deliberate act. Set it when chant is meant to be the
   * authority for those fields (adopting objects a previous `kubectl apply`
   * created is the usual case).
   */
  forceConflicts?: boolean;
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
  const output = config.output ?? defaultOutput(target);
  const deleteMode = config.delete ?? "never";
  const gated = deleteMode === "gated" || config.gate !== undefined;

  const phases = [
    phase("Build", [activity("chantBuild", { path: config.path ?? "." })]),
    phase("Plan", [
      {
        kind: "activity" as const,
        fn: "lifecycleDiff",
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
      activity(
        "nativeApply",
        {
          target,
          env: config.env,
          output,
          deleteMode,
          // Only present when the author asked for it, so an Op that does not
          // mention conflicts serializes exactly as it always has.
          ...(config.forceConflicts !== undefined ? { forceConflicts: config.forceConflicts } : {}),
        },
        "longInfra",
      ),
    ]),
  );

  // Compensation is total or refused (#1449). A rollback path is either the
  // target's mapped native rollback (cloudformation's rollbackStack) or an
  // explicit command; without one there is nothing a Rollback phase could run,
  // so asking for one is refused here — at build time, with the op named —
  // rather than surfacing as a warn when the rollback is already needed.
  const compensateCommand =
    typeof config.compensate === "object" ? config.compensate.command : undefined;
  const rollbackAvailable = hasNativeRollback(target) || compensateCommand !== undefined;
  if (config.compensate !== undefined && config.compensate !== false && !rollbackAvailable) {
    throw new Error(
      `ApplyOp "${config.name}": compensate is enabled, but target "${target}" has no automatic ` +
        `rollback — the only mapped one today is cloudformation's rollbackStack. Either supply ` +
        `compensate: { command: "..." } with a rollback of your own, or set compensate: false.`,
    );
  }

  // Compensation defaults on for destructive applies — a partial failure should
  // unwind rather than leave the cloud half-applied — but only where a rollback
  // path exists; a destructive apply on a rollback-less target gets no
  // compensation phase rather than one that could only warn.
  const compensateDefault = deleteMode !== "never" && rollbackAvailable;
  const compensateEnabled = config.compensate === undefined ? compensateDefault : config.compensate !== false;

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
