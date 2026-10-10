/**
 * `chant import schema.sql`: a file of DDL into the import IR, in either
 * dialect. `--parser-option dialect=postgres` (or `clickhouse`) names it;
 * without one it is read off the statements: an `ENGINE =` clause, a
 * `CREATE DATABASE`, a `CREATE DICTIONARY` or a lambda `CREATE FUNCTION f AS
 * (x) -> ...` is ClickHouse, a statement
 * only Postgres has (`CREATE SCHEMA`, `CREATE INDEX`, `COMMENT ON`, `ALTER
 * TABLE`, `GRANT`, ...) or a `CREATE TABLE` with no engine is Postgres, and
 * anything else is ClickHouse.
 *
 * A statement that declares nothing, or does not parse, is an error naming
 * it (`./sql-files.ts`); none is left out.
 */

import type { ParserOptions, TemplateIR, TemplateParser } from "@intentius/chant/import/parser";
import { SQL_DIALECTS, type SqlDialect } from "./dialects";
import { readClickHouse } from "./files/clickhouse";
import { readPostgres } from "./files/postgres";
import { SqlFileError } from "./files/common";
import { objectsToIR as chObjectsToIR } from "./clickhouse/import/ir";
import { objectsToIR as pgObjectsToIR } from "./postgres/import/ir";

const CLICKHOUSE_ONLY = [
  /\bENGINE\s*=/i,
  /^\s*CREATE\s+(?:DATABASE|(?:OR\s+REPLACE\s+)?DICTIONARY)\b/im,
  // A SQL function: CREATE FUNCTION f AS (x) -> ...
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[^\s(]+(?:\s+ON\s+CLUSTER\s+\S+)?\s+AS\s*\(/im,
];
const POSTGRES_ONLY = [
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:SCHEMA|EXTENSION|TYPE|DOMAIN|SEQUENCE|(?:UNIQUE\s+)?INDEX|(?:CONSTRAINT\s+)?TRIGGER|POLICY|ROLE|FUNCTION|PROCEDURE|(?:UNLOGGED|TEMP|TEMPORARY)\s+TABLE)\b/im,
  /^\s*(?:COMMENT\s+ON|ALTER\s+TABLE|ALTER\s+DEFAULT\s+PRIVILEGES|GRANT|REVOKE|BEGIN)\b/im,
  /^\s*CREATE\s+TABLE\b/im,
];

/** The dialect a file of DDL is written in, read off its statements. */
export function guessDialect(content: string): SqlDialect {
  const text = content.replace(/--[^\n]*/g, "");
  if (CLICKHOUSE_ONLY.some((re) => re.test(text))) return "clickhouse";
  if (POSTGRES_ONLY.some((re) => re.test(text))) return "postgres";
  return "clickhouse";
}

/** The `dialect` parser option, checked. */
export function dialectOption(options: ParserOptions | undefined): SqlDialect | undefined {
  const d = options?.dialect;
  if (d === undefined) return undefined;
  if (typeof d !== "string" || !(SQL_DIALECTS as readonly string[]).includes(d)) throw new Error(`--parser-option dialect: expected ${SQL_DIALECTS.join(" or ")}, got ${String(d)}`);
  return d as SqlDialect;
}

export class SqlFileParser implements TemplateParser {
  constructor(private readonly dialect?: SqlDialect) {}

  parse(content: string): TemplateIR {
    const dialect = this.dialect ?? guessDialect(content);
    const problems: string[] = [];
    const ir = dialect === "postgres" ? pgObjectsToIR(readPostgres(content, { origin: "the DDL" }, problems)) : chObjectsToIR(readClickHouse(content, { origin: "the DDL" }, problems));
    if (problems.length > 0) throw new SqlFileError(`the ${dialect === "postgres" ? "Postgres" : "ClickHouse"} DDL`, problems);
    return ir;
  }
}
