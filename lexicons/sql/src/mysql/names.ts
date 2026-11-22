/**
 * Writing MySQL names and strings: a name bare when MySQL reads it bare, else
 * backquoted; a string single-quoted with its quotes and backslashes escaped.
 */

import { RESERVED_WORDS } from "../generated/mysql";

const RESERVED: ReadonlySet<string> = RESERVED_WORDS as ReadonlySet<string>;

/** A name as MySQL reads it: bare when it is a plain identifier and not a reserved word, backquoted otherwise. */
export function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name.toUpperCase()) ? name : `\`${name.replace(/`/g, "``")}\``;
}

/** `db.name`, or `name` alone, each part quoted as needed. */
export const qualifiedName = (o: { database?: string; name: string }): string => (o.database ? `${quoteIdent(o.database)}.${quoteIdent(o.name)}` : quoteIdent(o.name));

/** A string as a MySQL string literal: single-quoted, a quote doubled and a backslash escaped. */
export function mysqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}
