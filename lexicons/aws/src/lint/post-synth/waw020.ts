/**
 * WAW020: IAM Wildcard Action
 *
 * Flags IAM policies with Action: "*" in any statement.
 * Checks IAM::Policy, IAM::Role, and IAM::ManagedPolicy resource types.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, walkPolicyStatements, isIntrinsic } from "./cf-refs";

const IAM_TYPES = new Set([
  "AWS::IAM::Policy",
  "AWS::IAM::Role",
  "AWS::IAM::ManagedPolicy",
]);

function hasWildcardAction(statement: Record<string, unknown>): boolean {
  const action = statement.Action;
  if (action === "*") return true;
  if (Array.isArray(action)) {
    return action.some((a) => a === "*");
  }
  return false;
}

export function checkIamWildcardAction(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (!IAM_TYPES.has(resource.Type)) continue;

      const statements = walkPolicyStatements(resource);
      for (const stmt of statements) {
        if (isIntrinsic(stmt.Action)) continue;

        if (hasWildcardAction(stmt)) {
          diagnostics.push({
            checkId: "WAW020",
            severity: "warning",
            message: `IAM resource "${logicalId}" has a policy statement with Action: "*" — use specific actions following least privilege`,
            entity: logicalId,
            lexicon: "aws",
          });
          break; // One diagnostic per resource
        }
      }
    }
  }

  return diagnostics;
}

export const waw020: PostSynthCheck = {
  id: "WAW020",
  description: "IAM policy uses wildcard Action — use specific actions following least privilege",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkIamWildcardAction(ctx);
  },
};
