/**
 * WGL004: Artifacts without expiry
 *
 * Artifacts without `expireIn` (or `expire_in`) will be kept indefinitely,
 * wasting storage. Always set an expiry for job artifacts.
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

export const artifactNoExpiryRule: LintRule = {
  id: "WGL004",
  severity: "warning",
  category: "performance",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node)) {
        let isArtifacts = false;
        const expression = node.expression;

        if (ts.isIdentifier(expression) && expression.text === "Artifacts") {
          isArtifacts = true;
        } else if (ts.isPropertyAccessExpression(expression) && expression.name.text === "Artifacts") {
          isArtifacts = true;
        }

        if (isArtifacts && node.arguments && node.arguments.length > 0) {
          const props = node.arguments[0];
          if (ts.isObjectLiteralExpression(props)) {
            const hasExpiry = props.properties.some((prop) => {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                return prop.name.text === "expireIn" || prop.name.text === "expire_in";
              }
              return false;
            });

            if (!hasExpiry) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "WGL004",
                severity: "warning",
                message: 'Artifacts without "expireIn" will be kept indefinitely. Set an expiry to save storage.',
              });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
