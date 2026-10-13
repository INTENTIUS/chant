import type { LintContext, LintDiagnostic, LintRule } from "@intentius/chant/lint/rule";
import { parseStatements, SqlSyntaxError } from "../../postgres/parser";
import { findPostgresTemplates, postgresTokensOf } from "./postgres-templates";
import { declaredText, generatedNamesFor, nameAgrees, normalizedName, splitQualified, SQL_TYPES_FILE, typeArgumentName } from "./typed-names";

const MODULE = "@intentius/chant-lexicon-sql/postgres";

/**
 * SQLPG005: a typed Postgres tag whose type argument does not name the object
 * its template declares, or is not in the generated `sql-types.d.ts`.
 *
 * `table<"shop.orders">\`CREATE TABLE shop.orders ...\`` types `.columns` from
 * the generated file's `SqlSchema["shop.orders"]`. tsc does not compare the
 * argument with the template's text, and an argument the file does not list
 * falls back to unchecked columns, so a typo checks nothing and says nothing.
 * The rule reads the declared name from the template (a schema supplied by an
 * interpolation is not known to lint, and is left out of the comparison) and
 * the listed names from the nearest `sql-types.d.ts` above the file. With no
 * generated file, only the first check runs. A name missing from the file is
 * a warning, since a table added since the last `chant sql types` is stale
 * and `chant sql types --check` is what fails on it.
 *
 * chant#3787: `schema<"app">\`CREATE SCHEMA app\`` is read too, since a
 * composite placed in the schema builds its members' qualified names from
 * that argument. A schema is not in the generated file, so only the name
 * comparison runs, and the argument is the schema's own name, one piece.
 */
export const sqlpg005: LintRule = {
  id: "SQLPG005",
  severity: "error",
  category: "correctness",
  description: "A Postgres tag's type argument does not name the object its template declares, or is not in sql-types.d.ts",

  check(context: LintContext): LintDiagnostic[] {
    const source = context.sourceFile;
    const out: LintDiagnostic[] = [];
    let listed: Set<string> | undefined | null = null;
    for (const found of findPostgresTemplates(source)) {
      if (found.tag !== "table" && found.tag !== "view" && found.tag !== "schema") continue;
      const arg = typeArgumentName(found.node);
      if (!arg) continue;
      const at = (() => {
        const { line, character } = source.getLineAndCharacterOfPosition(arg.node.getStart(source));
        return { line: line + 1, column: character + 1 };
      })();
      let declared: string[] | undefined;
      try {
        const node = parseStatements(postgresTokensOf(found))[0];
        if (node && (node.statement === "table" || node.statement === "view")) declared = node.name.pieces;
        else if (node && node.statement === "schema" && found.tag === "schema") declared = node.name?.pieces;
      } catch (err) {
        if (err instanceof SqlSyntaxError) continue; // SQLPG001 reports it
        throw err;
      }
      if (!declared) continue; // SQLPG001: the tag holds another statement
      const agrees = found.tag === "schema" ? splitQualified(arg.name).length === 1 && nameAgrees(declared, arg.name) : nameAgrees(declared, arg.name);
      if (!agrees) {
        out.push({
          ruleId: "SQLPG005",
          severity: "error",
          message: `${found.tag}<"${arg.name}"> names another object than the template declares (${declaredText(declared)}); the type argument is the qualified name the build renders`,
          file: context.filePath,
          ...at,
        });
        continue;
      }
      if (found.tag === "schema") continue;
      if (listed === null) listed = generatedNamesFor(context.filePath, MODULE);
      if (listed && !listed.has(normalizedName(arg.name))) {
        out.push({
          ruleId: "SQLPG005",
          severity: "warning",
          message: `"${arg.name}" is not in ${SQL_TYPES_FILE}, so its columns are unchecked; run \`chant sql types\` to add it`,
          file: context.filePath,
          ...at,
        });
      }
    }
    return out;
  },
};
