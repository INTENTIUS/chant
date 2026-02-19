/**
 * WGL001: Deprecated only/except keywords
 *
 * Flags usage of `only:` and `except:` in GitLab CI jobs.
 * These keywords are deprecated in favor of `rules:` which provides
 * more flexible conditional execution.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

export const deprecatedOnlyExceptRule: LintRule = {
  id: "WGL001",
  severity: "warning",
  category: "style",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for property assignments named "only" or "except"
      // inside new Job(...) or similar constructor calls
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
        const propName = node.name.text;
        if (propName === "only" || propName === "except") {
          // Check if this is inside a new expression (Job constructor)
          let parent: ts.Node | undefined = node.parent;
          while (parent) {
            if (ts.isNewExpression(parent)) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "WGL001",
                severity: "warning",
                message: `"${propName}" is deprecated. Use "rules" for conditional job execution instead.`,
              });
              break;
            }
            parent = parent.parent;
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
