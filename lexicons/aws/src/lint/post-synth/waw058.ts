/**
 * WAW058: Organization Audit Trail Dropped or Scoped Down (#793, epic #787 C3)
 *
 * The audit-sink posture regressions on AWS: a trail with logging switched
 * off, an organization trail narrowed to a single region, or an organization
 * declared with no CloudTrail trail at all. Audit evidence is the layer the
 * other guardrails depend on, so losing it is merge-worthy.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

export function checkAuditTrailPosture(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    let declaresOrganization = false;
    let trailCount = 0;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type === "AWS::Organizations::Organization") declaresOrganization = true;
      if (resource.Type !== "AWS::CloudTrail::Trail") continue;
      trailCount++;

      const props = resource.Properties ?? {};

      if (!isIntrinsic(props.IsLogging) && props.IsLogging === false) {
        diagnostics.push({
          checkId: "WAW058",
          severity: "error",
          message: `Trail "${logicalId}" has IsLogging: false — the audit sink is declared but delivers nothing`,
          entity: logicalId,
          lexicon: "aws",
        });
      }

      if (props.IsOrganizationTrail === true && !isIntrinsic(props.IsMultiRegionTrail) && props.IsMultiRegionTrail !== true) {
        diagnostics.push({
          checkId: "WAW058",
          severity: "error",
          message: `Organization trail "${logicalId}" is not multi-region — audit evidence is scoped down to a single region`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }

    if (declaresOrganization && trailCount === 0) {
      diagnostics.push({
        checkId: "WAW058",
        severity: "error",
        message: "Template creates an AWS::Organizations::Organization with no CloudTrail trail — the landing zone has no audit sink",
        lexicon: "aws",
      });
    }
  }

  return diagnostics;
}

export const waw058: PostSynthCheck = {
  id: "WAW058",
  description: "Organization audit trail missing, not logging, or scoped down to a single region",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkAuditTrailPosture(ctx);
  },
};
