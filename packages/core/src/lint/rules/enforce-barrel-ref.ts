import * as ts from "typescript";
import { basename } from "path";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR007: enforce-barrel-ref
 *
 * Flags direct sibling imports (`import { dataBucket } from "./data-bucket"`)
 * in non-barrel files. Use `_.$` instead.
 *
 * Triggers on: import { dataBucket } from "./data-bucket"
 * OK: import * as _ from "./_"
 * OK: import { dataBucket } from "./data-bucket" (in _.ts barrel files)
 */

const barrelPattern = /^\.\/(_|_\..*)$/;

export const enforceBarrelRefRule: LintRule = {
  id: "COR007",
  severity: "warning",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const sf = context.sourceFile;

    // Skip barrel files
    if (basename(context.filePath).startsWith("_")) return diagnostics;

    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;

      const modulePath = stmt.moduleSpecifier.text;

      // Skip non-relative imports
      if (!modulePath.startsWith("./") && !modulePath.startsWith("../")) continue;

      // Skip barrel imports
      if (barrelPattern.test(modulePath)) continue;

      // This is a direct sibling import — flag it
      const { line, character } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
      const importText = stmt.getText(sf);

      // Extract imported names for the suggestion
      const importedNames: string[] = [];
      const clause = stmt.importClause;
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            importedNames.push(el.name.text);
          }
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          importedNames.push(clause.namedBindings.name.text + ".*");
        }
      }

      const refSuggestion =
        importedNames.length > 0
          ? `\n  Access via: ${importedNames.map((n) => `_.$.${n}`).join(", ")}`
          : "";

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR007",
        severity: "warning",
        message: `Direct sibling import — use _.$ instead.\n    - ${importText}${refSuggestion}`,
      });
    }

    return diagnostics;
  },
};
