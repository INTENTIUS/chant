/**
 * WHM005: Chart Has Sub-chart Dependencies But Generates No Templates
 *
 * A chart with HelmDependency entries but no templates/*.yaml files generates
 * an empty templates/ directory. Deploying it requires `helm dependency build`
 * as a non-obvious prerequisite.
 *
 * If you only need value overrides for an upstream chart, deploy it directly:
 *   helm upgrade upstream-chart -f values-override.yaml
 * and use ValuesOverride to generate the override file.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm005: PostSynthCheck = {
  id: "WHM005",
  description:
    "Chart with sub-chart dependencies but no templates should deploy upstream chart directly",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);
      const chartYaml = files["Chart.yaml"];
      if (!chartYaml) continue;

      // Check for non-empty dependencies block
      const hasDependencies = /^dependencies:/m.test(chartYaml);
      if (!hasDependencies) continue;

      // Check for template files (excluding _helpers.tpl and NOTES.txt)
      const hasTemplates = Object.keys(files).some((path) => {
        if (!path.startsWith("templates/")) return false;
        const filename = path.slice("templates/".length);
        if (filename === "_helpers.tpl" || filename === "NOTES.txt") return false;
        return filename.endsWith(".yaml") || filename.endsWith(".yml");
      });

      if (!hasTemplates) {
        diagnostics.push({
          checkId: "WHM005",
          severity: "warning",
          message:
            "Chart has sub-chart dependencies but generates no templates. Deploying this chart requires 'helm dependency build' first. If you only need value overrides for an upstream chart, deploy it directly with 'helm upgrade upstream-chart -f values-override.yaml' and use ValuesOverride to generate the override file.",
          lexicon: "helm",
        });
      }
    }

    return diagnostics;
  },
};
