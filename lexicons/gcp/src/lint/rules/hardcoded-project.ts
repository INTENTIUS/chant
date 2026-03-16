import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WGC001: Hardcoded GCP Project ID
 *
 * Detects hardcoded GCP project IDs in code.
 * Project IDs should use GCP.ProjectId pseudo-parameter instead.
 */
export const hardcodedProjectRule: LintRule = {
  id: "WGC001",
  severity: "warning",
  category: "security",
  description: "Detects hardcoded GCP project IDs — use GCP.ProjectId pseudo-parameter instead",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    // GCP project ID pattern: lowercase letters, digits, hyphens, 6-30 chars
    // We look for strings in annotation contexts like "cnrm.cloud.google.com/project-id"
    const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

    // Common false positives
    const falsePositives = new Set([
      "chant", "default", "kube-system", "kube-public", "kube-node-lease",
      "config-connector", "cnrm-system", "my-project",
    ]);

    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
        const propName = node.name?.getText(sourceFile) ?? "";
        // Only flag project-id annotation values
        if (propName.includes("project-id") || propName.includes("projectId") || propName === '"cnrm.cloud.google.com/project-id"') {
          const initializer = ts.isPropertyAssignment(node) ? node.initializer : undefined;
          if (initializer && ts.isStringLiteral(initializer)) {
            const value = initializer.text;
            if (projectIdPattern.test(value) && !falsePositives.has(value)) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(initializer.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "WGC001",
                severity: "warning",
                message: `Hardcoded project ID "${value}" detected. Use GCP.ProjectId pseudo-parameter instead.`,
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
