/**
 * WAW023: CloudFront Without WAF
 *
 * Flags CloudFront distributions without WebACLId.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

export function checkCloudFrontWaf(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::CloudFront::Distribution") continue;

      const props = resource.Properties ?? {};
      const distConfig = props.DistributionConfig;
      if (typeof distConfig !== "object" || distConfig === null) continue;

      const config = distConfig as Record<string, unknown>;
      if (!("WebACLId" in config)) {
        diagnostics.push({
          checkId: "WAW023",
          severity: "warning",
          message: `CloudFront distribution "${logicalId}" has no WebACLId — consider attaching a WAF web ACL for protection`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw023: PostSynthCheck = {
  id: "WAW023",
  description: "CloudFront distribution has no WAF web ACL — consider attaching one for protection",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkCloudFrontWaf(ctx);
  },
};
