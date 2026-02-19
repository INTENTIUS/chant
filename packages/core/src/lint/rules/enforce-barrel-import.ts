import * as ts from "typescript";
import { existsSync } from "fs";
import { dirname, join, basename } from "path";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR014: enforce-barrel-import
 *
 * Flags direct lexicon imports (`import * as <name> from "@intentius/chant-lexicon-<name>"`)
 * in non-barrel files. Use the barrel (`import * as _ from "./_"`) instead.
 *
 * Triggers on: import * as <name> from "@intentius/chant-lexicon-<name>" (in non-barrel files)
 * OK: import * as _ from "./_"
 * OK: import * as <name> from "@intentius/chant-lexicon-<name>" (in _.ts barrel files)
 */

export const enforceBarrelImportRule: LintRule = {
  id: "COR014",
  severity: "warning",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const sf = context.sourceFile;

    // Skip barrel files
    if (basename(context.filePath).startsWith("_")) return diagnostics;

    // Check if barrel exists
    const dir = dirname(context.filePath);
    const barrelExists = existsSync(join(dir, "_.ts"));

    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;

      const modulePath = stmt.moduleSpecifier.text;
      if (!modulePath.startsWith("@intentius/chant") && !modulePath.startsWith("@intentius/chant-lexicon-")) continue;

      // Skip subpath imports (e.g., @intentius/chant/lint/rule) — these are
      // framework internals not available through the barrel
      const parts = modulePath.split("/");
      if (parts.length > 2) continue;

      const { line, character } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
      const importText = stmt.getText(sf);

      let message: string;
      if (barrelExists) {
        message = `Direct lexicon import — use the barrel.\n    - ${importText}\n    + import * as _ from "./_";`;
      } else {
        const lexiconPkg = modulePath;
        message =
          `Direct lexicon import — use a barrel file.\n\n` +
          `  Create _.ts:\n\n` +
          `    export * from "${lexiconPkg}";\n` +
          `    import { barrel } from "@intentius/chant";\n` +
          `    export const $ = barrel(import.meta.dir);\n\n` +
          `  Then replace this file's import:\n` +
          `    - ${importText}\n` +
          `    + import * as _ from "./_";`;
      }

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR014",
        severity: "warning",
        message,
        // Only provide auto-fix when barrel exists — replacing the import
        // when no barrel is present corrupts the file
        fix: barrelExists ? {
          range: [stmt.getStart(sf), stmt.getEnd()],
          replacement: `import * as _ from "./_"`,
        } : undefined,
      });
    }

    return diagnostics;
  },
};
