import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR010: no-unused-declarable-import
 *
 * Namespace imports from @intentius/chant* must be referenced.
 *
 * Triggers on: import * as <name> from "@intentius/chant-lexicon-<name>" (when <name>. never appears)
 * OK: import * as <name> from "@intentius/chant-lexicon-<name>" (when <name>.Bucket is used)
 * OK: import type * as core from "@intentius/chant" (type-only)
 */

interface NamespaceImportInfo {
  name: string;
  node: ts.ImportDeclaration;
}

function collectNamespaceImports(sourceFile: ts.SourceFile): NamespaceImportInfo[] {
  const imports: NamespaceImportInfo[] = [];

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node)) return;

    const moduleSpecifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) return;
    if (!moduleSpecifier.text.startsWith("@intentius/chant") && !moduleSpecifier.text.startsWith("@intentius/chant-lexicon-")) return;

    // Skip type-only imports
    if (node.importClause?.isTypeOnly) return;

    const importClause = node.importClause;
    if (!importClause?.namedBindings) return;

    // Only check namespace imports (import * as X)
    if (ts.isNamespaceImport(importClause.namedBindings)) {
      imports.push({
        name: importClause.namedBindings.name.text,
        node,
      });
    }
  });

  return imports;
}

function isNamespaceUsed(name: string, sourceFile: ts.SourceFile): boolean {
  let used = false;

  function visit(node: ts.Node): void {
    if (used) return;

    // Check for property access: name.something
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === name) {
        used = true;
        return;
      }
    }

    // Check for qualified names in types: name.Type
    if (ts.isQualifiedName(node)) {
      if (ts.isIdentifier(node.left) && node.left.text === name) {
        used = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return used;
}

export const noUnusedDeclarableImportRule: LintRule = {
  id: "COR010",
  severity: "warning",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const imports = collectNamespaceImports(context.sourceFile);

    for (const imp of imports) {
      if (!isNamespaceUsed(imp.name, context.sourceFile)) {
        const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
          imp.node.getStart(context.sourceFile),
        );

        diagnostics.push({
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: "COR010",
          severity: "warning",
          message: `Namespace import '${imp.name}' is never used — remove the import or use ${imp.name}.<resource>.`,
        });
      }
    }

    return diagnostics;
  },
};
