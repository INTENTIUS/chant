import type * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { UID_PATTERN } from "../../util";
import { VARIABLE_NAME } from "../../variables";
import { constructorArgs, literalText, position, propertyName } from "./grafana-ast";

const UID_OWNERS = new Set(["Dashboard", "Datasource"]);
const VARIABLE_CLASS = /Variable$/;

/**
 * GRAF001: a uid Grafana rejects, or a variable name queries cannot reference.
 *
 * A literal `uid` on a `Dashboard` or `Datasource` must be 1-40 letters,
 * digits, `-` and `_`; Grafana refuses anything else on import. A literal
 * `name` on a `*Variable` must be letters, digits and `_`, starting with a
 * letter or `_`, or `$name` in a query cannot refer to it. Caught in source,
 * before a build; GRAF106 checks the emitted uids too.
 */
export const uidSyntaxRule: LintRule = {
  id: "GRAF001",
  severity: "error",
  category: "correctness",
  description: "Dashboard or datasource uid Grafana rejects, or a variable name queries can't reference",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;
    for (const { name, arg } of constructorArgs(source, (n) => UID_OWNERS.has(n) || VARIABLE_CLASS.test(n))) {
      for (const prop of arg.properties) {
        const key = propertyName(prop);
        if (!key) continue;
        const text = literalText((prop as ts.PropertyAssignment).initializer);
        if (text === undefined) continue;
        if (UID_OWNERS.has(name) && key === "uid" && !UID_PATTERN.test(text)) {
          diagnostics.push({
            ruleId: "GRAF001",
            severity: "error",
            message: `${name} uid "${text}" is not a Grafana uid; use 1-40 letters, digits, "-" and "_"`,
            file: context.filePath,
            ...position(source, prop),
          });
        }
        if (VARIABLE_CLASS.test(name) && key === "name" && !VARIABLE_NAME.test(text)) {
          diagnostics.push({
            ruleId: "GRAF001",
            severity: "error",
            message: `variable name "${text}" can't be referenced as $name; use letters, digits and "_", not starting with a digit`,
            file: context.filePath,
            ...position(source, prop),
          });
        }
      }
    }
    return diagnostics;
  },
};
