import type { LintContext, LintDiagnostic, LintRule } from "@intentius/chant/lint/rule";
import { parseCreate } from "../../clickhouse/parser";
import { SqlSyntaxError } from "../../clickhouse/tokens";
import { findTemplates, templatePosition, tokensOf } from "./templates";

const STATEMENT: Record<string, string> = { database: "CREATE DATABASE", table: "CREATE TABLE", view: "CREATE VIEW", dictionary: "CREATE DICTIONARY", function: "CREATE FUNCTION" };
/** The tag a statement belongs in: `func` for a function, the statement's own name otherwise. */
const tagOf = (statement: string): string => (statement === "function" ? "func" : statement);

/**
 * SQLCH001: the DDL in a `database`, `table`, `view`, `dictionary` or `func` template does not parse, or holds another statement than its tag.
 *
 * The same parse runs when the build calls the tag, and fails the build there.
 * This rule reports it in the editor and in `chant lint`, at the token, before
 * anything is built. Interpolations are references here, since lint cannot
 * know their values, so an error inside text a string interpolation supplies
 * is left to the build.
 */
export const sqlch001: LintRule = {
  id: "SQLCH001",
  severity: "error",
  category: "correctness",
  description: "ClickHouse DDL in a database, table or view template does not parse",

  check(context: LintContext): LintDiagnostic[] {
    const source = context.sourceFile;
    const out: LintDiagnostic[] = [];
    for (const found of findTemplates(source)) {
      let tokens;
      try {
        tokens = tokensOf(found);
        const node = parseCreate(tokens);
        if (tagOf(node.statement) !== found.tag) {
          out.push({
            ruleId: "SQLCH001",
            severity: "error",
            message: `${found.tag}\`...\` holds a ${STATEMENT[node.statement]}; use the ${tagOf(node.statement)} tag`,
            file: context.filePath,
            ...templatePosition(source, found, 0, 0),
          });
        }
      } catch (err) {
        if (!(err instanceof SqlSyntaxError)) throw err;
        out.push({
          ruleId: "SQLCH001",
          severity: "error",
          message: `ClickHouse DDL does not parse: ${err.message}`,
          file: context.filePath,
          ...templatePosition(source, found, err.part, err.offset),
        });
      }
    }
    return out;
  },
};
