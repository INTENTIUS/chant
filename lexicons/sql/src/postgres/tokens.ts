/**
 * Postgres's lexical rules over the shared lossless tokenizer
 * (`../core/tokens.ts`, chant #3278), from the Postgres 18 reference,
 * "Lexical Structure":
 *
 * - `"` quotes an identifier; a backtick is an operator character.
 * - A backslash is an ordinary character in `'...'` (standard_conforming_strings
 *   is on by default since 9.1) and escapes only in an `E'...'` string. `B'...'`,
 *   `X'...'`, `N'...'` and `U&'...'` are strings too, each one token.
 * - `$$...$$` and `$tag$...$tag$` are strings; `$1` is a parameter.
 * - Block comments nest.
 * - `( ) , ; . [ ]` are punctuation; `=` is an operator, so `WITH (a = 1)`
 *   reads `=` as an `op` token.
 * - A number never runs into a name: `42`, `3.5`, `.5`, `1e-3`, `0x1F`,
 *   `0o17`, `0b101`, `1_000`.
 * - A multi-character operator does not end in `+` or `-` unless it holds
 *   one of `~ ! @ # % ^ & | \` ?`, so `fillfactor=-30` reads `=` then `-`.
 */

import { tokenize as tokenizeWith, tokenizeText as tokenizeTextWith, type LexicalRules, type Token } from "../core/tokens";

export { isTrivia, SqlSyntaxError, untokenize, type LexicalRules, type Token, type TokenKind } from "../core/tokens";

export const POSTGRES_LEXICAL: LexicalRules = {
  identQuotes: '"',
  backslashEscapes: false,
  punct: "(),;.[]",
  // The operator characters (sql-syntax-lexical, "Operators"), and `:` for the `::` cast.
  opChars: /[+\-*/<>=~!@#%^&|`?:]/,
  prefixedStrings: true,
  dollarQuotes: true,
  nestedComments: true,
  numbers: "sql",
  unicodeIdentifiers: true,
  operatorsEndWithoutSign: true,
};

/** Tokenize one string with Postgres's rules. `part` is the part index recorded on each token and on an error. */
export function tokenizeText(src: string, part: number): Token[] {
  return tokenizeTextWith(src, part, POSTGRES_LEXICAL);
}

/** Tokenize a template's parts with Postgres's rules, with a `ref` token for each interpolation between them. */
export function tokenize(parts: readonly string[]): Token[] {
  return tokenizeWith(parts, POSTGRES_LEXICAL);
}
