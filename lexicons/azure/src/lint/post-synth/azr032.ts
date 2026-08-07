/**
 * AZR032: Policy Definition Assigned Nowhere (#793, epic #787 C3)
 *
 * Flags custom Microsoft.Authorization/policyDefinitions with no
 * policyAssignments referencing them in the same template. The
 * GovernanceBaseline composite always pairs definition and assignment; a
 * definition alone is the leftover of a dropped guardrail assignment.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

/**
 * True when a policyDefinitionId expression targets the definition name —
 * either a quoted literal inside resourceId()/managementGroupResourceId()
 * or the trailing segment of a literal resource id.
 */
function references(definitionName: string, policyDefinitionId: unknown): boolean {
  if (typeof policyDefinitionId !== "string") return false;
  return (
    policyDefinitionId.includes(`'${definitionName}'`) ||
    policyDefinitionId.endsWith(`/${definitionName}`) ||
    policyDefinitionId === definitionName
  );
}

export const azr032: PostSynthCheck = {
  id: "AZR032",
  description: "Custom policy definition assigned nowhere — a defined but unassigned guardrail enforces nothing",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      const assignmentIds = template.resources
        .filter((r) => r.type === "Microsoft.Authorization/policyAssignments")
        .map((r) => r.properties?.policyDefinitionId);

      for (const resource of template.resources) {
        if (resource.type !== "Microsoft.Authorization/policyDefinitions") continue;
        if (typeof resource.name !== "string") continue;
        const name = resource.name;
        if (assignmentIds.some((id) => references(name, id))) continue;

        diagnostics.push({
          checkId: "AZR032",
          severity: "error",
          message: `Policy definition "${name}" is assigned nowhere in this template — pair it with a policy assignment or the guardrail enforces nothing`,
          entity: name,
          lexicon: "azure",
        });
      }
    }

    return diagnostics;
  },
};
