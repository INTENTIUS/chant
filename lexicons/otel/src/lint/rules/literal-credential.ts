import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { calleeName, COMPONENT_CLASS, literalText, position, propertyName } from "./otel-ast";
// Shared with OTEL120, which applies the same check to the emitted YAML.
import { SECRET_KEY } from "../../config-hygiene";

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

    // `const x = { ... }` (or `[...]`, or a string) anywhere in the file, so a
    // config value lifted out of the constructor into a named const, the way
    // COR001 asks, is scanned where it is used.
    const consts = new Map<string, ts.Expression>();
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const) {
        for (const d of node.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(source);

    const flag = (key: string, node: ts.Node) =>
      diagnostics.push({
        ruleId: "OTEL002",
        severity: "error",
        message: `\`${key}\` is a literal credential; write "\${env:NAME}" (or "\${file:/path}") and let the collector read it at start-up`,
        file: context.filePath,
        ...position(source, node),
      });

    const scanned = new Set<ts.Node>();
    const scanValue = (key: string | undefined, value: ts.Expression) => {
      let init: ts.Expression = value;
      if (ts.isIdentifier(init)) {
        const resolved = consts.get(init.text);
        if (!resolved) return;
        init = resolved;
      }
      if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
        if (scanned.has(init)) return;
        scanned.add(init);
        if (ts.isObjectLiteralExpression(init)) scan(init);
        else for (const el of init.elements) scanValue(undefined, el as ts.Expression);
        return;
      }
      if (!key || !SECRET_KEY.test(key) || /_file$/i.test(key)) return;
      const text = literalText(init);
      if (text === undefined || text === "" || text.includes("${")) return;
      flag(key, value);
    };

    const scan = (obj: ts.ObjectLiteralExpression) => {
      for (const prop of obj.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) scanValue(prop.name.text, prop.name);
        else if (ts.isPropertyAssignment(prop)) scanValue(propertyName(prop), prop.initializer);
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
