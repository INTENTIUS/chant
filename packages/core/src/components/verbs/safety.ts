/**
 * safety / rollback family — explicit snapshot-and-restore capabilities, used
 * alongside the per-capability `rollback` compensation for cases that need an
 * up-front capture (e.g. before a `cfn-deploy` with `onReplace: "snapshot-first"`).
 *
 * Typed stubs only; see ../capability.ts for the "no cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";
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

export interface RollbackPreviousInput {
  /** Snapshot identifier to restore (typically `"@snapshot-before.snapshotId"`). */
  snapshotId: string;
  /** Resource identifier being restored. */
  resource: string;
}

export interface RollbackPreviousOutput {
  /** True once the restore completed. */
  restored: boolean;
}

/** Restore a resource from a prior `snapshot-before` capture — explicit rollback, not auto-triggered. */
export const rollbackPreviousCapability: Capability<RollbackPreviousInput, RollbackPreviousOutput> =
  stubCapability("rollback-previous");
