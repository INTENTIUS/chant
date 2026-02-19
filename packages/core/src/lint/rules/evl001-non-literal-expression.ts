import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isInsideCompositeFactory } from "./composite-scope";

/**
 * EVL001: Non-Literal Expression in Resource Constructor
 *
 * Resource constructor property values must be statically evaluable.
 * Allowed: literals, identifiers, property access, object/array literals,
 * template expressions, binary/unary/conditional, as/satisfies casts.
 * Blocked: function calls, method calls, and other dynamic expressions.
 */

function isStaticallyEvaluable(node: ts.Node): boolean {
  // Literals
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword
  ) {
    return true;
  }

  // Identifiers (variable references)
  if (ts.isIdentifier(node)) return true;

  // Property access: obj.prop
  if (ts.isPropertyAccessExpression(node)) {
    return isStaticallyEvaluable(node.expression);
  }

  // Element access with static key: obj["key"] or obj[0]
  if (ts.isElementAccessExpression(node)) {
    return (
      isStaticallyEvaluable(node.expression) &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNumericLiteral(node.argumentExpression))
    );
  }

  // Object literals — check all property values
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((prop) => {
      if (ts.isPropertyAssignment(prop)) return isStaticallyEvaluable(prop.initializer);
      if (ts.isShorthandPropertyAssignment(prop)) return true;
      if (ts.isSpreadAssignment(prop)) return isStaticallyEvaluable(prop.expression);
      return false;
    });
  }

  // Array literals — check all elements
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((el) => isStaticallyEvaluable(el));
  }

  // Template expressions (tagged or untagged)
  if (ts.isTemplateExpression(node)) return true;
  if (ts.isTaggedTemplateExpression(node)) return true;

  // Binary expressions: a + b, a ?? b, etc.
  if (ts.isBinaryExpression(node)) {
    return isStaticallyEvaluable(node.left) && isStaticallyEvaluable(node.right);
  }

  // Prefix unary: !x, -x
  if (ts.isPrefixUnaryExpression(node)) {
    return isStaticallyEvaluable(node.operand);
  }

  // Conditional: a ? b : c
  if (ts.isConditionalExpression(node)) {
    return (
      isStaticallyEvaluable(node.condition) &&
      isStaticallyEvaluable(node.whenTrue) &&
      isStaticallyEvaluable(node.whenFalse)
    );
  }

  // Type assertions: x as T, x satisfies T
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isStaticallyEvaluable(node.expression);
  }

  // Parenthesized expression
  if (ts.isParenthesizedExpression(node)) {
    return isStaticallyEvaluable(node.expression);
  }

  // Non-null assertion: x!
  if (ts.isNonNullExpression(node)) {
    return isStaticallyEvaluable(node.expression);
  }

  // Spread element in arrays
  if (ts.isSpreadElement(node)) {
    return isStaticallyEvaluable(node.expression);
  }

  // new Expression (resource constructors) — allowed as property values
  if (ts.isNewExpression(node)) return true;

  // Everything else (call expressions, etc.) is not statically evaluable
  return false;
}

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  // Skip resource constructors inside Composite() factory callbacks
  if (ts.isNewExpression(node) && !isInsideCompositeFactory(node)) {
    if (node.arguments && node.arguments.length > 0) {
      const firstArg = node.arguments[0];
      if (ts.isObjectLiteralExpression(firstArg)) {
        for (const prop of firstArg.properties) {
          if (ts.isPropertyAssignment(prop)) {
            if (!isStaticallyEvaluable(prop.initializer)) {
              const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
                prop.initializer.getStart(context.sourceFile),
              );
              diagnostics.push({
                file: context.filePath,
                line: line + 1,
                column: character + 1,
                ruleId: "EVL001",
                severity: "error",
                message: `Non-literal expression in resource constructor property — value must be statically evaluable`,
              });
            }
          }
        }
      }
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const evl001NonLiteralExpressionRule: LintRule = {
  id: "EVL001",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
