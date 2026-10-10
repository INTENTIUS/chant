import type { LintContext, LintDiagnostic, LintRule } from "@intentius/chant/lint/rule";
import { parseCreate } from "../../clickhouse/parser";
import { parseAccess } from "../../clickhouse/access";
import { SqlSyntaxError } from "../../clickhouse/tokens";
import { findTemplates, templatePosition, tokensOf } from "./templates";

const ACCESS_TAGS = new Set(["user", "role", "policy", "grant"]);
const ACCESS_STATEMENT: Record<string, string> = { user: "CREATE USER", role: "CREATE ROLE", rowPolicy: "CREATE ROW POLICY", grant: "GRANT" };

const STATEMENT: Record<string, string> = { database: "CREATE DATABASE", table: "CREATE TABLE", view: "CREATE VIEW", dictionary: "CREATE DICTIONARY", function: "CREATE FUNCTION" };
/** The tag a statement belongs in: `func` for a function, the statement's own name otherwise. */
const tagOf = (statement: string): string => (statement === "function" ? "func" : statement);

/**
 * SQLCH001: the DDL in a ClickHouse template (`database`, `table`, `view`, `dictionary`, `func`, `user`, `role`, `policy`, `grant`) does not parse, or holds another statement than its tag.
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
        if (ACCESS_TAGS.has(found.tag)) {
          const node = parseAccess(tokens);
          const tag = node.statement === "rowPolicy" ? "policy" : node.statement;
          if (tag !== found.tag || node.revoke) {
            out.push({
              ruleId: "SQLCH001",
              severity: "error",
              message: node.revoke
                ? `${found.tag}\`...\` holds a REVOKE; declare the grants a grantee keeps, and a plan revokes the rest`
                : `${found.tag}\`...\` holds a ${ACCESS_STATEMENT[node.statement]}; use the ${tag} tag`,
              file: context.filePath,
              ...templatePosition(source, found, 0, 0),
            });
          }
          continue;
        }
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
