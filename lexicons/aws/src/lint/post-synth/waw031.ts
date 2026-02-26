/**
 * WAW031: EKS Addon Missing ServiceAccountRoleArn
 *
 * Certain EKS addons require a ServiceAccountRoleArn (IRSA role) to function.
 * Without one, the addon pods can't authenticate to AWS APIs and the addon
 * hangs in CREATING status indefinitely.
 *
 * Known addons that require IRSA:
 * - aws-ebs-csi-driver (needs EBS API access)
 * - aws-efs-csi-driver (needs EFS API access)
 * - adot (needs CloudWatch/X-Ray access)
 * - amazon-cloudwatch-observability (needs CloudWatch access)
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

/** Addons that are known to require a ServiceAccountRoleArn to function. */
const ADDONS_REQUIRING_IRSA: Record<string, string> = {
  "aws-ebs-csi-driver": "EBS API access to manage volumes",
  "aws-efs-csi-driver": "EFS API access to manage file systems",
  "adot": "CloudWatch/X-Ray access for metrics and traces",
  "amazon-cloudwatch-observability": "CloudWatch access for logs and metrics",
};

export function checkAddonMissingRole(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::EKS::Addon") continue;

      const props = resource.Properties ?? {};
      const addonName = typeof props.AddonName === "string" ? props.AddonName : null;
      if (!addonName) continue;

      const reason = ADDONS_REQUIRING_IRSA[addonName];
      if (!reason) continue;

      // Check if ServiceAccountRoleArn is set (could be a string, Ref, or GetAtt)
      if (!props.ServiceAccountRoleArn) {
        diagnostics.push({
          checkId: "WAW031",
          severity: "warning",
          message: `EKS Addon "${logicalId}" (${addonName}) has no ServiceAccountRoleArn — it needs an IRSA role for ${reason}. Without it, the addon will hang in CREATING status.`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw031: PostSynthCheck = {
  id: "WAW031",
  description: "EKS Addon missing ServiceAccountRoleArn for addons that require IRSA",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkAddonMissingRole(ctx);
  },
};
