/**
 * A column type, read into its family and parameters: `Nullable(String)` is
 * the family `Nullable` with the one parameter `String`;
 * `DateTime64(3, 'UTC')` is `DateTime64` with `3` and `'UTC'`.
 *
 * The reading is lexical, over the same tokenizer the parser uses, so a
 * string literal holding a parenthesis (`Enum8('a(' = 1)`) or a comma does not
 * split a parameter. What a parameter means (a type, a number, a name) is the
 * caller's question, answered from `TYPE_PARAMETERS`.
 */

import { isTrivia, tokenizeText, type Token } from "./tokens";

export interface TypeParam {
  /** The parameter as written, trimmed. */
  text: string;
  tokens: Token[];
}

export interface TypeSyntax {
  /** The words before the parameters: `UInt64`, `BIGINT UNSIGNED`, or `a String` for a named tuple element. */
  words: Token[];
  /** The parameters, or undefined when the type has no parentheses. */
  params?: TypeParam[];
}

const textOf = (tokens: readonly Token[]): string => tokens.map((t) => t.text).join("").trim();

/** The significant tokens of a type, or undefined when it does not tokenize. */
export function typeTokens(text: string): Token[] | undefined {
  try {
    return tokenizeText(text, 0);
  } catch {
    return undefined;
  }
}

/**
 * Read a type into its leading words and its parameters. Undefined when the
 * text is not a type this can read: no leading name, or unbalanced parentheses.
 * Anything after the closing parenthesis (`COLLATE utf8`) is ignored.
 */
export function readType(tokens: readonly Token[]): TypeSyntax | undefined {
  const sig = tokens.filter((t) => !isTrivia(t));
  const words: Token[] = [];
  let i = 0;
  // `String COLLATE utf8`: COLLATE ends the type's words.
  while (i < sig.length && (sig[i]!.kind === "ident" || sig[i]!.kind === "qident") && sig[i]!.text.toUpperCase() !== "COLLATE") words.push(sig[i++]!);
  if (words.length === 0) return undefined;
  if (i >= sig.length || !(sig[i]!.kind === "punct" && sig[i]!.text === "(")) return { words };
  // Parameters: the tokens up to the matching parenthesis, split at top-level commas.
  const start = tokens.indexOf(sig[i]!);
  const params: TypeParam[] = [];
  let depth = 0;
  let current: Token[] = [];
  for (let j = start; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.kind === "punct" && t.text === "(") {
      if (depth++ === 0) continue;
    } else if (t.kind === "punct" && t.text === ")") {
      if (--depth === 0) {
        if (params.length > 0 || current.some((x) => !isTrivia(x))) params.push({ text: textOf(current), tokens: current });
        return { words, params };
      }
    } else if (depth === 1 && t.kind === "punct" && t.text === ",") {
      params.push({ text: textOf(current), tokens: current });
      current = [];
      continue;
    }
    current.push(t);
  }
  return undefined;
}

/** A parameter that is a numeric literal, possibly negative: its value. */
export function numericParam(param: TypeParam): number | undefined {
  const sig = param.tokens.filter((t) => !isTrivia(t));
  const negative = sig.length === 2 && sig[0]!.kind === "op" && sig[0]!.text === "-";
  const n = negative ? sig[1] : sig.length === 1 ? sig[0] : undefined;
  if (!n || n.kind !== "number" || !/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(n.text)) return undefined;
  return negative ? -Number(n.text) : Number(n.text);
}
