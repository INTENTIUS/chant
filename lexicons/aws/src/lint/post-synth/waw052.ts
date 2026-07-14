/**
 * WAW052: Cognito MFA Not Required (full tier)
 *
 * Flags UserPools without MfaConfiguration: ON. Tier-aware (#894), same
 * seam as WAW040: a relaxed "light" stack (local/Floci, or no --env/
 * ownership.env set) only warns; the strict "full"/production tier
 * (ctx.env === "prod"/"production"/"full") fails the build.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic, isFullTierEnv } from "./cf-refs";

export function checkCognitoMfaRequired(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];
  const severity = isFullTierEnv(ctx.env) ? "error" : "warning";

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::Cognito::UserPool") continue;

      const props = resource.Properties ?? {};
      const mfaConfiguration = props.MfaConfiguration;

      if (isIntrinsic(mfaConfiguration)) continue;

      if (mfaConfiguration !== "ON") {
        diagnostics.push({
          checkId: "WAW052",
          severity,
          message: `Cognito UserPool "${logicalId}" does not require MFA (MfaConfiguration: ON) — require it on the full/production tier`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw052: PostSynthCheck = {
  id: "WAW052",
  description: "Cognito UserPool does not require MFA (full tier)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkCognitoMfaRequired(ctx);
  },
};
