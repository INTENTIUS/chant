import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR004: no-unused-declarable
 *
 * Detects exported declarables (export const x = new X(...)) that are never
 * referenced elsewhere in the same file. This catches orphaned infrastructure
 * declarations that nothing depends on.
 *
 * Triggers on: export const bucket = new Bucket({...}) when bucket is never referenced
 * OK: export const bucket = new Bucket({...}); export const fn = new Function({ bucket: bucket.arn })
 */

interface DeclarableInfo {
  name: string;
  node: ts.VariableStatement;
}

function isCapitalized(name: string): boolean {
  return name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
}

function getNewExpressionClassName(expr: ts.NewExpression): string | undefined {
  if (ts.isIdentifier(expr.expression)) {
    return expr.expression.text;
  }
  if (ts.isPropertyAccessExpression(expr.expression)) {
    return expr.expression.name.text;
  }
  return undefined;
}

function collectExportedDeclarables(sourceFile: ts.SourceFile): DeclarableInfo[] {
  const declarables: DeclarableInfo[] = [];

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isVariableStatement(node)) return;

    // Must have export modifier
    const hasExport = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) return;

    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer) continue;

      // Must be a new expression with a capitalized name
      if (!ts.isNewExpression(decl.initializer)) continue;

      const className = getNewExpressionClassName(decl.initializer);
      if (!className || !isCapitalized(className)) continue;

      declarables.push({
        name: decl.name.text,
        node,
      });
    }
  });

  return declarables;
}

function collectReferences(name: string, sourceFile: ts.SourceFile, declarationNode: ts.Node): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) return;

    // Skip the declaration itself
    if (node === declarationNode) return;

    if (ts.isIdentifier(node) && node.text === name) {
      // Make sure this isn't the declaration's own name
      const parent = node.parent;
      if (parent && ts.isVariableDeclaration(parent) && parent.name === node) {
        // This is the declaration itself, skip
      } else {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

export const noUnusedDeclarableRule: LintRule = {
  id: "COR004",
  severity: "warning",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const declarables = collectExportedDeclarables(context.sourceFile);

    for (const decl of declarables) {
      if (!collectReferences(decl.name, context.sourceFile, decl.node)) {
        const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
          decl.node.getStart(context.sourceFile),
        );

        diagnostics.push({
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: "COR004",
          severity: "warning",
          message: `Exported declarable '${decl.name}' is never referenced in this file — it may be dead infrastructure code.`,
        });
      }
    }

    return diagnostics;
  },
};
