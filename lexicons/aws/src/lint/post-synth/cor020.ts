/**
 * COR020: Circular Resource Dependencies
 *
 * Builds a directed dependency graph from Ref, Fn::GetAtt, and DependsOn
 * entries in the synthesized CloudFormation template. Detects cycles using
 * DFS with three-color marking (white/gray/black).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { detectCycles } from "@intentius/chant/discovery/cycles";
import { parseCFTemplate, findResourceRefs } from "./cf-refs";

export const cor020: PostSynthCheck = {
  id: "COR020",
  description: "Circular resource dependency — detects cycles in the resource dependency graph",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseCFTemplate(output);
      if (!template?.Resources) continue;

      const resourceIds = new Set(Object.keys(template.Resources));

      // Build adjacency list: resource → set of resources it depends on
      const graph = new Map<string, Set<string>>();

      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        const deps = new Set<string>();

        // Refs from Properties
        const propertyRefs = findResourceRefs(resource.Properties);
        for (const ref of propertyRefs) {
          if (resourceIds.has(ref) && ref !== logicalId) {
            deps.add(ref);
          }
        }

        // Explicit DependsOn
        if (resource.DependsOn) {
          const dependsOn = Array.isArray(resource.DependsOn)
            ? resource.DependsOn
            : [resource.DependsOn];
          for (const target of dependsOn) {
            if (resourceIds.has(target) && target !== logicalId) {
              deps.add(target);
            }
          }
        }

        graph.set(logicalId, deps);
      }

      // Detect cycles
      const cycles = detectCycles(graph);
      for (const cycle of cycles) {
        // Add trailing node for display: "A -> B -> C -> A"
        const chain = [...cycle, cycle[0]].join(" -> ");
        diagnostics.push({
          checkId: "COR020",
          severity: "error",
          message: `Circular resource dependency: ${chain}`,
          entity: cycle[0],
          lexicon: "aws",
        });
      }
    }

    return diagnostics;
  },
};
