/**
 * WAW071: Tags are in the wrong property or the wrong shape for the type
 *
 * Each taggable type names its tag property and shape in its schema
 * (`tagging.tagProperty`): a `[{Key, Value}]` list for most types, a map for
 * types such as `AWS::SSM::Parameter`, and a property other than `Tags` for
 * types such as `AWS::Cognito::UserPool` (`UserPoolTags`). CloudFormation
 * rejects a template that puts tags anywhere else. chant stamped the ownership
 * marker as a `Tags` list on every type until #4350; this check catches the
 * next such template.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";
import { isTagIntrinsic, loadTagPlacements, type TagPlacement } from "../../taggable";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why `value` doesn't fit `placement`, or undefined when it does. */
function shapeProblem(value: unknown, placement: TagPlacement): string | undefined {
  if (isTagIntrinsic(value)) return undefined;
  if (placement.shape === "map") {
    return isPlainObject(value) ? undefined : "a list, but the type takes a key-to-value map";
  }
  if (!Array.isArray(value)) return "a map, but the type takes a [{Key, Value}] list";
  const bad = value.some((t) => !isTagIntrinsic(t) && !(isPlainObject(t) && "Key" in t && "Value" in t));
  return bad ? "a list with an entry that has no Key and Value" : undefined;
}

/**
 * Core detection logic — exported for direct testing with synthetic data.
 */
export function checkTagShapes(
  ctx: PostSynthContext,
  placements: Map<string, TagPlacement | null>,
): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [lexicon, output] of ctx.outputs) {
    if (lexicon !== "aws") continue;
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      const placement = placements.get(resource.Type);
      if (!placement) continue;
      const props = resource.Properties ?? {};

      if (placement.property !== "Tags" && "Tags" in props) {
        diagnostics.push({
          checkId: "WAW071",
          severity: "error",
          message: `Resource "${logicalId}" (${resource.Type}) has Tags, but the type takes its tags in ${placement.property}`,
          entity: logicalId,
          lexicon: "aws",
        });
      }

      if (!(placement.property in props)) continue;
      const problem = shapeProblem(props[placement.property], placement);
      if (problem) {
        diagnostics.push({
          checkId: "WAW071",
          severity: "error",
          message: `Resource "${logicalId}" (${resource.Type}) has ${placement.property} as ${problem}`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw071: PostSynthCheck = {
  id: "WAW071",
  description: "Tags are in the wrong property or the wrong shape for the resource type",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkTagShapes(ctx, loadTagPlacements());
  },
};
