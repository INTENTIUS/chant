/** What reading a file of DDL shares across dialects. */

import type { Token } from "../core/tokens";
import type { UnknownClause } from "../core/cursor";
import type { SqlDialect } from "../dialects";
import { statementKind } from "../coverage";

export interface ReadOptions {
  /** Names the DDL in errors: a file's path, a command. */
  origin: string;
  /**
   * The Postgres schema (ClickHouse database) for the names the DDL leaves
   * unqualified, as an ORM does when the schema comes from its connection.
   */
  schema?: string;
  /**
   * Where a statement of a kind chant cannot declare goes (#3911), as a line
   * naming it, instead of among the problems: `chant import
   * --parser-option skipUndeclarable` lists them as warnings.
   */
  undeclarable?: string[];
}

/**
 * A `CREATE` of a kind the coverage table does not mark declared, as the line
 * that names it with why, or undefined for any other statement.
 */
export function undeclarableStatement(dialect: SqlDialect, sql: string): string | undefined {
  const row = statementKind(dialect, sql);
  if (!row || row.status === "declared") return undefined;
  return `${row.kind}: chant cannot declare it (${row.reason ?? row.status}): ${firstLine(sql)}`;
}

/** A file of DDL with statements that declare nothing chant can hold: each problem names its statement. */
export class SqlFileError extends Error {
  constructor(
    readonly origin: string,
    readonly problems: readonly string[],
  ) {
    super(
      `${origin}: ${problems.length === 1 ? "a statement" : `${String(problems.length)} statements`} chant cannot read as declarations:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "SqlFileError";
  }
}

/** The statements of a file, each as its tokens (trivia kept inside, trimmed at the ends), split on top-level `;`. */
export function splitTokens(tokens: readonly Token[], isTrivia: (t: Token) => boolean): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  const flush = () => {
    let from = 0;
    let to = current.length;
    while (from < to && isTrivia(current[from]!)) from++;
    while (to > from && isTrivia(current[to - 1]!)) to--;
    if (to > from) out.push(current.slice(from, to));
    current = [];
  };
  for (const t of tokens) {
    if (t.kind === "punct" && t.text === ";") flush();
    else current.push(t);
  }
  flush();
  return out;
}

export const tokensText = (tokens: readonly Token[]): string => tokens.map((t) => t.text).join("");

/** Where an object's statement starts in its file, and the clauses in it chant does not read (#3872). */
export interface FileLine {
  /** The line its statement starts on, from 1. */
  line?: number;
  /** Each clause the parser does not know, with the file line it starts on; absent when there are none. */
  unparsed?: Array<{ clause: string; line: number; column?: string }>;
}

/** A statement's unknown clauses with their lines in the file: `line` is the statement's, `sql` its text, `tokens` its tokens. */
export function fileUnparsed(
  unknown: readonly UnknownClause[] | undefined,
  tokens: readonly Token[],
  sql: string,
  line: number,
): FileLine["unparsed"] {
  if (!unknown || unknown.length === 0) return undefined;
  return unknown.map((u) => ({ clause: u.clause, line: line + lineAt(sql, tokens[u.span.from]?.start ?? 0) - 1, ...(u.column !== undefined ? { column: u.column } : {}) }));
}

/** The line, from 1, that offset `at` of `text` is on. */
export const lineAt = (text: string, at: number): number => text.slice(0, at).split("\n").length;

/** A statement's first line, for a message. */
export const firstLine = (s: string): string => (s.split("\n")[0] ?? "").slice(0, 100);

/** A name as SQL text: bare when it is a plain lower-case identifier, else double-quoted. */
export const quoteBare = (name: string): string => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);
