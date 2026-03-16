/**
 * WHM403: No `readOnlyRootFilesystem` security context.
 *
 * For files with `containers:`, checks for `readOnlyRootFilesystem: true`
 * or a `.Values.securityContext` reference.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm403: PostSynthCheck = {
  id: "WHM403",
  description: "Containers should set readOnlyRootFilesystem in security context",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/") || filename.endsWith("_helpers.tpl") || filename.endsWith("NOTES.txt")) continue;
        if (filename.includes("tests/")) continue;

        const hasContainers = content.includes("containers:");
        if (!hasContainers) continue;

        const hasReadOnly = content.includes("readOnlyRootFilesystem: true");
        const hasSecurityContextRef = content.includes(".Values.securityContext") || content.includes(".Values.podSecurityContext");

        if (!hasReadOnly && !hasSecurityContextRef) {
          diagnostics.push({
            checkId: "WHM403",
            severity: "info",
            message: `${filename}: containers lack readOnlyRootFilesystem — consider setting securityContext.readOnlyRootFilesystem: true`,
            entity: filename,
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
