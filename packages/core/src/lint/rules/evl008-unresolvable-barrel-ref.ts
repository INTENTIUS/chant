import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * EVL008: Unresolvable Barrel Reference
 *
 * When accessing the barrel variable (e.g., $.resourceName), the
 * referenced name must exist in the project's barrel exports.
 * Requires barrelExports on LintContext.
 */

/**
 * Find the barrel variable name in a source file.
 *
 * Patterns:
 * - `export const $ = barrel(...)` → "$"
 * - `import * as _ from "./_"` then `_.$` → "$" accessed via "_"
 */
function findBarrelVarName(sourceFile: ts.SourceFile): string | null {
  for (const stmt of sourceFile.statements) {
    // export const $ = barrel(...)
    if (
      ts.isVariableStatement(stmt) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === "$" &&
          decl.initializer &&
          ts.isCallExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          decl.initializer.expression.text === "barrel"
        ) {
          return "$";
        }
      }
    }
  }
  return null;
}

/**
 * Find namespace imports that re-export the barrel.
 * e.g., `import * as _ from "./_"` — then _.$ accesses the barrel.
 */
function findBarrelNamespaceImports(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      stmt.importClause?.namedBindings &&
      ts.isNamespaceImport(stmt.importClause.namedBindings) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      // Convention: barrel files are "_" or "./_"
      if (spec === "./_" || spec === "_") {
        names.push(stmt.importClause.namedBindings.name.text);
      }
    }
  }
  return names;
}

function checkNode(
  node: ts.Node,
  context: LintContext,
  diagnostics: LintDiagnostic[],
  barrelVar: string | null,
  namespaceImports: string[],
): void {
  if (ts.isPropertyAccessExpression(node)) {
    const accessedName = node.name.text;

    // Direct barrel access: $.resourceName
    if (barrelVar && ts.isIdentifier(node.expression) && node.expression.text === barrelVar) {
      if (context.barrelExports && !context.barrelExports.has(accessedName)) {
        const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
          node.getStart(context.sourceFile),
        );
        diagnostics.push({
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: "EVL008",
          severity: "error",
          message: `Unresolvable barrel reference — "${accessedName}" is not exported from the barrel`,
        });
      }
    }

    // Namespace access: _.$.resourceName
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      namespaceImports.includes(node.expression.expression.text) &&
      node.expression.name.text === "$"
    ) {
      if (context.barrelExports && !context.barrelExports.has(accessedName)) {
        const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
          node.getStart(context.sourceFile),
        );
        diagnostics.push({
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: "EVL008",
          severity: "error",
          message: `Unresolvable barrel reference — "${accessedName}" is not exported from the barrel`,
        });
      }
    }
  }

  ts.forEachChild(node, (child) =>
    checkNode(child, context, diagnostics, barrelVar, namespaceImports),
  );
}

export const evl008UnresolvableBarrelRefRule: LintRule = {
  id: "EVL008",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    // Skip if no barrel exports data is available
    if (!context.barrelExports) return [];

    const barrelVar = findBarrelVarName(context.sourceFile);
    const namespaceImports = findBarrelNamespaceImports(context.sourceFile);

    // If this file doesn't use the barrel, nothing to check
    if (!barrelVar && namespaceImports.length === 0) return [];

    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics, barrelVar, namespaceImports);
    return diagnostics;
  },
};
