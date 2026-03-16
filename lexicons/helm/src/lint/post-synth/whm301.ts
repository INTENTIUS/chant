/**
 * WHM301: At least one test should be defined for application charts.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles, parseChartYaml } from "./helm-helpers";

export const whm301: PostSynthCheck = {
  id: "WHM301",
  description: "Application charts should include at least one Helm test",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);
      const chartYaml = files["Chart.yaml"];
      if (!chartYaml) continue;

      const parsed = parseChartYaml(chartYaml);
      if (parsed.type === "library") continue;

      // Check if any template has helm.sh/hook: test
      const hasTest = Object.entries(files).some(
        ([filename, content]) =>
          filename.startsWith("templates/") && content.includes("helm.sh/hook: test"),
      );

      if (!hasTest) {
        diagnostics.push({
          checkId: "WHM301",
          severity: "info",
          message: "No Helm test defined — consider adding a HelmTest for chart validation",
          lexicon: "helm",
        });
      }
    }

    return diagnostics;
  },
};
