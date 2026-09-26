import ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * SYS001: a backend's key is never a literal.
 *
 * A key is `{ env: "VARIABLE" }` or a brokered capability
 * (`{ capability: "inference", member: "box" }`, #2726). A string written
 * where a key goes is a credential in git history, and a box that holds one
 * fails `workspace check` with WSP121 as well.
 *
 * Fires on a `key` property whose value is a string or template literal,
 * inside the `systemone` namespace of a config object or inside a `backends`
 * object (the `decide` step's own backends).
 */

function keyText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

const isLiteral = (node: ts.Expression): boolean => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);

export const noLiteralKeyRule: LintRule = {
  id: "SYS001",
  severity: "error",
  category: "security",
  description: 'A systemone backend key is { env } or a brokered capability, never a literal string',

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;
    const visit = (node: ts.Node, inside: boolean) => {
      let within = inside;
      if (ts.isPropertyAssignment(node)) {
        const key = keyText(node.name);
        if (key === "systemone" || key === "backends") within = true;
        if (inside && key === "key" && isLiteral(node.initializer)) {
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
    visit(source, false);
    return diagnostics;
  },
};
