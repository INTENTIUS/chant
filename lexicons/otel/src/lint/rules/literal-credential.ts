import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { calleeName, COMPONENT_CLASS, literalText, position, propertyName } from "./otel-ast";

/** Keys whose value is a credential. `*_file` keys name a path, which is fine. */
const SECRET_KEY = /(authorization|api[-_]?key|password|passwd|secret|token|key_pem|x-honeycomb-team)/i;

/**
 * OTEL002: a credential written as a literal in a component's config.
 *
 * Exporters authenticate with headers (`authorization`, `api-key`, vendor
 * headers) or keys (`api_key`, `password`, `key_pem`). A literal value there
 * is a secret in the repository and in the emitted YAML. The collector reads
 * `${env:NAME}` and `${file:/path}` at start-up, so the declaration never
 * needs the value itself. Any string containing `${` is treated as such a
 * reference, and keys ending in `_file` name a path and are left alone.
 */
export const literalCredentialRule: LintRule = {
  id: "OTEL002",
  severity: "error",
  category: "security",
  description: "Collector credential declared as a literal instead of ${env:...}",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const scan = (obj: ts.ObjectLiteralExpression) => {
      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = propertyName(prop);
        const init = prop.initializer;
        if (ts.isObjectLiteralExpression(init)) {
          scan(init);
          continue;
        }
        if (!key || !SECRET_KEY.test(key) || /_file$/i.test(key)) continue;
        const text = literalText(init);
        if (text === undefined || text === "" || text.includes("${")) continue;
        diagnostics.push({
          ruleId: "OTEL002",
          severity: "error",
          message: `\`${key}\` is a literal credential; write "\${env:NAME}" (or "\${file:/path}") and let the collector read it at start-up`,
          file: context.filePath,
          ...position(source, init),
        });
      }
    };

    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const name = calleeName(node);
        const arg = node.arguments?.[0];
        if (name && COMPONENT_CLASS.test(name) && arg && ts.isObjectLiteralExpression(arg)) scan(arg);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return diagnostics;
  },
};
