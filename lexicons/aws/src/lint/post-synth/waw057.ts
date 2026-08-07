/**
 * WAW057: SCP Guardrail Attached to No Targets (#793, epic #787 C3)
 *
 * Flags SERVICE_CONTROL_POLICY resources with no TargetIds. A defined but
 * unattached SCP enforces nothing — the usual shape of a guardrail that was
 * "kept" in a template while being detached from the root or its OUs.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

export function checkScpUnattached(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::Organizations::Policy") continue;
      const props = resource.Properties ?? {};
      if (props.Type !== "SERVICE_CONTROL_POLICY") continue;

      const targets = props.TargetIds;
      if (isIntrinsic(targets)) continue;
      if (Array.isArray(targets) && targets.length > 0) continue;

      diagnostics.push({
        checkId: "WAW057",
        severity: "error",
        message: `SCP "${logicalId}" is attached to no targets — a detached guardrail enforces nothing; attach it to the root or an OU via TargetIds`,
        entity: logicalId,
        lexicon: "aws",
      });
    }
  }

  return diagnostics;
}

export const waw057: PostSynthCheck = {
  id: "WAW057",
  description: "SCP guardrail is attached to no targets — it enforces nothing",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkScpUnattached(ctx);
  },
};
