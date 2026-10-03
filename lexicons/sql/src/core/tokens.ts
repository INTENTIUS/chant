/**
 * A lossless tokenizer over a tagged template's parts (chant #3196).
 *
 * The template is never joined into one string with placeholders. Each literal
 * part is tokenized on its own and an interpolation is a `ref` token between
 * two parts, so a token's offset is an offset into the part the author wrote:
 * what a lint rule and the editor point at.
 *
 * Lossless: concatenating every token's `text`, with each `ref` written back as
 * `${...}`, gives the raw template text back byte for byte. Whitespace and
 * comments are tokens (`ws`, `comment`), not discarded.
 *
 * Shared by every dialect. What differs at the character level (which quotes
 * make an identifier, whether a backslash escapes, the punctuation and
 * operator characters) is a dialect's {@link LexicalRules}; ClickHouse's are
 * `../clickhouse/tokens.ts`. The parser #3278 measured needs more rules than
 * ClickHouse does (dollar quotes, `E'...'` strings, nested comments); they
 * arrive with that dialect.
 */

export type TokenKind =
  | "ws"
  | "comment"
  /** A bare identifier or keyword. */
  | "ident"
  /** A `backquoted` or "double-quoted" identifier. */
  | "qident"
  | "string"
  | "number"
  /** `( ) , ; . =` */
  | "punct"
  /** Any other run of operator characters. */
  | "op"
  /** An interpolation. */
  | "ref";

export interface Token {
  kind: TokenKind;
  text: string;
  /** The template part the token sits in. For a `ref`, the index of the interpolated value. */
  part: number;
  /** Offsets into that part. A `ref` has start = end = 0. */
  start: number;
  end: number;
  /**
   * Set on a token that came from a string the author interpolated, which is
   * spliced into the statement as SQL text: the index of that interpolation.
   * Its offsets are into the spliced string.
   */
  splice?: number;
}

/** A syntax error, located in the template: the part and the offset in it. */
export class SqlSyntaxError extends Error {
  constructor(
    message: string,
    readonly part: number,
    readonly offset: number,
    /** The token the error is at, when there is one. A spliced token's position is the interpolation's. */
    readonly token?: Token,
  ) {
    super(message);
    this.name = "SqlSyntaxError";
  }
}

/** What a dialect's tokenizer differs in, at the character level. */
export interface LexicalRules {
  /** The characters that open a quoted identifier, each closed by itself. */
  identQuotes: string;
  /** Whether a backslash escapes the next character inside any quote. */
  backslashEscapes: boolean;
  /** The single-character punctuation tokens. */
  punct: string;
  /** The characters an operator run is made of. */
  opChars: RegExp;
}

/** Tokenize one string. `part` is the part index recorded on each token and on an error. */
export function tokenizeText(src: string, part: number, rules: LexicalRules): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number) =>
    tokens.push({ kind, text: src.slice(start, end), part, start, end });
  while (i < src.length) {
    const c = src[i]!;
    const start = i;
    if (/\s/.test(c)) {
      while (i < src.length && /\s/.test(src[i]!)) i++;
      push("ws", start, i);
    } else if (c === "-" && src[i + 1] === "-") {
      while (i < src.length && src[i] !== "\n") i++;
      push("comment", start, i);
    } else if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close < 0) throw new SqlSyntaxError("unterminated /* comment", part, start);
      i = close + 2;
      push("comment", start, i);
    } else if (c === "'" || rules.identQuotes.includes(c)) {
      i++;
      for (;;) {
        if (i >= src.length) throw new SqlSyntaxError(`unterminated ${c} quote`, part, start);
        if (rules.backslashEscapes && src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === c) {
          // A doubled quote is an escaped quote.
          if (src[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push(c === "'" ? "string" : "qident", start, i);
    } else if (/[0-9]/.test(c)) {
      // `1.5`, `1e3`, `0x1F`; and a name that starts with a digit (`00662_events`), which the parser accepts as a name.
      while (i < src.length && /[0-9a-zA-Z_.]/.test(src[i]!)) {
        if (src[i] === "." && !/[0-9]/.test(src[i + 1] ?? "")) break;
        i++;
      }
      push("number", start, i);
    } else if (/[A-Za-z_$]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i]!)) i++;
      push("ident", start, i);
    } else if (rules.punct.includes(c)) {
      i++;
      push("punct", start, i);
    } else {
      while (i < src.length && rules.opChars.test(src[i]!) && !(src[i] === "-" && src[i + 1] === "-")) i++;
      if (i === start) i++;
      push("op", start, i);
    }
  }
  return tokens;
}

/** Tokenize a template's parts, with a `ref` token for each interpolation between them. */
export function tokenize(parts: readonly string[], rules: LexicalRules): Token[] {
  const tokens: Token[] = [];
  parts.forEach((src, part) => {
    tokens.push(...tokenizeText(src, part, rules));
    if (part < parts.length - 1) tokens.push({ kind: "ref", text: "", part, start: 0, end: 0 });
  });
  return tokens;
}

export const isTrivia = (t: Token): boolean => t.kind === "ws" || t.kind === "comment";

/** Every token's text back in order, each `ref` written by `ref`. */
export function untokenize(tokens: readonly Token[], ref: (index: number) => string): string {
  return tokens.map((t) => (t.kind === "ref" ? ref(t.part) : t.text)).join("");
}
