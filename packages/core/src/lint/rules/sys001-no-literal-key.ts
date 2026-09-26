import ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "../rule";

/**
 * SYS001: a `decide` backend's key is never a literal (#2740, core's since
 * #2828).
 *
 * A key is `{ env: "VARIABLE" }` or a brokered capability
 * (`{ capability: "inference", member: "box" }`, #2726). A string written
 * where a key goes is a credential in git history, and a box that holds one
 * fails `workspace check` with WSP121 as well.
 *
 * Fires on a `key` property whose value is a string or template literal,
 * inside a backend of a `backends` object that belongs to `decide`: the
 * `decide` block of a config object (`decide: { backends: ... }`) or the
 * options of a `decide(...)` step. A `backends` object anywhere else, such as
 * a Terraform backend's `key`, is not a decide backend and is left alone.
 * The id keeps the SYS prefix it had in the systemone lexicon.
 */

function keyText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

const isLiteral = (node: ts.Expression): boolean => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);

const isDecideCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "decide";

/** Where the walk is: outside decide, inside decide's options or config block, or inside its `backends`. */
type Scope = "outside" | "decide" | "backends";

export const noLiteralKeyRule: LintRule = {
  id: "SYS001",
  severity: "error",
  category: "security",
  description: "A decide backend key is { env } or a brokered capability, never a literal string",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;
    const visit = (node: ts.Node, scope: Scope) => {
      let within = scope;
      if (isDecideCall(node)) within = "decide";
      else if (ts.isPropertyAssignment(node)) {
        const key = keyText(node.name);
        if (key === "decide") within = "decide";
        else if (key === "backends" && scope === "decide") within = "backends";
        if (scope === "backends" && key === "key" && isLiteral(node.initializer)) {
          const { line, character } = source.getLineAndCharacterOfPosition(node.initializer.getStart(source));
          diagnostics.push({
            ruleId: "SYS001",
            severity: "error",
            message: 'Literal backend key: use { env: "VARIABLE" } or a brokered capability ({ capability, member }) instead',
            file: context.filePath,
            line: line + 1,
            column: character + 1,
          });
        }
      }
      ts.forEachChild(node, (child) => visit(child, within));
    };
    visit(source, "outside");
    return diagnostics;
  },
};
