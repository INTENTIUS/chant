/**
 * GHA001: Use Typed Action Composites
 *
 * Flags raw `uses:` string literals when a matching typed composite exists.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";
import { knownActions } from "./data/known-actions";

export const useTypedActionsRule: LintRule = {
  id: "GHA001",
  severity: "warning",
  category: "style",
  description: "Use typed action composite instead of raw uses: string",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "uses") {
        if (ts.isStringLiteral(node.initializer)) {
          const value = node.initializer.text;
          // Extract action name without version: "actions/checkout@v4" → "actions/checkout"
          const actionName = value.split("@")[0];
          const match = knownActions[actionName];
          if (match) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            diagnostics.push({
              file: sourceFile.fileName,
              line: line + 1,
              column: character + 1,
              ruleId: "GHA001",
              severity: "warning",
              message: `Use the typed ${match.composite}() composite instead of raw "${value}" string.`,
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
