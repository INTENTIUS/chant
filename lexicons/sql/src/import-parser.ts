/**
 * `chant import schema.sql`: a file of DDL into the import IR, in either
 * dialect, or a SQL Server (T-SQL) schema into ClickHouse declarations.
 *
 * `--parser-option from=sqlserver` (#4398) reads the file as T-SQL and
 * translates it to ClickHouse (`./sqlserver/translate.ts`). SQL Server is an
 * import source, not a dialect: nothing is declared in it, and a build never
 * holds one. A file with T-SQL's own markers (`[bracketed]` names, a `GO`
 * line, `CLUSTERED` or `COLUMNSTORE`, `nvarchar`, `IDENTITY(1,1)`) is read
 * the same way without the option, so it is not taken for Postgres.
 * `from=sqlserver` with `dialect=...` is refused: the target is ClickHouse.
 *
 * `--parser-option dialect=postgres` (or `clickhouse`) names the dialect;
 * without one it is read off the statements: an `ENGINE =` clause, a
 * `CREATE DATABASE`, a `CREATE DICTIONARY` or a lambda `CREATE FUNCTION f AS
 * (x) -> ...` is ClickHouse, a statement
 * only Postgres has (`CREATE SCHEMA`, `CREATE INDEX`, `COMMENT ON`, `ALTER
 * TABLE`, `GRANT`, ...) or a `CREATE TABLE` with no engine is Postgres, and
 * anything else is ClickHouse.
 *
 * A statement that declares nothing, or does not parse, is an error naming
 * it (`./sql-files.ts`); none is left out. So is a `CREATE` of a kind chant
 * cannot declare (#3911, `./coverage.ts`): `--parser-option
 * skipUndeclarable` imports the rest and lists those as warnings. A clause the parser does not know
 * (#3872) is kept in the template as written.
 */

import type { ParserOptions, TemplateIR, TemplateParser } from "@intentius/chant/import/parser";
import { SQL_DIALECTS, type SqlDialect } from "./dialects";
import { readClickHouse } from "./files/clickhouse";
import { readPostgres } from "./files/postgres";
import { SqlFileError } from "./files/common";
import { objectsToIR as chObjectsToIR } from "./clickhouse/import/ir";
import { objectsToIR as pgObjectsToIR } from "./postgres/import/ir";
import { namedCollectionPrerequisites } from "./clickhouse/named-collections";
import { translateSqlServer } from "./sqlserver/translate";
import { TsqlLexError } from "./sqlserver/lexer";

const CLICKHOUSE_ONLY = [
  /\bENGINE\s*=/i,
  /^\s*CREATE\s+(?:DATABASE|(?:OR\s+REPLACE\s+)?DICTIONARY)\b/im,
  // A SQL function: CREATE FUNCTION f AS (x) -> ...
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[^\s(]+(?:\s+ON\s+CLUSTER\s+\S+)?\s+AS\s*\(/im,
  // A row policy (#3711): Postgres says CREATE POLICY.
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?ROW\s+POLICY\b/im,
];
const POSTGRES_ONLY = [
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:SCHEMA|EXTENSION|TYPE|DOMAIN|SEQUENCE|(?:UNIQUE\s+)?INDEX|(?:CONSTRAINT\s+)?TRIGGER|POLICY|ROLE|FUNCTION|PROCEDURE|(?:UNLOGGED|TEMP|TEMPORARY)\s+TABLE)\b/im,
  /^\s*(?:COMMENT\s+ON|ALTER\s+TABLE|ALTER\s+DEFAULT\s+PRIVILEGES|GRANT|REVOKE|BEGIN)\b/im,
  /^\s*CREATE\s+TABLE\b/im,
];

/**
 * Markers only T-SQL has. Each is rare enough in Postgres and ClickHouse DDL
 * that one is enough: a bracketed name after CREATE TABLE or ON, a `GO`
 * batch line, `CLUSTERED`/`COLUMNSTORE`, T-SQL type names, `IDENTITY(n, n)`,
 * the `SET ANSI_NULLS` preamble of an SSMS script.
 */
const TSQL_MARKERS = [
  /^\s*GO\s*$/im,
  /\bCREATE\s+(?:UNIQUE\s+)?(?:NONCLUSTERED\s+|CLUSTERED\s+)(?:COLUMNSTORE\s+)?INDEX\b/i,
  /\bCREATE\s+(?:NONCLUSTERED\s+|CLUSTERED\s+)?COLUMNSTORE\s+INDEX\b/i,
  /\bPRIMARY\s+KEY\s+(?:NON)?CLUSTERED\b/i,
  /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|\bON|REFERENCES)\s+\[[^\]\n]+\]/i,
  /\b(?:NVARCHAR|NCHAR|UNIQUEIDENTIFIER|DATETIME2|DATETIMEOFFSET|SMALLDATETIME|SMALLMONEY|ROWVERSION)\b/i,
  /\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i,
  /^\s*SET\s+(?:ANSI_NULLS|QUOTED_IDENTIFIER|NOCOUNT|ANSI_PADDING)\b/im,
  /\bEXEC(?:UTE)?\s+sp_addextendedproperty\b/i,
];

/** True when the DDL has a marker only T-SQL has and no ClickHouse-only clause. */
export function looksLikeTSql(content: string): boolean {
  const text = content.replace(/--[^\n]*/g, "");
  if (CLICKHOUSE_ONLY.some((re) => re.test(text))) return false;
  return TSQL_MARKERS.some((re) => re.test(text));
}

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

/** Sources other than a dialect that `--parser-option from=` names. */
export const IMPORT_SOURCES = ["sqlserver"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** The `from` parser option, checked. */
export function sourceOption(options: ParserOptions | undefined): ImportSource | undefined {
  const f = options?.from;
  if (f === undefined) return undefined;
  if (typeof f !== "string" || !(IMPORT_SOURCES as readonly string[]).includes(f)) throw new Error(`--parser-option from: expected ${IMPORT_SOURCES.join(" or ")}, got ${String(f)}`);
  if (options?.dialect !== undefined) throw new Error(`--parser-option from=${f} cannot be combined with dialect: a ${f} schema is translated to ClickHouse`);
  return f as ImportSource;
}

export class SqlFileParser implements TemplateParser {
  constructor(
    private readonly dialect?: SqlDialect,
    private readonly options: { skipUndeclarable?: boolean; from?: ImportSource } = {},
  ) {}

  parse(content: string): TemplateIR {
    if (this.options.from === "sqlserver" || (this.dialect === undefined && looksLikeTSql(content))) return this.parseSqlServer(content);
    const dialect = this.dialect ?? guessDialect(content);
    const problems: string[] = [];
    const skipped: string[] = [];
    const prerequisites: Array<{ kind: string; name: string }> = [];
    const read = { origin: "the DDL", prerequisites, ...(this.options.skipUndeclarable ? { undeclarable: skipped } : {}) };
    const ir = dialect === "postgres" ? pgObjectsToIR(readPostgres(content, read, problems)) : chObjectsToIR(readClickHouse(content, read, problems));
    if (problems.length > 0) throw new SqlFileError(`the ${dialect === "postgres" ? "Postgres" : "ClickHouse"} DDL`, problems);
    // A named collection is the environment's (#4395): its CREATE, or a declaration naming one, is a prerequisite, its values never imported.
    const objects = ir.resources.map((r) => r.properties as { database?: string; name: string; ddl: string });
    const prereq =
      dialect === "clickhouse"
        ? namedCollectionPrerequisites(prerequisites, objects, { found: "the DDL creates it", unseen: "the DDL does not create it" })
        : { prerequisites: [], warnings: [] };
    const warnings = [...(ir.warnings ?? []), ...prereq.warnings, ...skipped.map((s) => `left out (skipUndeclarable): ${s}`)];
    const out = prereq.prerequisites.length > 0 ? { ...ir, metadata: { ...ir.metadata, prerequisites: prereq.prerequisites } } : ir;
    return warnings.length > 0 ? { ...out, warnings } : out;
  }

  /** A T-SQL schema as ClickHouse objects, with a finding for each judgment call (#4398). */
  private parseSqlServer(content: string): TemplateIR {
    let t;
    try {
      t = translateSqlServer(content, { skipUnreadable: this.options.skipUndeclarable === true });
    } catch (e) {
      if (e instanceof TsqlLexError) throw new SqlFileError("the SQL Server DDL", [e.message]);
      throw e;
    }
    if (t.problems.length > 0) throw new SqlFileError("the SQL Server DDL", t.problems);
    const ir = chObjectsToIR(t.objects);
    return { ...ir, diagnostics: t.diagnostics, metadata: { ...ir.metadata, source: "sqlserver" } };
  }
}
