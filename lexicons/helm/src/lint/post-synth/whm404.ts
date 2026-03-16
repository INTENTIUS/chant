/**
 * WHM404: `privileged: true` found — security risk.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm404: PostSynthCheck = {
  id: "WHM404",
  description: "Containers must not run in privileged mode",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/") || filename.endsWith("_helpers.tpl") || filename.endsWith("NOTES.txt")) continue;
        if (filename.includes("tests/")) continue;

        if (content.includes("privileged: true")) {
          diagnostics.push({
            checkId: "WHM404",
            severity: "error",
            message: `${filename}: privileged: true detected — containers should not run in privileged mode`,
            entity: filename,
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
