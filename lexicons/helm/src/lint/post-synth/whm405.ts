/**
 * WHM405: Resource spec missing `cpu`/`memory` in `limits`/`requests`.
 *
 * When `resources:` is present (not via `.Values`), validates that
 * sub-keys `limits` and `requests` with `cpu`/`memory` exist.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm405: PostSynthCheck = {
  id: "WHM405",
  description: "Resource specs should include cpu and memory in limits/requests",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/") || filename.endsWith("_helpers.tpl") || filename.endsWith("NOTES.txt")) continue;
        if (filename.includes("tests/")) continue;

        // Skip if resources are via values
        if (!content.includes("resources:") || content.includes(".Values.resources")) continue;

        const hasLimits = content.includes("limits:");
        const hasRequests = content.includes("requests:");

        if (!hasLimits && !hasRequests) continue;

        const hasCpu = content.includes("cpu:");
        const hasMemory = content.includes("memory:");

        if (!hasCpu || !hasMemory) {
          const missing = [];
          if (!hasCpu) missing.push("cpu");
          if (!hasMemory) missing.push("memory");
          diagnostics.push({
            checkId: "WHM405",
            severity: "warning",
            message: `${filename}: resource spec missing ${missing.join(" and ")} — set both cpu and memory in limits/requests`,
            entity: filename,
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
