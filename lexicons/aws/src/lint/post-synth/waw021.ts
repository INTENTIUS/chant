/**
 * WAW021: RDS Storage Not Encrypted
 *
 * Flags RDS instances and clusters without StorageEncrypted: true.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

const RDS_TYPES = new Set([
  "AWS::RDS::DBInstance",
  "AWS::RDS::DBCluster",
]);

export function checkRdsEncryption(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (!RDS_TYPES.has(resource.Type)) continue;

      const props = resource.Properties ?? {};
      const encrypted = props.StorageEncrypted;

      // Skip if it's an intrinsic (can't statically verify)
      if (isIntrinsic(encrypted)) continue;

      if (encrypted !== true) {
        diagnostics.push({
          checkId: "WAW021",
          severity: "error",
          message: `RDS resource "${logicalId}" (${resource.Type}) does not have StorageEncrypted: true — enable encryption at rest`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw021: PostSynthCheck = {
  id: "WAW021",
  description: "RDS instance or cluster storage is not encrypted — enable encryption at rest",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkRdsEncryption(ctx);
  },
};
