/**
 * WHM501: Unused values keys.
 *
 * Parses values.yaml key paths and scans all template files for
 * `.Values.` references. Keys defined but never referenced produce
 * an info diagnostic.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

/** Keys that are always implicitly used (e.g. in _helpers.tpl). */
const IMPLICIT_KEYS = new Set(["nameOverride", "fullnameOverride"]);

/**
 * Extract all top-level and nested key paths from values.yaml content.
 * Uses indentation to track nesting (2-space indent per level).
 */
function extractValuePaths(content: string): string[] {
  const paths: string[] = [];
  const stack: string[] = [];
  let prevIndent = -1;

  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;

    const indent = line.length - trimmed.length;
    const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    if (!match) continue;

    const key = match[1];

    // Adjust stack based on indentation
    while (stack.length > 0 && indent <= prevIndent) {
      stack.pop();
      prevIndent -= 2;
    }

    stack.push(key);
    paths.push(stack.join("."));
    prevIndent = indent;
  }

  return paths;
}

export const whm501: PostSynthCheck = {
  id: "WHM501",
  description: "Detect values keys that are defined but never referenced in templates",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);
      const valuesContent = files["values.yaml"];
      if (!valuesContent || valuesContent.trim() === "{}" || valuesContent.trim() === "") continue;

      const definedPaths = extractValuePaths(valuesContent);
      if (definedPaths.length === 0) continue;

      // Collect all .Values references from templates
      const referencedPaths = new Set<string>();
      const valuesRegex = /\.Values\.([a-zA-Z0-9_.]+)/g;

      for (const [filename, content] of Object.entries(files)) {
        if (!filename.startsWith("templates/")) continue;
        let match;
        while ((match = valuesRegex.exec(content)) !== null) {
          referencedPaths.add(match[1]);
        }
      }

      for (const path of definedPaths) {
        if (IMPLICIT_KEYS.has(path)) continue;

        // Check if this path or any child is referenced
        const isReferenced = referencedPaths.has(path) ||
          [...referencedPaths].some((ref) => ref.startsWith(path + "."));

        // Check if any parent of this path is referenced (parent consumed entirely)
        const parts = path.split(".");
        const parentReferenced = parts.some((_, i) => {
          if (i === parts.length - 1) return false;
          return referencedPaths.has(parts.slice(0, i + 1).join("."));
        });

        if (!isReferenced && !parentReferenced) {
          diagnostics.push({
            checkId: "WHM501",
            severity: "info",
            message: `values.yaml defines "${path}" but it is never referenced in templates`,
            entity: "values.yaml",
            lexicon: "helm",
          });
        }
      }
    }

    return diagnostics;
  },
};
