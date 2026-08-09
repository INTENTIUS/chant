import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * K3S001: literal join token in source.
 *
 * `token` / `agent-token` are the cluster's shared join secret, and a
 * committed config declaration is exactly the file that leaks it. The
 * typed surface deliberately carries only the reference forms
 * (`token-file`, `agent-token-file` — #1601), but nothing stops a raw
 * object literal from writing the key anyway; this rule does.
 *
 * Flags a non-empty string-literal `token` / `agent-token` (identifier or
 * quoted) inside a `Server(...)` / `Agent(...)` construction, with or
 * without `new`. A bare `token:` elsewhere in the file is someone else's
 * business.
 */
export const tokenLiteralRule: LintRule = {
  id: "K3S001",
  severity: "error",
  category: "security",
  description: "k3s join token declared as a string literal in source",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const flag = (node: ts.Node, key: string) => {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      diagnostics.push({
        ruleId: "K3S001",
        severity: "error",
        message:
          `\`${key}\` is a literal in source — a committed k3s config is a leaked cluster join ` +
          "secret. Point `token-file` at a path on the host, or supply K3S_TOKEN_FILE at " +
          "install time; the value itself never belongs in the declaration.",
        file: context.filePath,
        line: line + 1,
        column: character + 1,
      });
    };

    const tokenLiteral = (
      obj: ts.ObjectLiteralExpression,
    ): { node: ts.Node; key: string } | undefined => {
      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : undefined;
        if (name !== "token" && name !== "agent-token") continue;
        if (
          (ts.isStringLiteral(prop.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(prop.initializer)) &&
          prop.initializer.text.length > 0
        ) {
          return { node: prop.initializer, key: name };
        }
      }
      return undefined;
    };

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : undefined;
        if (name === "Server" || name === "Agent") {
          const arg = node.arguments?.[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            const literal = tokenLiteral(arg);
            if (literal) flag(literal.node, literal.key);
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return diagnostics;
  },
};
