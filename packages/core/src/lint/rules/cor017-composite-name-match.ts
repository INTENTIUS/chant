import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isCompositeCallee } from "./composite-scope";

/**
 * COR017: Composite name must match variable name
 *
 * The second argument to Composite() (the name string) must match the
 * const variable it's assigned to. This name is used in resource expansion
 * (e.g. healthApi_role, healthApi_func) and in error messages.
 *
 * Triggers on: const LambdaApi = Composite(fn, "MyFunction")  — mismatch
 * Triggers on: const LambdaApi = Composite(fn)                — missing name
 * OK: const LambdaApi = Composite(fn, "LambdaApi")
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
    const call = node.initializer;
    if (!isCompositeCallee(call.expression)) {
      ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
      return;
    }

    // Get the variable name
    if (!ts.isIdentifier(node.name)) {
      ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
      return;
    }
    const variableName = node.name.text;

    // Check second argument
    const nameArg = call.arguments[1];

    if (!nameArg) {
      // Missing name argument
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        call.expression.getStart(context.sourceFile),
      );

      // Insert fix: add name argument after the factory callback
      const factoryArg = call.arguments[0];
      const insertPos = factoryArg.getEnd();

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR017",
        severity: "error",
        message: `Composite is missing a name argument — add "${variableName}" as the second argument`,
        fix: {
          range: [insertPos, insertPos],
          replacement: `, "${variableName}"`,
        },
      });
    } else if (!ts.isStringLiteral(nameArg)) {
      // Non-literal name argument
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        nameArg.getStart(context.sourceFile),
      );

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR017",
        severity: "error",
        message: `Composite name must be a string literal`,
        fix: {
          range: [nameArg.getStart(context.sourceFile), nameArg.getEnd()],
          replacement: `"${variableName}"`,
        },
      });
    } else if (nameArg.text !== variableName) {
      // Name mismatch
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        nameArg.getStart(context.sourceFile),
      );

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR017",
        severity: "error",
        message: `Composite name "${nameArg.text}" does not match variable name "${variableName}"`,
        fix: {
          range: [nameArg.getStart(context.sourceFile), nameArg.getEnd()],
          replacement: `"${variableName}"`,
        },
      });
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, context, diagnostics));
}

export const cor017CompositeNameMatchRule: LintRule = {
  id: "COR017",
  severity: "error",
  category: "correctness",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
