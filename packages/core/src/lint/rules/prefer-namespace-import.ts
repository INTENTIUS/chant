import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR006: prefer-namespace-import
 *
 * Enforce `import * as pkg` for `@intentius/chant*` package imports.
 *
 * Triggers on: import { Bucket } from "@intentius/chant-lexicon-<name>"
 * OK: import * as <name> from "@intentius/chant-lexicon-<name>"
 * OK: import type { Declarable } from "@intentius/chant"
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isImportDeclaration(node)) {
    const moduleSpecifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) return;

    const modulePath = moduleSpecifier.text;
    if (!modulePath.startsWith("@intentius/chant") && !modulePath.startsWith("@intentius/chant-lexicon-")) return;

    // Skip type-only imports: import type { X } from "..."
    if (node.importClause?.isTypeOnly) return;

    const importClause = node.importClause;
    if (!importClause?.namedBindings) return;

    // Flag named imports (not namespace imports)
    if (ts.isNamedImports(importClause.namedBindings)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile)
      );

      const pkgName = modulePath === "@intentius/chant"
        ? "core"
        : modulePath.startsWith("@intentius/chant-lexicon-")
          ? modulePath.replace("@intentius/chant-lexicon-", "")
          : modulePath.replace("@intentius/chant-", "");

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR006",
        severity: "error",
        message: `Use namespace import for ${modulePath} — replace with: import * as ${pkgName} from "${modulePath}"`,
      });
    }
  }

  ts.forEachChild(node, child => checkNode(child, context, diagnostics));
}

export const preferNamespaceImportRule: LintRule = {
  id: "COR006",
  severity: "error",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
