import type { LintContext, LintDiagnostic, LintRule } from "@intentius/chant/lint/rule";
import { parseStatements, SqlSyntaxError } from "../../postgres/parser";
import { followOnStray, STATEMENT_NAMES, type PostgresTag } from "../../postgres/entities";
import { findPostgresTemplates, postgresTokensOf, templatePosition, tokenPosition } from "./postgres-templates";

/** The statement each tag holds. */
const STATEMENT: Record<PostgresTag, string> = {
  schema: "schema",
  table: "table",
  index: "index",
  view: "view",
  sequence: "sequence",
  type: "enum",
  domain: "domain",
  extension: "extension",
  func: "function",
  procedure: "procedure",
  trigger: "trigger",
  policy: "policy",
  role: "role",
  grant: "grant",
};

const TAG_OF: Record<string, PostgresTag> = Object.fromEntries(Object.entries(STATEMENT).map(([tag, statement]) => [statement, tag as PostgresTag]));

/**
 * SQLPG001: the DDL in a Postgres template does not parse, or does not hold
 * what its tag declares.
 *
 * The same parse runs when the build calls the tag, and fails the build there.
 * This rule reports it in the editor and in `chant lint`, at the token, as a
 * line and column of the `.ts` file, before anything is built. It also reports
 * what the tag refuses after parsing: another statement than the tag's, a
 * second CREATE in one template, and an index with no name (its name is its
 * identity on the server). Interpolations are references here, since lint
 * cannot know their values, so an error inside text a string interpolation
 * supplies is left to the build.
 */
export const sqlpg001: LintRule = {
  id: "SQLPG001",
  severity: "error",
  category: "correctness",
  description: "Postgres DDL in a tagged template does not parse, or holds another statement than its tag",

  check(context: LintContext): LintDiagnostic[] {
    const source = context.sourceFile;
    const out: LintDiagnostic[] = [];
    const report = (message: string, at: { line: number; column: number }) =>
      out.push({ ruleId: "SQLPG001", severity: "error", message, file: context.filePath, ...at });
    for (const found of findPostgresTemplates(source)) {
      const tokens = (() => {
        try {
          return postgresTokensOf(found);
        } catch (err) {
          if (!(err instanceof SqlSyntaxError)) throw err;
          report(`Postgres DDL does not parse: ${err.message}`, templatePosition(source, found, err.part, err.offset));
          return undefined;
        }
      })();
      if (!tokens) continue;
      try {
        const [node, ...rest] = parseStatements(tokens);
        if (node!.statement !== STATEMENT[found.tag]) {
          const use = TAG_OF[node!.statement];
          report(
            use
              ? `${found.tag}\`...\` holds a ${STATEMENT_NAMES[node!.statement]}; use the ${use} tag`
              : `${found.tag}\`...\` starts with a ${STATEMENT_NAMES[node!.statement]}; it goes after the CREATE it belongs to`,
            templatePosition(source, found, 0, 0),
          );
          continue;
        }
        const stray = followOnStray(found.tag, rest);
        if (stray) {
          report(
            `${found.tag}\`...\` holds a second statement (${STATEMENT_NAMES[stray.statement]}); a template declares one object, followed only by COMMENT ON statements for it${found.tag === "table" ? " and ALTER TABLE ... ROW LEVEL SECURITY" : ""}`,
            templatePosition(source, found, 0, 0),
          );
        }
        if (node!.statement === "index" && !node!.name) {
          const on = tokens.find((t) => t.kind === "ident" && t.text.toUpperCase() === "ON");
          report(
            "an index needs a name: the name is its identity on the server, and an unnamed index gets a generated one",
            on ? tokenPosition(source, found, on) : templatePosition(source, found, 0, 0),
          );
        }
      } catch (err) {
        if (!(err instanceof SqlSyntaxError)) throw err;
        report(`Postgres DDL does not parse: ${err.message}`, err.token ? tokenPosition(source, found, err.token) : templatePosition(source, found, err.part, err.offset));
      }
    }
    return out;
  },
};
