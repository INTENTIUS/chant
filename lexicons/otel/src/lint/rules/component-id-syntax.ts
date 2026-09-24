import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { isComponentId } from "../../model";
import { calleeName, COMPONENT_CLASS, literalText, position, propertyName } from "./otel-ast";

/**
 * OTEL001: a component id or instance name the collector can't parse.
 *
 * A pipeline may name a component by id string (`"otlp/backend"`), and every
 * component takes an instance `name`. Both end up in the collector's
 * `type[/name]` syntax, where a space, an empty name or a stray `/` is a
 * config error at collector start. This catches the literal cases in source,
 * before a build: a string in a `Pipeline`'s receivers, processors or
 * exporters that isn't `type` or `type/name`, and a component `name` that is
 * empty, contains whitespace or starts with `/`.
 */
export const componentIdSyntaxRule: LintRule = {
  id: "OTEL001",
  severity: "error",
  category: "correctness",
  description: "Collector component id or instance name is not valid type[/name] syntax",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const flag = (node: ts.Node, message: string) => {
      diagnostics.push({ ruleId: "OTEL001", severity: "error", message, file: context.filePath, ...position(source, node) });
    };

    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const name = calleeName(node);
        const arg = node.arguments?.[0];
        if (name && arg && ts.isObjectLiteralExpression(arg)) {
          if (name === "Pipeline") {
            for (const prop of arg.properties) {
              const key = propertyName(prop);
              if (key !== "receivers" && key !== "processors" && key !== "exporters") continue;
              const init = (prop as ts.PropertyAssignment).initializer;
              if (!ts.isArrayLiteralExpression(init)) continue;
              for (const el of init.elements) {
                const text = literalText(el as ts.Expression);
                if (text !== undefined && !isComponentId(text)) {
                  flag(el, `"${text}" in ${key} is not a collector component id; write type or type/name, e.g. "otlp" or "otlp/backend"`);
                }
              }
            }
          }
          if (name === "Pipeline" || COMPONENT_CLASS.test(name)) {
            for (const prop of arg.properties) {
              if (propertyName(prop) !== "name") continue;
              const text = literalText((prop as ts.PropertyAssignment).initializer);
              if (text === undefined) continue;
              if (text === "" || /\s/.test(text) || text.startsWith("/")) {
                flag(prop, `instance name "${text}" makes an invalid id; a name is non-empty, has no whitespace and does not start with "/"`);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return diagnostics;
  },
};
