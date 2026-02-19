/**
 * WAW013: Child project has no stackOutput() exports
 *
 * When a parent uses nestedStack() to reference a child project, the child
 * must declare at least one stackOutput() — otherwise the parent can't
 * reference any of its values.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isChildProject } from "@intentius/chant/child-project";
import { isStackOutput } from "@intentius/chant/stack-output";

export const waw013: PostSynthCheck = {
  id: "WAW013",
  description: "Child project has no stackOutput() exports — parent can't reference anything",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (isChildProject(entity) && entity.buildResult) {
        // Check if the child has any StackOutput entities
        let hasOutputs = false;
        for (const [, childEntity] of entity.buildResult.entities) {
          if (isStackOutput(childEntity)) {
            hasOutputs = true;
            break;
          }
        }

        if (!hasOutputs) {
          diagnostics.push({
            checkId: "WAW013",
            severity: "error",
            message: `Nested stack "${name}" child project has no stackOutput() exports — parent can't reference any values`,
            entity: name,
            lexicon: "aws",
          });
        }
      }
    }

    return diagnostics;
  },
};
