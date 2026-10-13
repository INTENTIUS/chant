/**
 * ClickHouse's lexical rules over the shared lossless tokenizer
 * (`../core/tokens.ts`, chant #3196): `` ` `` and `"` quote an identifier, a
 * backslash escapes inside any quote, `( ) , ; . =` are punctuation, and a
 * number may run into letters (`00662_events`, which the parser accepts as a
 * name).
 */

import { tokenize as tokenizeWith, tokenizeText as tokenizeTextWith, type LexicalRules, type Token } from "../core/tokens";

export { isTrivia, SqlSyntaxError, untokenize, type LexicalRules, type Token, type TokenKind } from "../core/tokens";

export const CLICKHOUSE_LEXICAL: LexicalRules = {
  identQuotes: '`"',
  backslashEscapes: true,
  punct: "(),;.=",
  opChars: /[+\-*/%<>!|&^~?:[\]{}@]/,
};

/** Tokenize one string with ClickHouse's rules. `part` is the part index recorded on each token and on an error. */
export function tokenizeText(src: string, part: number): Token[] {
  return tokenizeTextWith(src, part, CLICKHOUSE_LEXICAL);
}

/** Tokenize a template's parts with ClickHouse's rules, with a `ref` token for each interpolation between them. */
export function tokenize(parts: readonly string[]): Token[] {
  return tokenizeWith(parts, CLICKHOUSE_LEXICAL);
}
