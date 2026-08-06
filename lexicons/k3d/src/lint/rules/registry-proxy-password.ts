import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * K3D001: literal registry proxy password in source.
 *
 * The v1alpha5 schema types `registries.create.proxy.password` as a plain
 * string, so nothing upstream stops a declaration from carrying the registry
 * credential verbatim — and a cluster config is exactly the kind of file
 * that gets committed. A literal here is a credential in source, which is
 * the line chant does not cross anywhere else (FTN001, WK8005).
 *
 * Flags a string-literal `password` when it is unambiguously the k3d proxy
 * one: inside a `RegistryProxy(...)` construction, or inside an object
 * assigned to a `proxy` property. A bare `password:` elsewhere in the file
 * is someone else's business.
 */
export const registryProxyPasswordRule: LintRule = {
  id: "K3D001",
  severity: "error",
  category: "security",
  description: "Registry proxy password declared as a string literal in source",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const flag = (node: ts.Node) => {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      diagnostics.push({
        ruleId: "K3D001",
        severity: "error",
        message:
          "registries.create.proxy.password is a literal in source — a committed cluster config " +
          "is a leaked registry credential. Keep the value out of the declaration: connect a " +
          "pre-existing registry via registries.use, or supply the proxy credential outside chant.",
        file: context.filePath,
        line: line + 1,
        column: character + 1,
      });
    };

    const passwordLiteral = (obj: ts.ObjectLiteralExpression): ts.Node | undefined => {
      for (const prop of obj.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "password" &&
          (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) &&
          prop.initializer.text.length > 0
        ) {
          return prop.initializer;
        }
      }
      return undefined;
    };

    const visit = (node: ts.Node) => {
      // RegistryProxy({ ..., password: "..." }) — with or without `new`.
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : undefined;
        if (name === "RegistryProxy") {
          const arg = node.arguments?.[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            const literal = passwordLiteral(arg);
            if (literal) flag(literal);
          }
        }
      }

      // proxy: { ..., password: "..." } — the plain-object form.
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "proxy" &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const literal = passwordLiteral(node.initializer);
        if (literal) flag(literal);
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
    return diagnostics;
  },
};
