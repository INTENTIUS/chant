/**
 * Postgres key words and their categories at the pinned server, as
 * `pg_get_keywords()` reports them: what decides whether a bare word can be a
 * name. The parser refuses an unquoted reserved word (`R`) or type/function
 * name word (`T`) where a column, table or constraint name goes, as Postgres's
 * `ColId` does, and quoting reads the same table.
 */

import { STANDIN_KEYWORDS } from "./catalog-standin";

/** U unreserved, C column name, T type or function name, R reserved. */
export type KeywordCategory = "U" | "C" | "T" | "R";

const KEYWORDS: Readonly<Record<string, KeywordCategory>> = STANDIN_KEYWORDS;

/** A word's key word category, case-insensitively; undefined when it is not a key word. */
export function keywordCategory(word: string): KeywordCategory | undefined {
  const w = word.toLowerCase();
  return Object.prototype.hasOwnProperty.call(KEYWORDS, w) ? KEYWORDS[w] : undefined;
}

/** Whether `word` is a key word of any category. */
export const isKeyword = (word: string): boolean => keywordCategory(word) !== undefined;

/**
 * Whether `name` must be double-quoted to read back as itself: anything but a
 * lower-case identifier, and every key word that is not unreserved (a
 * `C` word such as `bigint` is a name only where a column name goes).
 */
export function needsQuotes(name: string): boolean {
  if (!/^[a-z_][a-z0-9_$]*$/.test(name)) return true;
  const k = keywordCategory(name);
  return k !== undefined && k !== "U";
}

/** A name as Postgres reads it back: bare when it can be, double-quoted otherwise. */
export function quoteIdent(name: string): string {
  return needsQuotes(name) ? `"${name.replace(/"/g, '""')}"` : name;
}
