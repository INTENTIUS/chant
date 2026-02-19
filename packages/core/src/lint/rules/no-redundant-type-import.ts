import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";

/**
 * COR012: no-redundant-type-import
 *
 * Flag `import type { X } from "@intentius/chant-pkg"` when a namespace import
 * `import * as pkg from "@intentius/chant-pkg"` already exists — the type is
 * accessible as `pkg.X`.
 */

export const noRedundantTypeImportRule: LintRule = {
  id: "COR012",
  severity: "warning",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const sf = context.sourceFile;

    // Pass 1: collect namespace imports from @intentius/chant* packages
    // Map: module specifier → namespace alias
    const namespaceImports = new Map<string, string>();

    for (const stmt of sf.statements) {
      if (
        ts.isImportDeclaration(stmt) &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        const modulePath = stmt.moduleSpecifier.text;
        if (!modulePath.startsWith("@intentius/chant") && !modulePath.startsWith("@intentius/chant-lexicon-")) continue;
        const clause = stmt.importClause;
        if (clause && clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          namespaceImports.set(modulePath, clause.namedBindings.name.text);
        }
      }
    }

    if (namespaceImports.size === 0) return diagnostics;

    // Pass 2: find type-only named imports from the same modules
    for (const stmt of sf.statements) {
      if (
        ts.isImportDeclaration(stmt) &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        const modulePath = stmt.moduleSpecifier.text;
        const alias = namespaceImports.get(modulePath);
        if (alias === undefined) continue;

        const clause = stmt.importClause;
        if (!clause || !clause.isTypeOnly) continue;
        if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;

        const typeNames = clause.namedBindings.elements.map(e => e.name.text);
        const qualifiedNames = typeNames.map(n => `${alias}.${n}`).join(", ");

        const { line, character } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));

        // Fix: remove the entire import line (including trailing newline)
        const start = stmt.getFullStart();
        const end = stmt.getEnd();
        // Extend past trailing newline if present
        const fullText = sf.getFullText();
        let fixEnd = end;
        if (fullText[fixEnd] === "\n") fixEnd++;
        else if (fullText[fixEnd] === "\r" && fullText[fixEnd + 1] === "\n") fixEnd += 2;

        diagnostics.push({
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: "COR012",
          severity: "warning",
          message: `Redundant type import — use ${qualifiedNames} instead. The namespace import already provides access to all exported types.`,
          fix: {
            range: [start, fixEnd],
            replacement: "",
          },
        });
      }
    }

    return diagnostics;
  },
};
