/**
 * WHM001: Chart Metadata Required
 *
 * Detects Chart constructors missing required fields: name, version, apiVersion.
 *
 * Bad:  new Chart({})
 * Good: new Chart({ apiVersion: "v2", name: "my-app", version: "0.1.0" })
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

const REQUIRED_FIELDS = ["name", "version", "apiVersion"];

export const chartMetadataRule: LintRule = {
  id: "WHM001",
  severity: "error",
  category: "correctness",
  description:
    "Chart must have name, version, and apiVersion fields",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for `new Chart({ ... })`
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Chart" &&
        node.arguments &&
        node.arguments.length > 0
      ) {
        const arg = node.arguments[0];
        if (ts.isObjectLiteralExpression(arg)) {
          const presentKeys = new Set<string>();
          for (const prop of arg.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
              presentKeys.add(prop.name.text);
            }
          }

          const missing = REQUIRED_FIELDS.filter((f) => !presentKeys.has(f));
          if (missing.length > 0) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            diagnostics.push({
              file: sourceFile.fileName,
              line: line + 1,
              column: character + 1,
              ruleId: "WHM001",
              severity: "error",
              message: `Chart is missing required fields: ${missing.join(", ")}`,
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
