/**
 * WHM101: Chart.yaml has required fields and valid apiVersion (v2).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles, parseChartYaml } from "./helm-helpers";

export const whm101: PostSynthCheck = {
  id: "WHM101",
  description: "Chart.yaml must have required fields (apiVersion v2, name, version)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);
      const chartYaml = files["Chart.yaml"];
      if (!chartYaml) {
        diagnostics.push({
          checkId: "WHM101",
          severity: "error",
          message: "Chart.yaml is missing from serializer output",
          lexicon: "helm",
        });
        continue;
      }

      const parsed = parseChartYaml(chartYaml);

      if (!parsed.apiVersion) {
        diagnostics.push({ checkId: "WHM101", severity: "error", message: "Chart.yaml missing apiVersion", lexicon: "helm" });
      } else if (parsed.apiVersion !== "v2") {
        diagnostics.push({ checkId: "WHM101", severity: "error", message: `Chart.yaml apiVersion should be "v2", got "${parsed.apiVersion}"`, lexicon: "helm" });
      }

      if (!parsed.name) {
        diagnostics.push({ checkId: "WHM101", severity: "error", message: "Chart.yaml missing name", lexicon: "helm" });
      }
      if (!parsed.version) {
        diagnostics.push({ checkId: "WHM101", severity: "error", message: "Chart.yaml missing version", lexicon: "helm" });
      }
    }

    return diagnostics;
  },
};
