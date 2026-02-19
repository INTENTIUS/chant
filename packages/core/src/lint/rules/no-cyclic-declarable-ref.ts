import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR011: no-cyclic-declarable-ref
 *
 * Detects circular references between declarables in the same file.
 * Builds a directed graph of declarable references and reports any cycles found.
 *
 * Triggers on: A references B, B references A (or longer transitive cycles)
 * OK: A→B→C (linear chain, no cycle)
 */

interface DeclarableInfo {
  name: string;
  node: ts.VariableStatement;
  initializer: ts.NewExpression;
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

    const hasExport = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) return;

    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer) continue;
      if (!ts.isNewExpression(decl.initializer)) continue;

      const className = getNewExpressionClassName(decl.initializer);
      if (!className || !isCapitalized(className)) continue;

      declarables.push({
        name: decl.name.text,
        node,
        initializer: decl.initializer,
      });
    }
  });

  return declarables;
}

function collectReferencedDeclarables(
  initializerNode: ts.Node,
  declarableNames: Set<string>,
): Set<string> {
  const refs = new Set<string>();

  function visit(node: ts.Node): void {
    // Match property access like `role.arn` or plain identifier references
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (declarableNames.has(node.expression.text)) {
        refs.add(node.expression.text);
      }
    } else if (ts.isIdentifier(node)) {
      // Direct identifier reference (e.g., passing `bucket` as an argument)
      if (declarableNames.has(node.text)) {
        // Make sure it's not part of a property access we already handled
        const parent = node.parent;
        if (!parent || !ts.isPropertyAccessExpression(parent) || parent.expression !== node) {
          refs.add(node.text);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(initializerNode);
  return refs;
}

function detectCycles(graph: Record<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    const neighbors = graph[node] || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recStack.has(neighbor)) {
        const cycleStartIndex = path.indexOf(neighbor);
        const cycle = path.slice(cycleStartIndex);
        cycles.push(cycle);
      }
    }

    recStack.delete(node);
    path.pop();
  }

  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

export const noCyclicDeclarableRefRule: LintRule = {
  id: "COR011",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const declarables = collectExportedDeclarables(context.sourceFile);

    if (declarables.length < 2) return diagnostics;

    const declarableNames = new Set(declarables.map((d) => d.name));
    const declarableMap = new Map(declarables.map((d) => [d.name, d]));

    // Build directed graph: A → B means A's constructor references B
    const graph: Record<string, string[]> = {};
    for (const decl of declarables) {
      const refs = collectReferencedDeclarables(decl.initializer, declarableNames);
      // Exclude self-references
      refs.delete(decl.name);
      graph[decl.name] = [...refs];
    }

    const cycles = detectCycles(graph);

    // Track which nodes we've already reported to avoid duplicate diagnostics
    const reported = new Set<string>();

    for (const cycle of cycles) {
      // Create a canonical key for the cycle to deduplicate
      const cycleKey = [...cycle].sort().join(",");
      if (reported.has(cycleKey)) continue;
      reported.add(cycleKey);

      const cyclePath = [...cycle, cycle[0]].join(" \u2192 ");
      const firstDecl = declarableMap.get(cycle[0])!;
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        firstDecl.node.getStart(context.sourceFile),
      );

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR011",
        severity: "error",
        message: `Circular reference detected: ${cyclePath}. Break the cycle by restructuring your declarations.`,
      });
    }

    return diagnostics;
  },
};
