/**
 * WAW010: Redundant DependsOn
 *
 * Detects DependsOn entries that are already implied by Ref or Fn::GetAtt
 * references in the resource's Properties. CloudFormation automatically
 * creates dependencies for these references, making explicit DependsOn redundant.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, findResourceRefs } from "./cf-refs";

export const waw010: PostSynthCheck = {
  id: "WAW010",
  description: "Redundant DependsOn — target is already referenced via Ref or Fn::GetAtt in Properties",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseCFTemplate(output);
      if (!template?.Resources) continue;

      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (!resource.DependsOn) continue;

        const dependsOn = Array.isArray(resource.DependsOn)
          ? resource.DependsOn
          : [resource.DependsOn];

        // Find all refs in Properties
        const propertyRefs = findResourceRefs(resource.Properties);

        for (const target of dependsOn) {
          if (propertyRefs.has(target)) {
            diagnostics.push({
              checkId: "WAW010",
              severity: "warning",
              message: `Resource "${logicalId}" has redundant DependsOn "${target}" — already referenced in Properties`,
              entity: logicalId,
              lexicon: "aws",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
