/**
 * WAW048: ECS Missing Log Configuration
 *
 * Flags ECS TaskDefinition containers with no LogConfiguration — container
 * stdout/stderr is discarded, leaving no audit trail. Mirrors WAW024 (ALB
 * access logging): advisory, not a hard block.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, getContainerDefinitions } from "./cf-refs";

export function checkEcsLogConfiguration(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ECS::TaskDefinition") continue;

      for (const container of getContainerDefinitions(resource)) {
        if (container.LogConfiguration === undefined) {
          const containerName = typeof container.Name === "string" ? container.Name : "<unnamed>";
          diagnostics.push({
            checkId: "WAW048",
            severity: "warning",
            message: `TaskDefinition "${logicalId}" container "${containerName}" has no LogConfiguration — container output is discarded`,
            entity: logicalId,
            lexicon: "aws",
          });
        }
      }
    }
  }

  return diagnostics;
}

export const waw048: PostSynthCheck = {
  id: "WAW048",
  description: "ECS container does not have a LogConfiguration — enable logging for audit trails",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkEcsLogConfiguration(ctx);
  },
};
