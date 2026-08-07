/**
 * WAW056: SCP Guardrail Denies Nothing (#793, epic #787 C3)
 *
 * Flags SERVICE_CONTROL_POLICY resources whose document contains no Deny
 * statement. SCPs never grant permissions — they only filter — so an SCP
 * without a Deny is a no-op guardrail: the posture it appears to declare
 * does not exist.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

function statementsOf(content: unknown): Array<Record<string, unknown>> | undefined {
  let doc = content;
  if (typeof doc === "string") {
    try {
      doc = JSON.parse(doc);
    } catch {
      return undefined;
    }
  }
  if (typeof doc !== "object" || doc === null) return undefined;
  const statement = (doc as Record<string, unknown>).Statement;
  if (Array.isArray(statement)) return statement as Array<Record<string, unknown>>;
  if (typeof statement === "object" && statement !== null) return [statement as Record<string, unknown>];
  return [];
}

export function checkScpDeniesNothing(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::Organizations::Policy") continue;
      const props = resource.Properties ?? {};
      if (props.Type !== "SERVICE_CONTROL_POLICY") continue;
      if (isIntrinsic(props.Content)) continue;

      const statements = statementsOf(props.Content);
      if (statements === undefined) continue;

      if (!statements.some((s) => s.Effect === "Deny")) {
        diagnostics.push({
          checkId: "WAW056",
          severity: "error",
          message: `SCP "${logicalId}" has no Deny statement — SCPs only filter permissions, so a Deny-less SCP guards nothing`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw056: PostSynthCheck = {
  id: "WAW056",
  description: "SCP guardrail has no Deny statement — it constrains nothing",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkScpDeniesNothing(ctx);
  },
};
