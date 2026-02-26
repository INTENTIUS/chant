/**
 * WHM102: values.schema.json present when Values type is used.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm102: PostSynthCheck = {
  id: "WHM102",
  description: "values.schema.json should be present when Values are non-empty",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);
      const valuesYaml = files["values.yaml"];
      const valuesSchema = files["values.schema.json"];

      // If values.yaml has content (not just "{}"), schema should exist
      if (valuesYaml && valuesYaml.trim() !== "{}" && !valuesSchema) {
        diagnostics.push({
          checkId: "WHM102",
          severity: "warning",
          message: "values.schema.json is missing — consider adding typed Values to generate a schema",
          lexicon: "helm",
        });
      }
    }

    return diagnostics;
  },
};
