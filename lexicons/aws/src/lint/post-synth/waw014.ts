/**
 * WAW014: Nested stack outputs never referenced from parent
 *
 * Warns when a nestedStack() is declared but none of its outputs are
 * referenced from the parent template. Could just be a separate build.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { isChildProject } from "@intentius/chant/child-project";

export const waw014: PostSynthCheck = {
  id: "WAW014",
  description: "Nested stack outputs never referenced from parent — could just be a separate build",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    // Collect child project names
    const childProjectNames = new Set<string>();
    for (const [name, entity] of ctx.entities) {
      if (isChildProject(entity)) {
        childProjectNames.add(name);
      }
    }

    if (childProjectNames.size === 0) return diagnostics;

    // Parse the primary template to check for Fn::GetAtt on nested stacks
    for (const [_lexicon, output] of ctx.outputs) {
      const json = getPrimaryOutput(output);

      for (const stackName of childProjectNames) {
        // Check if any Fn::GetAtt references this stack's outputs
        const hasRef = json.includes(`"Fn::GetAtt"`) && json.includes(`"${stackName}"`);
        if (!hasRef) {
          diagnostics.push({
            checkId: "WAW014",
            severity: "warning",
            message: `Nested stack "${stackName}" outputs are never referenced — consider building it separately`,
            entity: stackName,
            lexicon: "aws",
          });
        }
      }
    }

    return diagnostics;
  },
};
