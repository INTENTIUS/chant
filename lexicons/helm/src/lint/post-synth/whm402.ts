/**
 * WHM402: No `runAsNonRoot` security context.
 *
 * For files with `containers:`, checks for `runAsNonRoot: true` or
 * a `.Values.securityContext` reference.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm402: PostSynthCheck = {
  id: "WHM402",
  description: "Containers should set runAsNonRoot in security context",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/") || filename.endsWith("_helpers.tpl") || filename.endsWith("NOTES.txt")) continue;
        if (filename.includes("tests/")) continue;

        const hasContainers = content.includes("containers:");
        if (!hasContainers) continue;

        const hasRunAsNonRoot = content.includes("runAsNonRoot: true") || content.includes("runAsNonRoot: true");
        const hasSecurityContextRef = content.includes(".Values.securityContext") || content.includes(".Values.podSecurityContext");

        if (!hasRunAsNonRoot && !hasSecurityContextRef) {
          diagnostics.push({
            checkId: "WHM402",
            severity: "warning",
            message: `${filename}: containers lack runAsNonRoot — set securityContext.runAsNonRoot: true or use .Values.securityContext`,
            entity: filename,
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
