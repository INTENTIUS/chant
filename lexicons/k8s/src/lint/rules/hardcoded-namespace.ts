import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WK8001: Hardcoded Namespace
 *
 * Detects hardcoded namespace strings in Kubernetes resource constructors.
 * Namespaces should be parameterized or derived from configuration, not
 * hardcoded as string literals.
 *
 * Bad:  new Deployment({ metadata: { namespace: "production" } })
 * Good: new Deployment({ metadata: { namespace: config.namespace } })
 */
export const hardcodedNamespaceRule: LintRule = {
  id: "WK8001",
  severity: "warning",
  category: "correctness",
  description:
    "Detects hardcoded namespace strings — namespaces should be parameterized",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for property assignments like `namespace: "production"`
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "namespace" &&
        ts.isStringLiteral(node.initializer)
      ) {
        const value = node.initializer.text;
        // Skip empty strings — those are likely intentional placeholders
        if (value !== "") {
          const { line, character } =
            sourceFile.getLineAndCharacterOfPosition(
              node.initializer.getStart(),
            );
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WK8001",
            severity: "warning",
            message: `Hardcoded namespace "${value}" detected. Use a variable or configuration parameter instead.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
