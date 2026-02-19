import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR005: declarable-naming-convention
 *
 * Exported declarable instances (i.e. `export const x = new SomeClass(...)`)
 * must use camelCase names. Flags PascalCase and UPPER_SNAKE_CASE names.
 *
 * Triggers on: export const DataBucket = new Bucket({ ... })
 * Triggers on: export const DATA_BUCKET = new Bucket({ ... })
 * OK: export const dataBucket = new Bucket({ ... })
 * OK: export const DataBucket = createBucket({ ... })  (not a new expression)
 * OK: const DataBucket = new Bucket({ ... })  (not exported)
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isVariableStatement(node)) {
    const hasExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) {
      ts.forEachChild(node, child => checkNode(child, context, diagnostics));
      return;
    }

    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer || !ts.isNewExpression(decl.initializer)) continue;

      const name = decl.name.text;
      // camelCase starts with lowercase — that's fine
      if (/^[a-z]/.test(name)) continue;

      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        decl.name.getStart(context.sourceFile),
      );

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR005",
        severity: "warning",
        message: `Declarable '${name}' should use camelCase naming — rename to '${toCamelCase(name)}'.`,
      });
    }
  }

  ts.forEachChild(node, child => checkNode(child, context, diagnostics));
}

/** Suggest a camelCase version of a PascalCase or UPPER_SNAKE_CASE name */
function toCamelCase(name: string): string {
  // PascalCase -> camelCase: lowercase first char
  if (/^[A-Z][a-z]/.test(name)) {
    return name[0].toLowerCase() + name.slice(1);
  }
  // UPPER_SNAKE -> camelCase
  return name.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export const declarableNamingConventionRule: LintRule = {
  id: "COR005",
  severity: "warning",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
