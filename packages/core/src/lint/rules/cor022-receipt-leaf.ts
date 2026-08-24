import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR022: Effect Receipt Is a Leaf (#1833, epic #1703)
 *
 * Nothing may reference an effect receipt's attributes. A receipt is the
 * declared witness that an out-of-band effect ran — the `effect()` step
 * (#1834) is its sole writer, on success, last (../../effect-receipt.ts).
 * Any resource that derives a property from a receipt couples itself to a
 * value only the effect controls: the coupling is invisible at synthesis,
 * and the receipt's late write (or its absence after a crash) would ripple
 * into resources that were supposed to be independent of whether the effect
 * has fired yet.
 *
 * The rule walks the file's reference graph the way COR011 does: it collects
 * every variable initialized from an `EffectReceipt(...)` call (aliases
 * included — `const alias = receipt` is still the receipt), then flags every
 * property or element access rooted at one of them. Const indirection fires:
 *
 *   const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
 *   other.prop = r.something;   // COR022
 *
 * Referencing the receipt VALUE (passing `r` itself around) is not flagged —
 * the leaf constraint is about attributes, and lexicon materialization rows
 * legitimately take the whole declaration.
 *
 * Core recognizes the factory call by name; a lexicon-materialized receipt
 * row (#1835) is recognized at build time by its marker instead — this rule
 * is the source-level half.
 */

/** Simple callee name of a call: `EffectReceipt(...)` or `chant.EffectReceipt(...)`. */
function calleeName(expr: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(expr.expression)) return expr.expression.text;
  if (ts.isPropertyAccessExpression(expr.expression)) return expr.expression.name.text;
  return undefined;
}

/** A variable declaration's `EffectReceipt(...)` initializer, if that is what it is. */
export function receiptFactoryCall(decl: ts.VariableDeclaration): ts.CallExpression | undefined {
  if (!decl.initializer || !ts.isCallExpression(decl.initializer)) return undefined;
  return calleeName(decl.initializer) === "EffectReceipt" ? decl.initializer : undefined;
}

/**
 * Every variable name bound to an effect receipt in this file: direct
 * `EffectReceipt(...)` initializers plus identifier aliases, resolved to a
 * fixpoint so declaration order does not matter. Scope-naive by design, the
 * same trade COR011 makes — a chant source file is flat declarations.
 */
export function collectReceiptVariables(sourceFile: ts.SourceFile): Set<string> {
  const receipts = new Set<string>();
  const aliases: Array<[string, string]> = [];

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (receiptFactoryCall(node)) {
        receipts.add(node.name.text);
      } else if (ts.isIdentifier(node.initializer)) {
        aliases.push([node.name.text, node.initializer.text]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, source] of aliases) {
      if (receipts.has(source) && !receipts.has(name)) {
        receipts.add(name);
        grew = true;
      }
    }
  }
  return receipts;
}

/** The accessed attribute's name, for the message: `r.something` → "something". */
function accessedAttribute(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const arg = node.argumentExpression;
  return ts.isStringLiteralLike(arg) ? arg.text : "<computed>";
}

export const cor022ReceiptLeafRule: LintRule = {
  id: "COR022",
  severity: "error",
  category: "correctness",
  description:
    "An effect receipt is a leaf — nothing may reference its attributes; the effect() step is the receipt's sole writer",
  check(context: LintContext): LintDiagnostic[] {
    const receipts = collectReceiptVariables(context.sourceFile);
    if (receipts.size === 0) return [];

    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        receipts.has(node.expression.text)
      ) {
        const receipt = node.expression.text;
        const attribute = accessedAttribute(node);
        const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
          node.getStart(context.sourceFile),
        );
        diagnostics.push({
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: "COR022",
          severity: "error",
          message:
            `"${receipt}" is an effect receipt — a receipt is a leaf, and nothing may reference its ` +
            `attributes ("${attribute}" here). The effect() step is the receipt's sole writer, so a ` +
            `property derived from it couples this resource to a value only the effect controls. ` +
            `Reference the effect's inputs (or the resources they come from) directly instead.`,
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(context.sourceFile);

    return diagnostics;
  },
};
