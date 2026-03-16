import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * AZR002: Storage Account HTTPS Only
 *
 * Detects Storage Account creation without supportsHttpsTrafficOnly: true.
 * All storage accounts should enforce HTTPS-only traffic.
 */
export const storageHttpsRule: LintRule = {
  id: "AZR002",
  severity: "warning",
  category: "security",
  description: "Detects Storage Accounts without supportsHttpsTrafficOnly enabled — all storage accounts should enforce HTTPS",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for `new StorageAccount(...)` or `new storage.StorageAccount(...)`
      if (ts.isNewExpression(node)) {
        const expression = node.expression;
        let isStorageAccount = false;

        // Check for `new StorageAccount(...)`
        if (ts.isIdentifier(expression) && expression.text === "StorageAccount") {
          isStorageAccount = true;
        }
        // Check for `new storage.StorageAccount(...)` or `new azure.storage.StorageAccount(...)`
        else if (ts.isPropertyAccessExpression(expression)) {
          if (expression.name.text === "StorageAccount") {
            isStorageAccount = true;
          }
        }

        if (isStorageAccount && node.arguments && node.arguments.length > 0) {
          const props = node.arguments[0];
          if (ts.isObjectLiteralExpression(props)) {
            const hasHttpsOnly = props.properties.some((prop) => {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                if (prop.name.text === "supportsHttpsTrafficOnly") {
                  // Check that it's set to true
                  return prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
                }
              }
              return false;
            });

            if (!hasHttpsOnly) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "AZR002",
                severity: "warning",
                message: "Storage Account created without supportsHttpsTrafficOnly: true. Enable HTTPS-only traffic.",
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
