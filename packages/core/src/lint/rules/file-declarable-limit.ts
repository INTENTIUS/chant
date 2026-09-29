import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isPropertyKindNew } from "./property-kind";

const DECLARABLE_LIMIT = 8;

const BUILTIN_CONSTRUCTORS = new Set([
  "Array",
  "ArrayBuffer",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "Error",
  "EvalError",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Map",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "SyntaxError",
  "TypeError",
  "URIError",
  "URL",
  "URLSearchParams",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "WeakMap",
  "WeakRef",
  "WeakSet",
]);

function isDeclarableConstructor(node: ts.NewExpression): boolean {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    return (
      name.length > 0 &&
      name[0] >= "A" &&
      name[0] <= "Z" &&
      !BUILTIN_CONSTRUCTORS.has(name)
    );
  }
  return false;
}

/**
 * Collect the declarable `new` expressions this rule counts. Property-kind
 * declarables (chant #2957) are left out: a dashboard with twenty panels,
 * queries and variables is one resource, not twenty-one.
 */
function collectDeclarableNewExpressions(
  node: ts.Node,
  context: LintContext,
  results: ts.NewExpression[],
): void {
  if (ts.isNewExpression(node) && isDeclarableConstructor(node) && !isPropertyKindNew(node, context)) {
    results.push(node);
  }
  ts.forEachChild(node, (child) =>
    collectDeclarableNewExpressions(child, context, results),
  );
}

export const fileDeclarableLimitRule: LintRule = {
  id: "COR009",
  severity: "warning",
  category: "style",
  description: "Limits the number of resource Declarable instances per file to encourage splitting by concern; property-kind declarables are not counted",
  check(context: LintContext, options?: Record<string, unknown>): LintDiagnostic[] {
    const limit = (typeof options?.max === "number" ? options.max : null) ?? DECLARABLE_LIMIT;
    const instances: ts.NewExpression[] = [];
    collectDeclarableNewExpressions(context.sourceFile, context, instances);

    if (instances.length > limit) {
      return [
        {
          file: context.filePath,
          line: 1,
          column: 1,
          ruleId: "COR009",
          severity: "warning",
          message: `File contains ${instances.length} Declarable instances (limit: ${limit}) — consider splitting into separate files by concern`,
        },
      ];
    }

    return [];
  },
};
