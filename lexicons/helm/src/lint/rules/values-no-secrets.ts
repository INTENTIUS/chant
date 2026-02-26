/**
 * WHM002: Values Should Not Contain Bare Secrets
 *
 * Detects Values constructor props that contain keys suggesting sensitive
 * data (password, token, key, secret, apiKey) without an `existingSecret`
 * pattern — hardcoded secrets in values.yaml are a security anti-pattern.
 *
 * Bad:  new Values({ dbPassword: "hunter2" })
 * Good: new Values({ existingSecret: "", dbPasswordKey: "password" })
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

const SENSITIVE_KEY_PATTERN = /^(password|secret|token|apiKey|api_key|private_key|privateKey)$/i;
const SAFE_PATTERNS = /existing|ref|key_name|keyName|secretName/i;

export const valuesNoSecretsRule: LintRule = {
  id: "WHM002",
  severity: "warning",
  category: "security",
  description:
    "Values should not contain bare secrets — use existingSecret pattern instead",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for `new Values({ ... })`
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Values" &&
        node.arguments &&
        node.arguments.length > 0
      ) {
        const arg = node.arguments[0];
        if (ts.isObjectLiteralExpression(arg)) {
          checkObjectLiteral(arg, sourceFile, diagnostics);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};

function checkObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  diagnostics: LintDiagnostic[],
): void {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      const key = prop.name.text;

      // Check if the key looks sensitive
      if (SENSITIVE_KEY_PATTERN.test(key) && !SAFE_PATTERNS.test(key)) {
        // Check if the value is a string literal (hardcoded secret)
        if (ts.isStringLiteral(prop.initializer) && prop.initializer.text !== "") {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WHM002",
            severity: "warning",
            message: `Values key "${key}" contains a hardcoded secret — use existingSecret pattern or leave empty as default`,
          });
        }
      }

      // Recurse into nested objects
      if (ts.isObjectLiteralExpression(prop.initializer)) {
        checkObjectLiteral(prop.initializer, sourceFile, diagnostics);
      }
    }
  }
}
