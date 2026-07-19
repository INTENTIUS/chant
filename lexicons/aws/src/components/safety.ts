/**
 * safety / rollback family — explicit snapshot-and-restore capabilities, used
 * alongside the per-capability `rollback` compensation for cases that need an
 * up-front capture (e.g. before a `cfn-deploy` with `onReplace: "snapshot-first"`).
 *
 * Both dispatch to the kind-appropriate AWS backup/restore mechanism through the
 * injectable `CloudExecutor` (DynamoDB backup, RDS DB snapshot, EBS snapshot).
 */

import type { Capability } from "@intentius/chant/components/capability";
import { defaultCloudExecutor, type CloudExecutor } from "./cloud-executor";

// ── snapshot-before ──────────────────────────────────────────────────────────

export interface SnapshotBeforeInput {
  /** Resource identifier to snapshot (e.g. a DynamoDB table name, an RDS instance id). */
  resource: string;
  /** Resource kind, used to select the right snapshot mechanism. */
  resourceKind: "dynamodb-table" | "rds-instance" | "opensearch-domain" | "ebs-volume";
}

export interface SnapshotBeforeOutput {
  /** Snapshot identifier, for `rollback-previous` to restore from. */
  snapshotId: string;
}

/**
 * Capture a restorable snapshot before a risky/destructive apply step, via the
 * kind-appropriate AWS backup mechanism through the injectable `CloudExecutor`
 * (DynamoDB on-demand backup, RDS DB snapshot, or EBS volume snapshot). Returns
 * the backup/snapshot id `rollback-previous` restores from.
 */
export function createSnapshotBeforeCapability(executor: CloudExecutor = defaultCloudExecutor()): Capability<SnapshotBeforeInput, SnapshotBeforeOutput> {
  return {
    kind: "snapshot-before",
    async run(_ctx, input) {
      return executor.snapshot.create({ resource: input.resource, resourceKind: input.resourceKind });
    },
  };
}

/** Default `snapshot-before` capability, backed by the real `CloudExecutor`. */
export const snapshotBeforeCapability: Capability<SnapshotBeforeInput, SnapshotBeforeOutput> =
  createSnapshotBeforeCapability();

// ── rollback-previous ────────────────────────────────────────────────────────

/** Restore a resource from a prior `snapshot-before` capture (DynamoDB/RDS/EBS). */
export interface RollbackPreviousSnapshotInput {
  /** Snapshot identifier to restore (typically `"@snapshot-before.snapshotId"`). */
  snapshotId: string;
  /** Resource identifier being restored. */
  resource: string;
}

/** Roll an ECS service back to its previously recorded task definition — the
 * shape the `ecs-fargate` preset and the ALB/ECS pilot compose (e.g. loomster's
 * `loom-frontend`). */
export interface RollbackPreviousEcsInput {
  /** ECS service name. */
  service: string;
  /** ECS cluster (name or ARN). */
  cluster: string;
  /** Explicit task definition to roll to; omitted → the executor's recorded previous. */
  taskDefinition?: string;
  desiredCount?: number;
}

/** `rollback-previous` accepts EITHER a snapshot restore or an ECS service
 * rollback — the two things components actually compose it for. */
export type RollbackPreviousInput = RollbackPreviousSnapshotInput | RollbackPreviousEcsInput;

export interface RollbackPreviousOutput {
  /** True once the restore/rollback completed. */
  restored: boolean;
}

/**
 * Roll a resource back to its prior state — an explicit, caller-composed
 * compensation (not the auto-triggered per-capability `rollback`). Dispatches by
 * the input shape: an ECS service (`{service, cluster}`) rolls to its previous
 * task definition; a snapshot (`{snapshotId, resource}`) restores that capture.
 * An unrecognized shape fails with a clear message rather than a cryptic
 * `undefined` access (chant #990 — an ECS-shaped input used to reach the
 * snapshot path and throw "reading 'includes'" on the absent snapshotId).
 */
export function createRollbackPreviousCapability(executor: CloudExecutor = defaultCloudExecutor()): Capability<RollbackPreviousInput, RollbackPreviousOutput> {
  return {
    kind: "rollback-previous",
    async run(_ctx, input) {
      if ("service" in input && input.service) {
        await executor.ecs.rollbackService({
          cluster: input.cluster,
          service: input.service,
          taskDefinition: input.taskDefinition,
          desiredCount: input.desiredCount,
        });
        return { restored: true };
      }
      if ("snapshotId" in input && input.snapshotId) {
        await executor.snapshot.restore({ resource: input.resource, snapshotId: input.snapshotId });
        return { restored: true };
      }
      throw new Error(
        `rollback-previous: unrecognized input — expected { service, cluster } (ECS service rollback) or ` +
          `{ snapshotId, resource } (snapshot restore), got keys [${Object.keys(input).join(", ")}]`,
      );
    },
  };
}

/** Default `rollback-previous` capability, backed by the real `CloudExecutor`. */
export const rollbackPreviousCapability: Capability<RollbackPreviousInput, RollbackPreviousOutput> =
  createRollbackPreviousCapability();
