import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { constInitializers, constructorArgs, literalText, position, propertyName, resolveObject } from "./grafana-ast";
import { CONTACT_POINT_SECRET_SETTINGS, EXPANDED_VALUE as EXPANDED } from "../../contact-point-secrets";

/** Follow an identifier to the array literal it was declared as, when it is one in this file. */
function resolveArray(node: ts.Expression, consts: Map<string, ts.Expression>, depth = 0): ts.ArrayLiteralExpression | undefined {
  let n: ts.Expression = node;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression;
  if (ts.isArrayLiteralExpression(n)) return n;
  if (ts.isIdentifier(n) && depth < 5) {
    const init = consts.get(n.text);
    if (init) return resolveArray(init, consts, depth + 1);
  }
  return undefined;
}

/** The value of a property, `name: value` or the shorthand `name` (followed as an identifier). */
function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (propertyName(p) === name) return (p as ts.PropertyAssignment).initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

/**
 * GRAF002: a datasource or contact point secret written as a literal.
 *
 * A datasource's `secureJsonData` holds passwords, tokens and TLS keys, and
 * so do the settings Grafana stores encrypted for each contact point
 * integration (a Slack webhook `url`, a PagerDuty `integrationKey`, a
 * webhook's `authorization_credentials`; see `CONTACT_POINT_SECRET_SETTINGS`).
 * A literal there is a secret in the repository and in the emitted
 * provisioning file. Grafana
 * expands `$__env{NAME}`, `$__file{/path}` and `${NAME}` when it reads the
 * file, so the declaration never needs the value. A value written as a
 * named `const` in the same file is followed.
 */
export const literalSecretRule: LintRule = {
  id: "GRAF002",
  severity: "error",
  category: "security",
  description: "Datasource secureJsonData or contact point secret setting declared as a literal instead of $__env{...} or $__file{...}",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;
    const consts = constInitializers(source);
    for (const { arg } of constructorArgs(source, (n) => n === "Datasource")) {
      for (const prop of arg.properties) {
        if (propertyName(prop) !== "secureJsonData") continue;
        const secure = resolveObject((prop as ts.PropertyAssignment).initializer, consts);
        if (!secure) continue;
        for (const entry of secure.properties) {
          if (!ts.isPropertyAssignment(entry)) continue;
          const text = literalText(entry.initializer);
          if (text === undefined || text === "" || EXPANDED.test(text)) continue;
          diagnostics.push({
            ruleId: "GRAF002",
            severity: "error",
            message: `secureJsonData.${propertyName(entry) ?? "?"} is a literal secret; write "$__env{NAME}" or "$__file{/path}" and let Grafana read it`,
            file: context.filePath,
            ...position(source, entry.initializer),
          });
        }
      }
    }
    for (const { arg } of constructorArgs(source, (n) => n === "ContactPoint")) {
      const receivers = prop(arg, "receivers");
      const list = receivers ? resolveArray(receivers, consts) : undefined;
      for (const el of list?.elements ?? []) {
        const receiver = resolveObject(el as ts.Expression, consts);
        if (!receiver) continue;
        const typeNode = prop(receiver, "type");
        const type = typeNode ? literalText(typeNode) : undefined;
        const settingsNode = prop(receiver, "settings");
        const settings = settingsNode ? resolveObject(settingsNode, consts) : undefined;
        if (!type || !settings) continue;
        for (const path of CONTACT_POINT_SECRET_SETTINGS[type] ?? []) {
          let node: ts.ObjectLiteralExpression | undefined = settings;
          const segments = path.split(".");
          for (const seg of segments.slice(0, -1)) {
            const next: ts.Expression | undefined = node ? prop(node, seg) : undefined;
            node = next ? resolveObject(next, consts) : undefined;
          }
          const valueNode = node ? prop(node, segments[segments.length - 1]) : undefined;
          const text = valueNode ? literalText(valueNode) : undefined;
          if (!valueNode || text === undefined || text === "" || EXPANDED.test(text)) continue;
          diagnostics.push({
            ruleId: "GRAF002",
            severity: "error",
            message: `${type} contact point setting ${path} is a literal secret; write "$__env{NAME}" or "$__file{/path}" and let Grafana read it`,
            file: context.filePath,
            ...position(source, valueNode),
          });
        }
      }
    }
    return diagnostics;
  },
};
