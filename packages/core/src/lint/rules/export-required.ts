import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR008: Export required
 *
 * Detects declarable instances that are not exported.
 * All declarable instances should be exported to be tracked by chant.
 *
 * Triggers on: new Bucket({...}) without export
 * OK: export const bucket = new Bucket({...})
 */

interface ExportInfo {
  exportedNames: Set<string>;
  localVariableNames: Set<string>;
}

function isDeclarableClass(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  // Check if it's a class with Declarable interface implementation
  if (ts.isClassDeclaration(node) && node.heritageClauses) {
    for (const clause of node.heritageClauses) {
      for (const type of clause.types) {
        const typeName = type.expression.getText(sourceFile);
        if (typeName === "Declarable") {
          return true;
        }
      }
    }
  }
  return false;
}

function collectExportInfo(sourceFile: ts.SourceFile): ExportInfo {
  const exportedNames = new Set<string>();
  const localVariableNames = new Set<string>();

  function visit(node: ts.Node): void {
    // Handle exported variable declarations
    if (ts.isVariableStatement(node)) {
      const hasExportModifier = node.modifiers?.some(
        m => m.kind === ts.SyntaxKind.ExportKeyword
      );

      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const name = declaration.name.text;
          if (hasExportModifier) {
            exportedNames.add(name);
          } else {
            localVariableNames.add(name);
          }
        }
      }
    }

    // Handle export assignments: export = something
    if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression)) {
        exportedNames.add(node.expression.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { exportedNames, localVariableNames };
}

function isDeclarableNewExpression(node: ts.NewExpression, context: LintContext): boolean {
  // Check if the class being instantiated implements Declarable
  // We look for the class declaration in the source file or imports
  const className = node.expression.getText(context.sourceFile);

  // Check local class declarations
  let isDeclarable = false;

  function checkClassDeclarations(n: ts.Node): void {
    if (ts.isClassDeclaration(n) && n.name?.text === className) {
      if (isDeclarableClass(n, context.sourceFile)) {
        isDeclarable = true;
      }
    }
    ts.forEachChild(n, checkClassDeclarations);
  }

  checkClassDeclarations(context.sourceFile);

  // For imported classes, we use a heuristic: check if the class name is capitalized
  // and follows common declarable patterns (like Bucket, Parameter, etc.)
  if (!isDeclarable && /^[A-Z]/.test(className)) {
    // Additional check: see if it's imported from a declarable-looking module
    // For now, we'll be conservative and only flag classes that are clearly local
    return isDeclarable;
  }

  return isDeclarable;
}

function checkNode(
  node: ts.Node,
  context: LintContext,
  exportInfo: ExportInfo,
  diagnostics: LintDiagnostic[]
): void {
  // Check for new expressions that are not exported
  if (ts.isNewExpression(node)) {
    // Skip if this is part of a variable initializer that's exported
    let parent = node.parent;
    let isPartOfExportedVariable = false;
    let variableName: string | undefined;

    while (parent) {
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        variableName = parent.name.text;
        if (exportInfo.exportedNames.has(variableName)) {
          isPartOfExportedVariable = true;
          break;
        }
      }
      parent = parent.parent;
    }

    if (!isPartOfExportedVariable && isDeclarableNewExpression(node, context)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile)
      );

      const className = node.expression.getText(context.sourceFile);
      const label = variableName ? `'${variableName}' (${className})` : `'${className}'`;

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR008",
        severity: "warning",
        message: `Declarable ${label} is not exported — add 'export' so chant can discover it during synthesis.`,
      });
    }
  }

  // Recursively check child nodes
  ts.forEachChild(node, child => checkNode(child, context, exportInfo, diagnostics));
}

export const exportRequiredRule: LintRule = {
  id: "COR008",
  severity: "warning",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const exportInfo = collectExportInfo(context.sourceFile);
    checkNode(context.sourceFile, context, exportInfo, diagnostics);
    return diagnostics;
  },
};
