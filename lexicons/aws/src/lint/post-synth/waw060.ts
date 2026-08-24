/**
 * WAW060: IAM Policy Attached to No Principal
 *
 * Flags AWS::IAM::Policy / AWS::IAM::ManagedPolicy resources with empty or
 * absent Roles, Users, and Groups that no other part of the template
 * references. A policy attached to no principal grants nothing — the same
 * detached-guardrail shape WAW057 catches for SCPs. Any Ref/GetAtt edge to
 * the policy (a role's ManagedPolicyArns, an attachment-style resource, a
 * stack Output exporting it for another stack to attach) keeps it quiet;
 * plain AWS-managed ARN strings elsewhere are not references to the
 * template's own policy.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, findResourceRefs, isIntrinsic, type CFTemplate } from "./cf-refs";

const POLICY_TYPES = new Set(["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"]);
const PRINCIPAL_PROPS = ["Roles", "Users", "Groups"] as const;

/**
 * Collect every logical id referenced via Ref/Fn::GetAtt from anywhere in the
 * template except the policy resources themselves — other resources'
 * properties and the Outputs section. An Output edge counts as attachment
 * evidence: the policy may be exported for a consuming stack to attach.
 */
function collectExternalRefs(template: CFTemplate, excludeIds: Set<string>): Set<string> {
  const refs = new Set<string>();
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (excludeIds.has(logicalId)) continue;
    for (const ref of findResourceRefs(resource)) refs.add(ref);
  }
  for (const ref of findResourceRefs(template.Outputs)) refs.add(ref);
  return refs;
}

export function checkPolicyUnattached(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    const policyIds = new Set(
      Object.entries(template.Resources)
        .filter(([, resource]) => POLICY_TYPES.has(resource.Type))
        .map(([logicalId]) => logicalId),
    );
    if (policyIds.size === 0) continue;

    const externalRefs = collectExternalRefs(template, policyIds);

    for (const logicalId of policyIds) {
      const resource = template.Resources[logicalId];
      const props = resource.Properties ?? {};

      // Any declared principal list keeps the policy quiet. An intrinsic
      // can't be statically evaluated, so it counts as attached.
      let attached = false;
      for (const prop of PRINCIPAL_PROPS) {
        const value = props[prop];
        if (isIntrinsic(value)) attached = true;
        else if (Array.isArray(value) && value.length > 0) attached = true;
      }
      if (attached) continue;

      // Reverse lookup: anything else in the template holding a Ref/GetAtt
      // edge to this policy attaches (or exports) it.
      if (externalRefs.has(logicalId)) continue;

      const kind = resource.Type === "AWS::IAM::ManagedPolicy" ? "Managed policy" : "Policy";
      diagnostics.push({
        checkId: "WAW060",
        severity: "warning",
        message: `${kind} "${logicalId}" is attached to no principal — no Roles/Users/Groups and nothing in the template references it; an unattached policy grants nothing`,
        entity: logicalId,
        lexicon: "aws",
      });
    }
  }

  return diagnostics;
}

export const waw060: PostSynthCheck = {
  id: "WAW060",
  description: "IAM policy attached to no principal — it grants nothing",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkPolicyUnattached(ctx);
  },
};
