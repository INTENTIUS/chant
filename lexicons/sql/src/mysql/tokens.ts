/**
 * MySQL's character-level rules for the shared tokenizer (`../core/tokens.ts`),
 * as the MySQL 8.0 reference manual gives them ("Schema Object Names",
 * "String Literals", "Comments"):
 *
 * - an identifier is quoted with backquotes; a doubled backquote is one;
 * - a string is quoted with `'` or `"` (the session's default `sql_mode` has
 *   no `ANSI_QUOTES`), and a backslash escapes inside it;
 * - `--`, `#` and `/* ... *\/` are comments, and a block comment does not nest;
 * - an unquoted name may hold letters outside ASCII and `$`.
 */

import { tokenize as tokenizeWith, tokenizeText as tokenizeTextWith, type LexicalRules, type Token } from "../core/tokens";
import { unquoteWith } from "../core/cursor";

export { isTrivia, SqlSyntaxError, untokenize, type LexicalRules, type Token, type TokenKind } from "../core/tokens";

export const MYSQL_LEXICAL: LexicalRules = {
  identQuotes: "`",
  backslashEscapes: true,
  punct: "(),;.=",
  opChars: /[+\-*/%<>!|&^~?:@]/,
  numbers: "sql",
  unicodeIdentifiers: true,
  doubleQuotedStrings: true,
  hashComments: true,
};

/** Tokenize one string with MySQL's rules. */
export function tokenizeText(src: string, part = 0): Token[] {
  return tokenizeTextWith(src, part, MYSQL_LEXICAL);
}

/** Tokenize a template's parts with MySQL's rules, with a `ref` token for each interpolation between them. */
export function tokenize(parts: readonly string[]): Token[] {
  return tokenizeWith(parts, MYSQL_LEXICAL);
}

/** A name with its backquotes taken off. MySQL compares database, table and column names as written on Linux. */
export const unquote = (text: string): string => unquoteWith(text, "`");

/** A `'quoted'` or `"quoted"` string literal's value, escapes undone. */
export function stringValue(text: string): string {
  const q = text[0];
  if ((q !== "'" && q !== '"') || text[text.length - 1] !== q) return text;
  const inner = text.slice(1, -1);
  return inner.replace(new RegExp(`${q}${q}`, "g"), q).replace(/\\(.)/gs, (_m, c: string) => ({ n: "\n", t: "\t", r: "\r", "0": "\0", Z: "\x1a" })[c] ?? c);
}
