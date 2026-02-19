import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR002: barrel-import-style
 *
 * Enforce `import * as _` for local `_.ts` barrel imports.
 *
 * Triggers on: import { bucketEncryption } from "./_"
 * OK: import * as _ from "./_"
 * OK: import type { Config } from "./_"
 */

const barrelPattern = /^\.\/(_|_\..*)$/;

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isImportDeclaration(node)) {
    const moduleSpecifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) return;

    const modulePath = moduleSpecifier.text;
    if (!barrelPattern.test(modulePath)) return;

    // Skip type-only imports: import type { X } from "..."
    if (node.importClause?.isTypeOnly) return;

    const importClause = node.importClause;
    if (!importClause?.namedBindings) return;

    // Flag named imports (not namespace imports)
    if (ts.isNamedImports(importClause.namedBindings)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile)
      );

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR002",
        severity: "error",
        message: `Use namespace import for local barrel — replace with: import * as _ from "./_"`,
      });
    }
  }

  ts.forEachChild(node, child => checkNode(child, context, diagnostics));
}

export const barrelImportStyleRule: LintRule = {
  id: "COR002",
  severity: "error",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
