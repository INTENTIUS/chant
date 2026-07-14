/**
 * WAW041: RDS Proxy TLS Not Required
 *
 * Flags RDS Proxy resources without RequireTLS: true — without it, a client
 * can connect to the proxy over plaintext.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

export function checkDbProxyTls(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::RDS::DBProxy") continue;

      const props = resource.Properties ?? {};
      const requireTls = props.RequireTLS;

      if (isIntrinsic(requireTls)) continue;

      if (requireTls !== true) {
        diagnostics.push({
          checkId: "WAW041",
          severity: "error",
          message: `RDS Proxy "${logicalId}" does not have RequireTLS: true — clients can connect over plaintext`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw041: PostSynthCheck = {
  id: "WAW041",
  description: "RDS Proxy does not require TLS for client connections",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkDbProxyTls(ctx);
  },
};
