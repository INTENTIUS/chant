import * as ts from "typescript";
import type { LintContext, LintDiagnostic, LintRule } from "@intentius/chant/lint/rule";
import { findTemplates } from "./templates";

/** The entity's own members: an interpolation of one of them is never a column. */
const OWN_MEMBERS = new Set(["kind", "lexicon", "entityType", "props", "sqlName", "dependsOn"]);

/**
 * Identifiers that hold a ClickHouse entity, as far as one file can tell:
 * bound to a sql tag here, or imported from another file of the project.
 */
function entityBindings(source: ts.SourceFile, tagged: Set<ts.Node>): Set<string> {
  const out = new Set<string>();
  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text.startsWith(".")) {
      const named = stmt.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const el of named.elements) out.add(el.name.text);
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && tagged.has(d.initializer)) out.add(d.name.text);
      }
    }
  }
  return out;
}

/**
 * SQLCH003: a column written as `${events.kind}` instead of
 * `${events.columns.kind}`.
 *
 * Columns are reached through `.columns`. `kind`, `lexicon`, `entityType`,
 * `props`, `sqlName` and `dependsOn` are the entity's own fields, so
 * `${events.kind}` is the string `"resource"`, which the tag splices in as SQL
 * text: the statement builds and means something else. This rule flags it for
 * an entity the file declares or imports from another project file.
 */
export const sqlch003: LintRule = {
  id: "SQLCH003",
  severity: "error",
  category: "correctness",
  description: "A column interpolated without .columns reads the entity's own field instead",

  check(context: LintContext): LintDiagnostic[] {
    const source = context.sourceFile;
    const found = findTemplates(source);
    if (found.length === 0) return [];
    const entities = entityBindings(source, new Set(found.map((f) => f.node)));
    const out: LintDiagnostic[] = [];
    for (const f of found) {
      for (const expr of f.expressions) {
        if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression)) continue;
        const owner = expr.expression.text;
        const member = expr.name.text;
        if (!entities.has(owner) || !OWN_MEMBERS.has(member)) continue;
        const { line, character } = source.getLineAndCharacterOfPosition(expr.getStart(source));
        out.push({
          ruleId: "SQLCH003",
          severity: "error",
          message: `\${${owner}.${member}} is the entity's own "${member}" field, not a column; write \${${owner}.columns.${member}}`,
          file: context.filePath,
          line: line + 1,
          column: character + 1,
        });
      }
    }
    return out;
  },
};
