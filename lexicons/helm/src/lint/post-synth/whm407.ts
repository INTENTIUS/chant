/**
 * WHM407: `kind: Secret` with inline `data:` values and no ExternalSecret/SealedSecret.
 *
 * Warns when secrets contain inline data values (not `.Values` refs) and the chart
 * does not use ExternalSecret or SealedSecret resources.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

export const whm407: PostSynthCheck = {
  id: "WHM407",
  description: "Secrets with inline data should use ExternalSecret or SealedSecret",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);

      // Check if chart uses ExternalSecret or SealedSecret anywhere
      const allContent = Object.values(files).join("\n");
      const hasExternalSecret = allContent.includes("ExternalSecret") || allContent.includes("SealedSecret");

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/") || filename.endsWith("_helpers.tpl") || filename.endsWith("NOTES.txt")) continue;
        if (filename.includes("tests/")) continue;

        if (!content.includes("kind: Secret")) continue;

        // Scan for inline data values in data: or stringData: sections
        const lines = content.split("\n");
        let inData = false;
        let dataIndent = -1;
        let hasLiteralValues = false;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;

          const indent = line.length - line.trimStart().length;

          if (trimmed === "data:" || trimmed === "stringData:") {
            inData = true;
            dataIndent = indent;
            continue;
          }

          if (inData) {
            // If we've returned to the same or lower indent level, exit data section
            if (indent <= dataIndent && trimmed) {
              inData = false;
              dataIndent = -1;
              continue;
            }
            // Check if value is a literal (not a template expression)
            if (!trimmed.includes("{{") && !trimmed.includes(".Values")) {
              const colonIdx = trimmed.indexOf(":");
              if (colonIdx > 0 && trimmed.length > colonIdx + 1 && trimmed[colonIdx + 1] === " ") {
                const val = trimmed.slice(colonIdx + 1).trim();
                if (val) {
                  hasLiteralValues = true;
                }
              }
            }
          }
        }

        if (hasLiteralValues && !hasExternalSecret) {
          diagnostics.push({
            checkId: "WHM407",
            severity: "warning",
            message: `${filename}: Secret with inline data values — consider using ExternalSecret or SealedSecret for secret management`,
            entity: filename,
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
