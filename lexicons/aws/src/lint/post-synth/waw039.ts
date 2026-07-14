/**
 * WAW039: RDS Backup Retention Not Set
 *
 * Flags RDS instances and clusters without a positive BackupRetentionPeriod —
 * a retention of 0 (or an unset property on a resource that otherwise pins
 * every other property explicitly) disables automated backups entirely.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

const RDS_TYPES = new Set(["AWS::RDS::DBInstance", "AWS::RDS::DBCluster"]);

export function checkRdsBackupRetention(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (!RDS_TYPES.has(resource.Type)) continue;

      const props = resource.Properties ?? {};
      const retention = props.BackupRetentionPeriod;

      if (isIntrinsic(retention)) continue;

      if (retention === undefined || retention === 0) {
        diagnostics.push({
          checkId: "WAW039",
          severity: "error",
          message: `RDS resource "${logicalId}" (${resource.Type}) does not have a positive BackupRetentionPeriod — automated backups are disabled`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw039: PostSynthCheck = {
  id: "WAW039",
  description: "RDS instance or cluster has automated backups disabled — set a positive BackupRetentionPeriod",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkRdsBackupRetention(ctx);
  },
};
