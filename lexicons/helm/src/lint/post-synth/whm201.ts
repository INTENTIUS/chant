/**
 * WHM201: Resources should have standard Helm labels.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm201: PostSynthCheck = {
  id: "WHM201",
  description: "K8s resources should include standard Helm labels",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/") || filename.endsWith("_helpers.tpl") || filename.endsWith("NOTES.txt")) continue;

        // Check if the template references the standard labels helper
        if (content.includes("kind:") && !content.includes(".labels") && !content.includes("helm.sh/chart")) {
          diagnostics.push({
            checkId: "WHM201",
            severity: "info",
            message: `${filename} does not include standard Helm labels — consider using include "<chart>.labels"`,
            entity: filename,
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
