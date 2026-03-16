import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * AZR003: NSG Wildcard Source Address
 *
 * Detects Network Security Group rules with sourceAddressPrefix: "*".
 * Wildcard source addresses allow traffic from any source and should be
 * restricted to specific IP ranges or service tags.
 */
export const nsgWildcardRule: LintRule = {
  id: "AZR003",
  severity: "warning",
  category: "security",
  description: "Detects NSG rules with wildcard (*) source address — restrict to specific IP ranges or service tags",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for sourceAddressPrefix: "*" in object literals
      if (ts.isPropertyAssignment(node)) {
        const name = node.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
          const propName = ts.isIdentifier(name) ? name.text : name.text;

          if (propName === "sourceAddressPrefix") {
            // Check if value is "*"
            if (ts.isStringLiteral(node.initializer) && node.initializer.text === "*") {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "AZR003",
                severity: "warning",
                message: "NSG rule uses wildcard (*) sourceAddressPrefix. Restrict to specific IP ranges or service tags.",
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
