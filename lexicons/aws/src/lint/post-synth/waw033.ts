/**
 * WAW033: Null Values in CloudFormation Resource Properties
 *
 * `resource.PropName` where PropName is not a real GetAtt attribute returns null
 * silently in chant's AttrRef system — the TypeScript types say `string` but the
 * runtime value is null. This produces a template with literal null values that
 * CloudFormation rejects at changeset time with an unhelpful "Invalid template"
 * error.
 *
 * Common causes:
 *   - `resource.SomeId` instead of `Ref(resource)` (use Ref for the primary identifier)
 *   - `resource.SomeProp` where SomeProp is not listed in AWS CloudFormation GetAtt docs
 *   - Typo in an attribute name (e.g. `resource.GroupName` vs `resource.GroupId`)
 *
 * This check scans every resource's Properties for null values at any depth and
 * reports the logical resource ID and dotted property path.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

interface NullLocation {
  logicalId: string;
  path: string;
}

/** Recursively collect all paths where the value is null. */
function collectNullPaths(value: unknown, path: string, results: NullLocation[], logicalId: string): void {
  if (value === null) {
    results.push({ logicalId, path });
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectNullPaths(value[i], `${path}[${i}]`, results, logicalId);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectNullPaths(v, path ? `${path}.${k}` : k, results, logicalId);
    }
  }
}

export function checkNullProperties(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (!resource.Properties) continue;

      const nullLocations: NullLocation[] = [];
      collectNullPaths(resource.Properties, "", nullLocations, logicalId);

      for (const loc of nullLocations) {
        diagnostics.push({
          checkId: "WAW033",
          severity: "error",
          message: `${resource.Type} "${logicalId}" has a null value at Properties.${loc.path} — likely a .PropName AttrRef on a non-existent GetAtt attribute. Use Ref(resource) for the primary identifier, or check the attribute name.`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw033: PostSynthCheck = {
  id: "WAW033",
  description: "Null values in CFN resource properties — caused by invalid AttrRef (.PropName) usage",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkNullProperties(ctx);
  },
};
