import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic, LintProjectConfig } from "../rule";

/**
 * COR021: Literal Name in a Multi-Environment Project (#1221)
 *
 * A project that declares two or more `environments` and binds its ownership
 * marker to a build parameter (`ownership.env: { param: "env" }`) is built
 * once per environment — and every physical name that does not vary with
 * that parameter is the SAME name in every build. The collision is silent at
 * build time and only surfaces at apply time, when the second environment's
 * deploy walks over the first's resources.
 *
 * This rule warns on the declaration: a name-bearing property (`name`, or a
 * `*Name` property like `bucketName`) whose value is a bare string literal,
 * in a project shaped for per-environment builds. The fix is interpolation —
 * `` `billing-${params.env}-uploads` `` — which folds to a per-environment
 * literal because build parameters resolve before any file is imported
 * (#1064). See the resource-naming guide's multi-environment section.
 *
 * Deliberately silent when:
 * - no project config was threaded (a bare unit test, the LSP single-file path),
 * - the project declares fewer than two environments (nothing to collide),
 * - `ownership.env` is not param-bound — a literal `ownership.env` (or none)
 *   means the project is not doing per-environment builds from one source
 *   tree, so per-instance names are presumably managed another way (the
 *   layered-config all-in-one pattern hand-names each instance),
 * - the value is anything other than a bare string literal — a template
 *   interpolating `params.<name>` is the fixed shape, and other non-literal
 *   values are EVL territory, not this rule's.
 */

/** Does this property name carry a physical resource name — `name` or a camelCase `*Name`? */
function isNameBearingProperty(propName: string): boolean {
  return propName === "name" || /^[a-z][A-Za-z0-9]*Name$/.test(propName);
}

/** The property's declared name, for Identifier and string-literal keys; undefined for computed keys. */
function propertyName(prop: ts.PropertyAssignment): string | undefined {
  if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
  return undefined;
}

/** Whether the rule's preconditions hold: 2+ declared environments and a param-bound ownership.env. */
function projectIsMultiEnvParamBound(config: LintProjectConfig | undefined): string | undefined {
  const env = config?.ownership?.env;
  const paramBound = typeof env === "object" && env !== null && typeof env.param === "string";
  if (!paramBound) return undefined;
  if ((config?.environments?.length ?? 0) < 2) return undefined;
  return env.param;
}

/** Walk an object literal (nested included, e.g. k8s `metadata: { name }`), flagging literal name-bearing values. */
function checkObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  paramName: string,
  context: LintContext,
  diagnostics: LintDiagnostic[],
): void {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = propertyName(prop);
    const value = prop.initializer;
    if (
      name !== undefined &&
      isNameBearingProperty(name) &&
      (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    ) {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        value.getStart(context.sourceFile),
      );
      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR021",
        severity: "warning",
        message:
          `Literal ${name}: "${value.text}" in a multi-environment project — every environment's build ` +
          `produces this same physical name, so two deployed environments collide. Interpolate the env ` +
          `parameter: \`${value.text}-\${params.${paramName}}\` (see the resource-naming guide's ` +
          `multi-environment section).`,
      });
    }
    if (ts.isObjectLiteralExpression(value)) {
      checkObjectLiteral(value, paramName, context, diagnostics);
    }
  }
}

function checkNode(node: ts.Node, paramName: string, context: LintContext, diagnostics: LintDiagnostic[]): void {
  if (ts.isNewExpression(node) && node.arguments && node.arguments.length > 0) {
    const firstArg = node.arguments[0];
    if (ts.isObjectLiteralExpression(firstArg)) {
      checkObjectLiteral(firstArg, paramName, context, diagnostics);
    }
  }
  ts.forEachChild(node, (child) => checkNode(child, paramName, context, diagnostics));
}

export const cor021EnvLiteralNameRule: LintRule = {
  id: "COR021",
  severity: "warning",
  category: "correctness",
  description:
    "In a multi-environment project with a param-bound ownership.env, name-bearing properties should interpolate the env parameter, not hold a bare literal",
  check(context: LintContext): LintDiagnostic[] {
    const paramName = projectIsMultiEnvParamBound(context.projectConfig);
    if (paramName === undefined) return [];
    const diagnostics: LintDiagnostic[] = [];
    checkNode(context.sourceFile, paramName, context, diagnostics);
    return diagnostics;
  },
};
