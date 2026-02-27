/**
 * AZR010: Redundant DependsOn
 *
 * Detects dependsOn entries that are already implied by reference() or
 * resourceId() bracket expressions in the resource's properties. ARM
 * automatically creates dependencies for these references, making
 * explicit dependsOn redundant.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate, findArmResourceRefs, extractRefsFromExpression } from "./arm-refs";

export const azr010: PostSynthCheck = {
  id: "AZR010",
  description: "Redundant dependsOn — target is already referenced via reference() or resourceId() in properties",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (!resource.dependsOn || resource.dependsOn.length === 0) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);

        // Find all refs in properties
        const propertyRefs = findArmResourceRefs(resource.properties);

        for (const dep of resource.dependsOn) {
          // dependsOn entries may be bracket expressions like [resourceId('Type', 'name')]
          // or plain resource names
          const depNames = dep.startsWith("[") ? extractRefsFromExpression(dep) : [dep];

          for (const depName of depNames) {
            if (propertyRefs.has(depName)) {
              diagnostics.push({
                checkId: "AZR010",
                severity: "warning",
                message: `Resource "${resourceName}" has redundant dependsOn "${depName}" — already referenced in properties`,
                entity: resourceName,
                lexicon: "azure",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
