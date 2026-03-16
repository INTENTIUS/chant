import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WGC003: Public IAM Binding
 *
 * Warns on allUsers or allAuthenticatedUsers IAM bindings,
 * which grant public access to GCP resources.
 */
export const publicIamRule: LintRule = {
  id: "WGC003",
  severity: "warning",
  category: "security",
  description: "Warns on allUsers/allAuthenticatedUsers IAM members — grants public access",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    const publicMembers = new Set(["allUsers", "allAuthenticatedUsers"]);

    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node)) {
        const value = node.text;
        if (publicMembers.has(value)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WGC003",
            severity: "warning",
            message: `Public IAM member "${value}" detected. This grants access to everyone${value === "allAuthenticatedUsers" ? " with a Google account" : " on the internet"}.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
