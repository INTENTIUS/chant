/**
 * WHM203: Values entries should be documented.
 *
 * Checks that values.yaml has YAML comments or that values.schema.json
 * provides descriptions. Since Chant generates values.yaml from code,
 * this check looks for values.schema.json as the documentation source.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm203: PostSynthCheck = {
  id: "WHM203",
  description: "Values entries should be documented via schema or comments",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);
      const valuesYaml = files["values.yaml"];
      const schemaJson = files["values.schema.json"];

      if (!valuesYaml || valuesYaml.trim() === "{}") continue;

      // If no schema, values are undocumented
      if (!schemaJson) {
        diagnostics.push({
          checkId: "WHM203",
          severity: "info",
          message: "Values are not documented — add a Values type to generate values.schema.json",
          lexicon: "helm",
        });
      }
    }

    return diagnostics;
  },
};
