/**
 * WHM202: Hook weights should be defined for multi-hook charts.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm202: PostSynthCheck = {
  id: "WHM202",
  description: "Hook weights should be defined when multiple hooks exist",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      const hooksWithWeight: string[] = [];
      const hooksWithoutWeight: string[] = [];

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/")) continue;

        if (content.includes("helm.sh/hook:") && !content.includes("helm.sh/hook: test")) {
          if (content.includes("helm.sh/hook-weight:")) {
            hooksWithWeight.push(filename);
          } else {
            hooksWithoutWeight.push(filename);
          }
        }
      }

      // Only warn if there are multiple hooks and some lack weights
      const totalHooks = hooksWithWeight.length + hooksWithoutWeight.length;
      if (totalHooks > 1 && hooksWithoutWeight.length > 0) {
        for (const filename of hooksWithoutWeight) {
          diagnostics.push({
            checkId: "WHM202",
            severity: "warning",
            message: `${filename} has a hook but no hook-weight — define weights to control execution order in multi-hook charts`,
            entity: filename,
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
