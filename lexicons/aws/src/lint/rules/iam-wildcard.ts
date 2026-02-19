import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WAW009: IAM Wildcard Resource
 *
 * Detects IAM policies with wildcard (*) resources.
 * Policies should specify explicit resources for better security.
 */
export const iamWildcardRule: LintRule = {
  id: "WAW009",
  severity: "warning",
  category: "security",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for Resource: "*" in object literals
      if (ts.isPropertyAssignment(node)) {
        const name = node.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
          const propName = ts.isIdentifier(name) ? name.text : name.text;

          // Check for Resource or Resources property
          if (propName.toLowerCase() === "resource" || propName.toLowerCase() === "resources") {
            // Check if value is "*"
            if (ts.isStringLiteral(node.initializer) && node.initializer.text === "*") {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "WAW009",
                severity: "warning",
                message: "IAM policy uses wildcard (*) resource. Specify explicit resource ARNs for better security.",
              });
            }
            // Check if array contains "*"
            else if (ts.isArrayLiteralExpression(node.initializer)) {
              for (const element of node.initializer.elements) {
                if (ts.isStringLiteral(element) && element.text === "*") {
                  const { line, character } = sourceFile.getLineAndCharacterOfPosition(element.getStart());
                  diagnostics.push({
                    file: sourceFile.fileName,
                    line: line + 1,
                    column: character + 1,
                    ruleId: "WAW009",
                    severity: "warning",
                    message: "IAM policy uses wildcard (*) resource. Specify explicit resource ARNs for better security.",
                  });
                }
              }
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
