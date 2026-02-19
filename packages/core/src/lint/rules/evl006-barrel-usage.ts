import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * EVL006: Incorrect barrel() Usage
 *
 * Two constraints:
 * 1. The argument to barrel() must be import.meta.dir
 * 2. The call must be part of: export const $ = barrel(import.meta.dir)
 */

function isImportMetaDir(node: ts.Node): boolean {
  // import.meta.dir is a PropertyAccessExpression: (import.meta).dir
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "dir" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta"
  ) {
    return true;
  }
  return false;
}

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "barrel"
  ) {
    // Check constraint 1: argument must be import.meta.dir
    const arg = node.arguments[0];
    if (!arg || !isImportMetaDir(arg)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile),
      );
      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "EVL006",
        severity: "error",
        message: "barrel() argument must be import.meta.dir",
      });
    }

    // Check constraint 2: must be export const $ = barrel(...)
    let isValidExport = false;
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent)) {
      if (ts.isIdentifier(parent.name) && parent.name.text === "$") {
        const declList = parent.parent;
        if (declList && ts.isVariableDeclarationList(declList)) {
          const stmt = declList.parent;
          if (
            stmt &&
            ts.isVariableStatement(stmt) &&
            stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
            (declList.flags & ts.NodeFlags.Const) !== 0
          ) {
            isValidExport = true;
          }
        }
      }
    }

    if (!isValidExport) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile),
      );
      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "EVL006",
        severity: "error",
        message: "barrel() must be used as: export const $ = barrel(import.meta.dir)",
      });
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const evl006BarrelUsageRule: LintRule = {
  id: "EVL006",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
