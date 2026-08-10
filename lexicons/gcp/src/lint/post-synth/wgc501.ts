/**
 * WGC501: Org Policy Guardrail Not Enforced 
 *
 * Flags OrgPolicyPolicy resources whose rules switch enforcement off or that
 * reset the constraint to its default. A disabled org policy is the GCP
 * shape of a weakened guardrail: the constraint stays visible in the tree
 * while constraining nothing.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getResourceName, type GcpManifest } from "./gcp-helpers";

/**
 * OrgPolicyPolicy mirrors the API's own `spec` inside the CRD spec, so rules
 * live at `spec.spec.rules`; accept `spec.rules` too for hand-written manifests.
 */
export function orgPolicySpec(manifest: GcpManifest): Record<string, unknown> {
  const outer = manifest.spec ?? {};
  const inner = outer.spec;
  return typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : outer;
}

export function orgPolicyRules(manifest: GcpManifest): Array<Record<string, unknown>> {
  const rules = orgPolicySpec(manifest).rules;
  return Array.isArray(rules) ? (rules as Array<Record<string, unknown>>) : [];
}

function isDisabled(rule: Record<string, unknown>): boolean {
  return rule.enforce === false || rule.enforce === "FALSE";
}

export const wgc501: PostSynthCheck = {
  id: "WGC501",
  description: "Org Policy guardrail not enforced — a disabled policy constrains nothing",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "OrgPolicyPolicy") continue;
        const name = getResourceName(manifest);

        if (orgPolicySpec(manifest).reset === true) {
          diagnostics.push({
            checkId: "WGC501",
            severity: "error",
            message: `OrgPolicyPolicy "${name}" resets the constraint to its default — the guardrail is switched off`,
            entity: name,
            lexicon: "gcp",
          });
          continue;
        }

        for (const rule of orgPolicyRules(manifest)) {
          if (isDisabled(rule)) {
            diagnostics.push({
              checkId: "WGC501",
              severity: "error",
              message: `OrgPolicyPolicy "${name}" has a rule with enforce disabled — the guardrail is declared but not enforced`,
              entity: name,
              lexicon: "gcp",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
