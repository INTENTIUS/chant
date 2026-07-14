/**
 * WAW051: Cognito Implicit OAuth Grant Allowed
 *
 * Flags UserPoolClients whose AllowedOAuthFlows include the deprecated
 * "implicit" grant — it returns tokens directly in the redirect URL (exposed
 * in browser history/referrer headers) instead of via a code exchange.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

export function checkCognitoImplicitGrant(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::Cognito::UserPoolClient") continue;

      const props = resource.Properties ?? {};
      const flows = props.AllowedOAuthFlows;

      if (isIntrinsic(flows) || !Array.isArray(flows)) continue;

      if (flows.some((f) => f === "implicit")) {
        diagnostics.push({
          checkId: "WAW051",
          severity: "error",
          message: `Cognito UserPoolClient "${logicalId}" allows the implicit OAuth grant — use the authorization code grant instead`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw051: PostSynthCheck = {
  id: "WAW051",
  description: "Cognito UserPoolClient allows the deprecated implicit OAuth grant",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkCognitoImplicitGrant(ctx);
  },
};
