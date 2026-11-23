import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isInsideCompositeFactory } from "./composite-scope";
import { intrinsicCallFoldsEagerly, type IntrinsicDef } from "../../lexicon";

/**
 * EVL004: Spread From Non-Const Source
 *
 * Spread expressions ({...x} or [...x]) must reference a const-declared
 * variable, object literal, or property access chain from a const.
 * Spreading from function calls or non-traceable sources is blocked.
 *
 * A binding imported from another module counts as const: an import can't
 * be reassigned, and sharing an exported const (a preset, a list of
 * Dockerfile steps) across modules is the point of exporting it. Whether the
 * exporting module declared it `const` is that module's own EVL concern.
 *
 * A call to a function an active lexicon registered `foldsEagerly` counts too
 * (#5514). `fold()` calls such a function with the folded arguments and spreads
 * the plain object or array it returns, so rejecting the spread here made
 * EVL004 stricter than the folder for a lexicon's own documented helper
 * (cedar's `...agentCoreStagedPolicy(...)`). Registration is by name, read off
 * `LintContext.intrinsics`, which is empty unless the project's lexicons
 * register something. A `foldsAsCall` intrinsic stays rejected: it folds to a
 * symbolic envelope, and spreading that would copy the envelope's own fields.
 */

function isEagerIntrinsicCall(node: ts.Node, intrinsics: readonly IntrinsicDef[] | undefined): boolean {
  if (!intrinsics || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
  const name = node.expression.text;
  return intrinsics.some((i) => i.name === name && intrinsicCallFoldsEagerly(i));
}

function isTraceableToConst(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  intrinsics?: readonly IntrinsicDef[],
): boolean {
  // Object or array literals are fine
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    return true;
  }

  // A call to an eagerly folded lexicon intrinsic
  if (isEagerIntrinsicCall(node, intrinsics)) {
    return true;
  }

  // Property access: follow the chain to the root
  if (ts.isPropertyAccessExpression(node)) {
    return isTraceableToConst(node.expression, sourceFile, intrinsics);
  }

  // Identifier — check if it's a const declaration
  if (ts.isIdentifier(node)) {
    return isConstIdentifier(node, sourceFile);
  }

  // Parenthesized
  if (ts.isParenthesizedExpression(node)) {
    return isTraceableToConst(node.expression, sourceFile, intrinsics);
  }

  // As/satisfies cast
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isTraceableToConst(node.expression, sourceFile, intrinsics);
  }

  return false;
}

function isConstIdentifier(id: ts.Identifier, sourceFile: ts.SourceFile): boolean {
  // Walk all statements looking for a const declaration or an import of this identifier
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause && !stmt.importClause.isTypeOnly) {
      const clause = stmt.importClause;
      if (clause.name?.text === id.text) return true;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        if (bindings.elements.some((el) => !el.isTypeOnly && el.name.text === id.text)) return true;
      } else if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === id.text) {
        return true;
      }
    }
    if (ts.isVariableStatement(stmt)) {
      if (stmt.declarationList.flags & ts.NodeFlags.Const) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === id.text) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  // Skip spreads inside Composite() factory callbacks
  if (isInsideCompositeFactory(node)) {
    ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
    return;
  }

  // Spread in object literal: { ...expr }
  if (ts.isSpreadAssignment(node)) {
    if (!isTraceableToConst(node.expression, context.sourceFile, context.intrinsics)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile),
      );
      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "EVL004",
        severity: "error",
        message: "Spread from non-const source — spread expression must reference a const variable or literal",
      });
    }
  }

  // Spread in array literal: [...expr]
  if (ts.isSpreadElement(node)) {
    if (!isTraceableToConst(node.expression, context.sourceFile, context.intrinsics)) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile),
      );
      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "EVL004",
        severity: "error",
        message: "Spread from non-const source — spread expression must reference a const variable or literal",
      });
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const evl004SpreadNonConstRule: LintRule = {
  id: "EVL004",
  severity: "error",
  category: "correctness",
  description: "Spread expressions must reference a const variable or literal, not a dynamic source",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
