/**
 * WAW055: CloudWatch Logs Retention Not Set
 *
 * Flags Logs::LogGroup resources without RetentionInDays — an unset
 * retention means "Never expire," which is rarely the intended cost/
 * compliance posture.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

export function checkLogsRetention(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::Logs::LogGroup") continue;

      const props = resource.Properties ?? {};
      const retention = props.RetentionInDays;

      if (isIntrinsic(retention)) continue;

      if (retention === undefined) {
        diagnostics.push({
          checkId: "WAW055",
          severity: "warning",
          message: `Log group "${logicalId}" has no RetentionInDays set — logs are kept forever by default; set an explicit retention period`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw055: PostSynthCheck = {
  id: "WAW055",
  description: "CloudWatch Logs log group has no retention period set",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkLogsRetention(ctx);
  },
};
