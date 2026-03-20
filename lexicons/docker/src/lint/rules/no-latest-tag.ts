/**
 * DKRS001: No Latest Tag
 *
 * Warns when a Service's image prop is set to a literal string
 * ending with `:latest` or has no tag (implies latest).
 * Using `:latest` prevents reproducible builds.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

function isLatestImage(imageValue: string): boolean {
  const trimmed = imageValue.trim();
  if (!trimmed || trimmed.startsWith("${")) return false;
  // Has :latest tag
  if (trimmed.endsWith(":latest")) return true;
  // No tag at all (no colon after image name, no @sha256)
  const parts = trimmed.split("/");
  const lastPart = parts[parts.length - 1];
  if (!lastPart.includes(":") && !lastPart.includes("@")) return true;
  return false;
}

export const noLatestTagRule: LintRule = {
  id: "DKRS001",
  severity: "warning",
  category: "correctness",
  description: "Avoid :latest or untagged image references — use explicit version tags for reproducible builds",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for `image: "..."` in object literals (properties named "image")
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "image"
      ) {
        const init = node.initializer;
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          const text = init.text;
          if (isLatestImage(text)) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            diagnostics.push({
              file: sourceFile.fileName,
              line: line + 1,
              column: character + 1,
              ruleId: "DKRS001",
              severity: "warning",
              message: `Image "${text}" uses :latest or has no tag. Use an explicit version tag (e.g., "nginx:1.25-alpine") for reproducible builds.`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
