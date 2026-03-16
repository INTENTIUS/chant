/**
 * WHM104: NOTES.txt exists for application charts.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles, parseChartYaml } from "./helm-helpers";

export const whm104: PostSynthCheck = {
  id: "WHM104",
  description: "NOTES.txt should exist for application charts",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);
      const chartYaml = files["Chart.yaml"];
      if (!chartYaml) continue;

      const parsed = parseChartYaml(chartYaml);
      if (parsed.type === "library") continue; // Libraries don't need NOTES.txt

      if (!files["templates/NOTES.txt"]) {
        diagnostics.push({
          checkId: "WHM104",
          severity: "info",
          message: "NOTES.txt is missing — consider adding installation notes for users",
          lexicon: "helm",
        });
      }
    }

    return diagnostics;
  },
};
