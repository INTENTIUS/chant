/**
 * GHA015: Suggest Cache
 *
 * Flags setup action composites in steps without a corresponding Cache composite.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

const setupActionsNeedingCache = new Set(["SetupNode", "SetupGo", "SetupPython"]);

export const suggestCacheRule: LintRule = {
  id: "GHA015",
  severity: "warning",
  category: "performance",
  description: "Setup action should be paired with a Cache composite for faster builds",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for steps array with setup actions but no Cache
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "steps" &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        const elements = node.initializer.elements;
        let hasSetup = false;
        let setupName = "";
        let hasCache = false;

        for (const el of elements) {
          if (ts.isCallExpression(el)) {
            const name = ts.isIdentifier(el.expression) ? el.expression.text : "";
            if (setupActionsNeedingCache.has(name)) {
              hasSetup = true;
              setupName = name;
              // Check if the setup action already has cache in its props
              if (el.arguments.length > 0 && ts.isObjectLiteralExpression(el.arguments[0])) {
                const hasCacheProp = el.arguments[0].properties.some(
                  (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "cache",
                );
                if (hasCacheProp) hasCache = true;
              }
            }
            if (name === "Cache") hasCache = true;
          }
        }

        if (hasSetup && !hasCache) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "GHA015",
            severity: "warning",
            message: `${setupName}() found without Cache. Add a Cache() step or use the built-in cache option for faster builds.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
