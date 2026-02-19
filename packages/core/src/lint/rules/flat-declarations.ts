import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isInsideCompositeFactory } from "./composite-scope";

/**
 * COR001: No inline objects in Declarable constructors
 *
 * Detects inline object literals or array literals as property values
 * in Declarable constructor arguments. All structure should be expressed
 * through typed Declarable declarations, never inline object literals.
 *
 * Triggers on: new Bucket({ bucketEncryption: { serverSideEncryptionConfiguration: [...] } })
 * Triggers on: new Bucket({ tags: [{ key: "env", value: "prod" }] })
 * OK: new Bucket({ bucketName: "my-bucket", accessControl: "Private" })
 * OK: new Bucket({ encryption: dataEncryption })
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  // Check for NewExpression nodes (constructor calls)
  // Skip resource constructors inside Composite() factory callbacks
  if (ts.isNewExpression(node) && !isInsideCompositeFactory(node)) {
    // Check if the first argument is an object literal
    if (node.arguments && node.arguments.length > 0) {
      const firstArg = node.arguments[0];

      if (ts.isObjectLiteralExpression(firstArg)) {
        // Check each property in the constructor argument
        for (const property of firstArg.properties) {
          if (ts.isPropertyAssignment(property)) {
            const initializer = property.initializer;

            // Flag inline object literals
            // Flag array literals only if they contain inline objects/arrays
            if (ts.isObjectLiteralExpression(initializer) ||
                (ts.isArrayLiteralExpression(initializer) && initializer.elements.some(
                  el => ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el)
                ))) {
              const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
                initializer.getStart(context.sourceFile)
              );

              diagnostics.push({
                file: context.filePath,
                line: line + 1,
                column: character + 1,
                ruleId: "COR001",
                severity: "warning",
                message: "Inline object in Declarable constructor — extract to a named 'const' with 'export'. Each config value should be its own Declarable.",
              });
            }
          }
        }
      }
    }
  }

  // Recursively check child nodes
  ts.forEachChild(node, child => checkNode(child, context, diagnostics));
}

export const flatDeclarationsRule: LintRule = {
  id: "COR001",
  severity: "warning",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
