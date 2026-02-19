import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR013: Single-concern file
 *
 * Advisory rule that flags files mixing resource Declarables (e.g. Bucket,
 * Function, Role) with property/config Declarables (e.g. BucketEncryption,
 * VersioningConfiguration) as `new` expressions.
 *
 * Heuristic: class names containing "Configuration", "Encryption", "Policy",
 * "Rule", "Setting", "Block", "Specification" are considered property-kind.
 * All other capitalized `new` expressions are considered resource-kind.
 *
 * Triggers when a single file has `new` expressions for both kinds.
 */

const PROPERTY_KIND_PATTERNS = [
  "Configuration",
  "Encryption",
  "Policy",
  "Rule",
  "Setting",
  "Block",
  "Specification",
];

function isPropertyKindClass(className: string): boolean {
  return PROPERTY_KIND_PATTERNS.some(pattern => className.includes(pattern));
}

function isResourceKindClass(className: string): boolean {
  return /^[A-Z]/.test(className) && !isPropertyKindClass(className);
}

interface NewExpressionInfo {
  className: string;
  node: ts.NewExpression;
}

function collectNewExpressions(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  results: NewExpressionInfo[],
): void {
  if (ts.isNewExpression(node)) {
    const className = node.expression.getText(sourceFile);
    // Only consider capitalized class names (likely Declarable constructors)
    if (/^[A-Z]/.test(className) || /\.[A-Z]/.test(className)) {
      // Extract the simple class name (after any dot for qualified access like aws.Bucket)
      const simpleName = className.includes(".")
        ? className.split(".").pop()!
        : className;
      results.push({ className: simpleName, node });
    }
  }

  ts.forEachChild(node, child =>
    collectNewExpressions(child, sourceFile, results),
  );
}

export const singleConcernFileRule: LintRule = {
  id: "COR013",
  severity: "info",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const newExpressions: NewExpressionInfo[] = [];
    collectNewExpressions(context.sourceFile, context.sourceFile, newExpressions);

    const resourceExpressions = newExpressions.filter(e =>
      isResourceKindClass(e.className),
    );
    const propertyExpressions = newExpressions.filter(e =>
      isPropertyKindClass(e.className),
    );

    // Only flag if the file has both kinds
    if (resourceExpressions.length === 0 || propertyExpressions.length === 0) {
      return [];
    }

    // Report a single diagnostic at the file level (first line)
    const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(0);

    return [
      {
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR013",
        severity: "info",
        message:
          "COR013: File mixes resource Declarables with configuration Declarables — consider splitting into separate files",
      },
    ];
  },
};
