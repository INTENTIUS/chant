/**
 * WAW050: Cognito Advanced Security Disabled
 *
 * Flags Cognito UserPools without UserPoolAddOns.AdvancedSecurityMode set to
 * AUDIT or ENFORCED — without it, Cognito does not evaluate risk (compromised
 * credentials, adaptive auth) on sign-in/sign-up.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

export function checkCognitoAdvancedSecurity(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::Cognito::UserPool") continue;

      const props = resource.Properties ?? {};
      const addOns = props.UserPoolAddOns;

      if (isIntrinsic(addOns)) continue;

      const mode =
        typeof addOns === "object" && addOns !== null ? (addOns as Record<string, unknown>).AdvancedSecurityMode : undefined;

      if (isIntrinsic(mode)) continue;

      if (mode !== "AUDIT" && mode !== "ENFORCED") {
        diagnostics.push({
          checkId: "WAW050",
          severity: "error",
          message: `Cognito UserPool "${logicalId}" does not have advanced security enabled — set UserPoolAddOns.AdvancedSecurityMode to AUDIT or ENFORCED`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw050: PostSynthCheck = {
  id: "WAW050",
  description: "Cognito UserPool does not have advanced security (risk-based auth) enabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkCognitoAdvancedSecurity(ctx);
  },
};
