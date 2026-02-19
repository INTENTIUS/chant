import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR015: no-redundant-value-cast
 *
 * Flag `as Value<...>` type assertions — AttrRef already implements Intrinsic,
 * so it satisfies Value<T> without a cast.
 *
 * Triggers on: role.arn as Value<string>
 * OK: role.arn (used directly)
 */

function checkNode(node: ts.Node, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isAsExpression(node)) {
    const typeNode = node.type;
    if (ts.isTypeReferenceNode(typeNode)) {
      const typeName = typeNode.typeName;
      if (ts.isIdentifier(typeName) && typeName.text === "Value") {
        const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
          node.getStart(context.sourceFile)
        );
        diagnostics.push({
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: "COR015",
          severity: "warning",
          message: `Redundant 'as Value<...>' cast — AttrRef and other Intrinsic types already satisfy Value<T>.`,
        });
      }
    }
  }
  ts.forEachChild(node, child => checkNode(child, context, diagnostics));
}

export const noRedundantValueCastRule: LintRule = {
  id: "COR015",
  severity: "warning",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, context, diagnostics);
    return diagnostics;
  },
};
