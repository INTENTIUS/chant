/**
 * WAW038: RDS Publicly Accessible
 *
 * Flags RDS instances with PubliclyAccessible: true — the instance gets a
 * public IP/DNS name reachable from the internet instead of staying inside
 * the VPC. (DBCluster has no PubliclyAccessible property; that's set on the
 * member DBInstance.)
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

export function checkRdsPubliclyAccessible(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::RDS::DBInstance") continue;

      const props = resource.Properties ?? {};
      const publiclyAccessible = props.PubliclyAccessible;

      if (isIntrinsic(publiclyAccessible)) continue;

      if (publiclyAccessible === true) {
        diagnostics.push({
          checkId: "WAW038",
          severity: "error",
          message: `RDS instance "${logicalId}" has PubliclyAccessible: true — keep the database inside the VPC, unreachable from the internet`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw038: PostSynthCheck = {
  id: "WAW038",
  description: "RDS instance is publicly accessible — keep databases inside the VPC",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkRdsPubliclyAccessible(ctx);
  },
};
