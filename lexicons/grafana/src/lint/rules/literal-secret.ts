import * as ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { constInitializers, constructorArgs, literalText, position, propertyName, resolveObject } from "./grafana-ast";

/** How Grafana provisioning reads a value from outside the file: `$VAR`, `${VAR}`, `$__env{…}`, `$__file{…}`, `$__vault{…}`. */
const EXPANDED = /\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*|__(env|file|vault)\{[^}]+\})/;

/**
 * GRAF002: a datasource secret written as a literal.
 *
 * `secureJsonData` holds passwords, tokens and TLS keys. A literal there is a
 * secret in the repository and in the emitted provisioning file. Grafana
 * expands `$__env{NAME}`, `$__file{/path}` and `${NAME}` when it reads the
 * file, so the declaration never needs the value. A value written as a
 * named `const` in the same file is followed.
 */
export const literalSecretRule: LintRule = {
  id: "GRAF002",
  severity: "error",
  category: "security",
  description: "Datasource secureJsonData value declared as a literal instead of $__env{...} or $__file{...}",

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
    return diagnostics;
  },
};
