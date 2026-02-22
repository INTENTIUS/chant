/**
 * WAW024: ALB Without Access Logging
 *
 * Flags Application Load Balancers without access logging enabled.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

export function checkAlbAccessLogs(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ElasticLoadBalancingV2::LoadBalancer") continue;

      const props = resource.Properties ?? {};
      const attrs = props.LoadBalancerAttributes;

      let hasAccessLogs = false;
      if (Array.isArray(attrs)) {
        hasAccessLogs = attrs.some((attr) => {
          if (typeof attr !== "object" || attr === null) return false;
          const a = attr as Record<string, unknown>;
          return a.Key === "access_logs.s3.enabled" && (a.Value === "true" || a.Value === true);
        });
      }

      if (!hasAccessLogs) {
        diagnostics.push({
          checkId: "WAW024",
          severity: "warning",
          message: `Load balancer "${logicalId}" does not have access logging enabled — enable access_logs.s3.enabled for audit trails`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw024: PostSynthCheck = {
  id: "WAW024",
  description: "Application Load Balancer does not have access logging enabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkAlbAccessLogs(ctx);
  },
};
