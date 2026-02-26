/**
 * WHM302: Resource limits should be set (via values or defaults).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm302: PostSynthCheck = {
  id: "WHM302",
  description: "Container resources (limits/requests) should be set via values or defaults",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/") || filename.endsWith("_helpers.tpl") || filename.endsWith("NOTES.txt")) continue;
        if (filename.includes("tests/")) continue;

        // Check for workload types with containers
        const hasContainers = content.includes("containers:");
        const hasResources = content.includes("resources:") || content.includes(".Values.resources");

        if (hasContainers && !hasResources) {
          diagnostics.push({
            checkId: "WHM302",
            severity: "info",
            message: `${filename} has containers but no resource limits — consider using toYaml(values.resources) or setting defaults`,
            entity: filename,
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
