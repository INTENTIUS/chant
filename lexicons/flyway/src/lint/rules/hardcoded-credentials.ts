import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WFW001: Hardcoded Credentials
 *
 * Detects string literals for `user` and `password` properties in Environment
 * constructors. Credentials should come from resolvers (e.g., vault, env)
 * rather than being hardcoded in source code.
 *
 * Bad:  new Environment({ user: "admin", password: "secret" })
 * Good: new Environment({ user: resolverRef("vault", "db-user"), password: resolverRef("vault", "db-pass") })
 */
export const hardcodedCredentialsRule: LintRule = {
  id: "WFW001",
  severity: "error",
  category: "security",
  description:
    "Detects hardcoded user/password strings in Environment constructors — credentials should use resolvers",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    const CREDENTIAL_PROPERTIES = new Set(["user", "password"]);

    function visit(node: ts.Node): void {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        CREDENTIAL_PROPERTIES.has(node.name.text) &&
        ts.isStringLiteral(node.initializer)
      ) {
        const value = node.initializer.text;
        if (value !== "") {
          const { line, character } =
            sourceFile.getLineAndCharacterOfPosition(
              node.initializer.getStart(),
            );
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WFW001",
            severity: "error",
            message: `Hardcoded ${node.name.text} "${value}" detected. Use a resolver reference (e.g., vault, env) instead.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
