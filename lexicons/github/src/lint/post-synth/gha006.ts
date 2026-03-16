/**
 * GHA006: Duplicate Workflow Name
 *
 * Detects multiple workflows sharing the same `name:` value.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { extractWorkflowName } from "./yaml-helpers";
import type { SerializerResult } from "@intentius/chant/serializer";

export const gha006: PostSynthCheck = {
  id: "GHA006",
  description: "Multiple workflows share the same name",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const nameMap = new Map<string, string[]>();

    for (const [outputName, output] of ctx.outputs) {
      const yaml = typeof output === "string" ? output : (output as SerializerResult).primary;

      // Check if this is a multi-file output
      if (typeof output === "object" && "files" in output) {
        const result = output as SerializerResult;
        if (result.files) {
          for (const [fileName, fileContent] of Object.entries(result.files)) {
            const name = extractWorkflowName(fileContent);
            if (name) {
              const existing = nameMap.get(name) ?? [];
              existing.push(fileName);
              nameMap.set(name, existing);
            }
          }
        }
      } else {
        const name = extractWorkflowName(yaml);
        if (name) {
          const existing = nameMap.get(name) ?? [];
          existing.push(outputName);
          nameMap.set(name, existing);
        }
      }
    }

    for (const [name, files] of nameMap) {
      if (files.length > 1) {
        diagnostics.push({
          checkId: "GHA006",
          severity: "error",
          message: `Duplicate workflow name "${name}" found in: ${files.join(", ")}`,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
