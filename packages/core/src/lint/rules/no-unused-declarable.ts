import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isPropertyKindNew } from "./property-kind";

/**
 * COR004: no-unused-declarable
 *
 * Detects exported declarables (export const x = new X(...)) that are never
 * referenced elsewhere in the same file. This catches orphaned infrastructure
 * declarations that nothing depends on.
 *
 * Triggers on: export const bucket = new Bucket({...}) when bucket is never referenced
 * OK: export const bucket = new Bucket({...}); export const fn = new Function({ bucket: bucket.arn })
 *
 * Property-kind declarables (chant #2957), such as Grafana panels, are left
 * out on both sides. One is never flagged itself: it only means something
 * inside a resource, and a file of them is usually assembled into that
 * resource from another file. A resource that holds one, inline or through
 * a const declared in this file, is the root that emits it, so it is not
 * flagged either: nothing ever references a dashboard, and that is fine.
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

/** Names of this file's top-level consts initialised with a property-kind `new`. */
function collectPropertyKindConsts(context: LintContext): Set<string> {
  const names = new Set<string>();
  for (const stmt of context.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isNewExpression(decl.initializer) &&
        isPropertyKindNew(decl.initializer, context)
      ) {
        names.add(decl.name.text);
      }
    }
  }
  return names;
}

/**
 * True when the constructor arguments hold a property-kind declarable,
 * either inline (`panels: [new Row(…)]`) or through a const from
 * `propertyConsts` (`panels: [red]`).
 */
function holdsPropertyKind(expr: ts.NewExpression, context: LintContext, propertyConsts: Set<string>): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isNewExpression(node) && isPropertyKindNew(node, context)) {
      found = true;
      return;
    }
    if (ts.isIdentifier(node) && propertyConsts.has(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  for (const arg of expr.arguments ?? []) visit(arg);
  return found;
}

function collectExportedDeclarables(context: LintContext): DeclarableInfo[] {
  const declarables: DeclarableInfo[] = [];
  const sourceFile = context.sourceFile;
  const propertyConsts = collectPropertyKindConsts(context);

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

      // Parameters are inherently cross-file (declared in params.ts, consumed via Ref() elsewhere)
      if (className === "Parameter") continue;

      // chant #2957: a property-kind declarable is part of a resource, and a
      // resource holding one is the root that emits it.
      if (isPropertyKindNew(decl.initializer, context)) continue;
      if (holdsPropertyKind(decl.initializer, context, propertyConsts)) continue;

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
  description: "Detects exported declarables that are never referenced in the same file",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const declarables = collectExportedDeclarables(context);

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
