/**
 * WAW040: RDS Deletion Protection Disabled (full tier)
 *
 * Flags RDS instances and clusters without DeletionProtection: true. Tier-aware
 * (#894): a relaxed "light" stack (local/Floci, or no --env/ownership.env set)
 * only warns, since local/dev databases are routinely torn down on purpose; the
 * strict "full"/production tier (ctx.env === "prod"/"production"/"full", the
 * existing #201 env seam — see isFullTierEnv) fails the build.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic, isFullTierEnv } from "./cf-refs";

const RDS_TYPES = new Set(["AWS::RDS::DBInstance", "AWS::RDS::DBCluster"]);

export function checkRdsDeletionProtection(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];
  const severity = isFullTierEnv(ctx.env) ? "error" : "warning";

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (!RDS_TYPES.has(resource.Type)) continue;

      const props = resource.Properties ?? {};
      const deletionProtection = props.DeletionProtection;

      if (isIntrinsic(deletionProtection)) continue;

      if (deletionProtection !== true) {
        diagnostics.push({
          checkId: "WAW040",
          severity,
          message: `RDS resource "${logicalId}" (${resource.Type}) does not have DeletionProtection: true — enable it on the full/production tier`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw040: PostSynthCheck = {
  id: "WAW040",
  description: "RDS instance or cluster does not have DeletionProtection enabled (full tier)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkRdsDeletionProtection(ctx);
  },
};
