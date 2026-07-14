/**
 * WAW045: ALB Weak Or Missing TLS Policy
 *
 * Flags HTTPS/TLS listeners without a modern SslPolicy (TLS 1.2+). The
 * account-wide default (`ELBSecurityPolicy-2016-08`) still allows TLS 1.0, so
 * a missing SslPolicy is flagged the same as an explicit legacy one.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

const SECURE_PROTOCOLS = new Set(["HTTPS", "TLS"]);

/** AWS's predefined TLS 1.2+ policies all carry a "-1-2-" or "-1-3-" segment (FS/TLS13 variants included). */
function isModernTlsPolicy(policy: string): boolean {
  return /-1-2-|-1-3-/.test(policy);
}

export function checkAlbTlsPolicy(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ElasticLoadBalancingV2::Listener") continue;

      const props = resource.Properties ?? {};
      const protocol = props.Protocol;
      if (isIntrinsic(protocol) || typeof protocol !== "string" || !SECURE_PROTOCOLS.has(protocol)) continue;

      const sslPolicy = props.SslPolicy;
      if (isIntrinsic(sslPolicy)) continue;

      if (typeof sslPolicy !== "string" || !isModernTlsPolicy(sslPolicy)) {
        diagnostics.push({
          checkId: "WAW045",
          severity: "error",
          message: `Listener "${logicalId}" (${protocol}) ${sslPolicy ? `uses SslPolicy "${sslPolicy}"` : "has no SslPolicy set"} — use a TLS 1.2+ predefined policy (e.g. ELBSecurityPolicy-TLS13-1-2-2021-06)`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw045: PostSynthCheck = {
  id: "WAW045",
  description: "ALB HTTPS/TLS listener does not use a modern (TLS 1.2+) SslPolicy",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkAlbTlsPolicy(ctx);
  },
};
