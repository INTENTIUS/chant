/**
 * WAW017: Missing Tags on Taggable Resource
 *
 * Flags taggable resources that have no Tags property set.
 * Encourages adding tags for cost allocation and compliance.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";
import { loadTaggableResources } from "../../taggable";

/**
 * Core detection logic — exported for direct testing with synthetic data.
 */
export function checkMissingTags(
  ctx: PostSynthContext,
  taggable: Set<string>,
): PostSynthDiagnostic[] {
  if (taggable.size === 0) return [];

  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (!taggable.has(resource.Type)) continue;

      const props = resource.Properties ?? {};
      if (!("Tags" in props)) {
        diagnostics.push({
          checkId: "WAW017",
          severity: "warning",
          message: `Resource "${logicalId}" (${resource.Type}) supports tagging but has no Tags — consider adding tags for cost allocation and compliance`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw017: PostSynthCheck = {
  id: "WAW017",
  description: "Missing tags on taggable resource — suggests adding tags for cost allocation and compliance",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkMissingTags(ctx, loadTaggableResources());
  },
};
