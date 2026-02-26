/**
 * WHM105: _helpers.tpl exists.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm105: PostSynthCheck = {
  id: "WHM105",
  description: "_helpers.tpl must exist in templates/",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      if (!files["templates/_helpers.tpl"]) {
        diagnostics.push({
          checkId: "WHM105",
          severity: "warning",
          message: "templates/_helpers.tpl is missing",
          lexicon: "helm",
        });
      }
    }

    return diagnostics;
  },
};
