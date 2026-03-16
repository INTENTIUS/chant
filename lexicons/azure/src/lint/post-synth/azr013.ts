/**
 * AZR013: Resource Missing Location
 *
 * Warns when an ARM resource does not have a location property.
 * Most Azure resources require a location. Resources that are
 * inherently global (e.g., Microsoft.Resources/deployments) are excluded.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

/**
 * Resource types that do not require a location property.
 * These are global or subscription-level resources.
 */
const LOCATION_EXEMPT_TYPES = new Set([
  "Microsoft.Resources/deployments",
  "Microsoft.Authorization/roleAssignments",
  "Microsoft.Authorization/roleDefinitions",
  "Microsoft.Authorization/policyAssignments",
  "Microsoft.Authorization/policyDefinitions",
  "Microsoft.Authorization/locks",
  "Microsoft.Management/managementGroups",
  "Microsoft.Subscription/aliases",
]);

export const azr013: PostSynthCheck = {
  id: "AZR013",
  description: "Resource missing location — most Azure resources require a location property",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);

        // Skip resource types that don't need location
        if (LOCATION_EXEMPT_TYPES.has(resource.type)) continue;

        if (resource.location === undefined || resource.location === null || resource.location === "") {
          diagnostics.push({
            checkId: "AZR013",
            severity: "warning",
            message: `Resource "${resourceName}" (${resource.type}) is missing a location property`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
