/**
 * WHM401: Image uses `:latest` tag or no tag.
 *
 * Scans template `image:` lines for literal values (not `.Values` refs)
 * ending in `:latest` or missing `:`.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm401: PostSynthCheck = {
  id: "WHM401",
  description: "Container images should not use :latest tag or omit tag entirely",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/") || filename.endsWith("_helpers.tpl") || filename.endsWith("NOTES.txt")) continue;
        if (filename.includes("tests/")) continue;

        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("image:")) continue;
          const value = trimmed.slice("image:".length).trim();

          // Skip template references
          if (value.includes(".Values") || value.includes("{{")) continue;

          // Check for :latest or no tag
          if (value.endsWith(":latest") || value.endsWith(":latest'") || value.endsWith(':latest"')) {
            diagnostics.push({
              checkId: "WHM401",
              severity: "warning",
              message: `${filename}: image uses :latest tag — pin to a specific version for reproducible deployments`,
              entity: filename,
              lexicon: "helm",
            });
          } else if (value && !value.includes(":") && !value.includes("{{")) {
            diagnostics.push({
              checkId: "WHM401",
              severity: "warning",
              message: `${filename}: image has no tag — defaults to :latest, pin to a specific version`,
              entity: filename,
              lexicon: "helm",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
