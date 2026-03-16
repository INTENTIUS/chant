/**
 * WAW029: Invalid DependsOn Target
 *
 * Detects two cases in the serialized template:
 * - Dangling reference: DependsOn target not in template.Resources
 * - Self-reference: Resource depends on itself
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

export function checkInvalidDependsOn(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    const resourceIds = new Set(Object.keys(template.Resources));

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (!resource.DependsOn) continue;

      const deps = Array.isArray(resource.DependsOn)
        ? resource.DependsOn
        : [resource.DependsOn];

      for (const dep of deps) {
        if (typeof dep !== "string") continue;

        if (dep === logicalId) {
          diagnostics.push({
            checkId: "WAW029",
            severity: "error",
            message: `Resource "${logicalId}" has a DependsOn on itself — self-references are invalid`,
            entity: logicalId,
            lexicon: "aws",
          });
        } else if (!resourceIds.has(dep)) {
          diagnostics.push({
            checkId: "WAW029",
            severity: "error",
            message: `Resource "${logicalId}" has DependsOn "${dep}" which does not exist in the template`,
            entity: logicalId,
            lexicon: "aws",
          });
        }
      }
    }
  }

  return diagnostics;
}

export const waw029: PostSynthCheck = {
  id: "WAW029",
  description: "Invalid DependsOn target — dangling reference or self-reference",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkInvalidDependsOn(ctx);
  },
};
