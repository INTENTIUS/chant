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
 * `../clickhouse/tokens.ts`, Postgres's `../postgres/tokens.ts`. The rules
 * Postgres adds (#3278: dollar quotes, `E'...'` strings, nested comments,
 * `$1` parameters, its number syntax) are optional fields, off unless a
 * dialect sets them, so ClickHouse tokenizes exactly as before.
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
  | "ref"
  /** A positional parameter, `$1` (Postgres). */
  | "param";

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
  /**
   * Prefixed string constants (Postgres): `E'...'`, where a backslash escapes,
   * `B'...'` and `X'...'` bit strings, `N'...'`, and `U&'...'` / `U&"..."`
   * with Unicode escapes. Each is one token, its prefix included.
   */
  prefixedStrings?: boolean;
  /** `$$...$$` and `$tag$...$tag$` strings, and `$1` parameters (Postgres). */
  dollarQuotes?: boolean;
  /** Block comments nest: a comment opened inside a block comment needs its own close (Postgres). */
  nestedComments?: boolean;
  /**
   * How a number reads. `digit-names` (the default): a number may run into
   * letters, so `00662_events` is one token, which the ClickHouse parser
   * accepts as a name. `sql`: `42`, `3.5`, `.5`, `1e-3`, `0x1F`, `0o17`,
   * `0b101` and `1_000_000`, and a number never runs into a name (Postgres).
   */
  numbers?: "digit-names" | "sql";
  /** Identifiers may hold letters outside ASCII, as Postgres's do. */
  unicodeIdentifiers?: boolean;
  /**
   * A multi-character operator cannot end in `+` or `-` unless it also holds
   * one of `~ ! @ # % ^ & | \` ?` (Postgres, "Lexical Structure"), so
   * `=-30` is `=` then `-30`.
   */
  operatorsEndWithoutSign?: boolean;
}

const IDENT_START_ASCII = /[A-Za-z_$]/;
const IDENT_PART_ASCII = /[A-Za-z0-9_$]/;
const IDENT_START_UNICODE = /[A-Za-z_\u0080-\uffff]/;
const IDENT_PART_UNICODE = /[A-Za-z0-9_$\u0080-\uffff]/;

/** Tokenize one string. `part` is the part index recorded on each token and on an error. */
export function tokenizeText(src: string, part: number, rules: LexicalRules): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number) =>
    tokens.push({ kind, text: src.slice(start, end), part, start, end });
  const identStart = rules.unicodeIdentifiers ? IDENT_START_UNICODE : IDENT_START_ASCII;
  const identPart = rules.unicodeIdentifiers ? IDENT_PART_UNICODE : IDENT_PART_ASCII;

  /** The index after the quote that closes the one at `at`. A doubled quote is an escaped quote. */
  const quoted = (at: number, q: string, backslash: boolean): number => {
    let j = at + 1;
    for (;;) {
      if (j >= src.length) throw new SqlSyntaxError(`unterminated ${q} quote`, part, at);
      if (backslash && src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === q) {
        if (src[j + 1] === q) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
  };

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
      if (rules.nestedComments) {
        let depth = 1;
        i += 2;
        while (depth > 0) {
          if (i >= src.length) throw new SqlSyntaxError("unterminated /* comment", part, start);
          if (src[i] === "*" && src[i + 1] === "/") {
            depth--;
            i += 2;
          } else if (src[i] === "/" && src[i + 1] === "*") {
            depth++;
            i += 2;
          } else i++;
        }
      } else {
        const close = src.indexOf("*/", i + 2);
        if (close < 0) throw new SqlSyntaxError("unterminated /* comment", part, start);
        i = close + 2;
      }
      push("comment", start, i);
    } else if (rules.prefixedStrings && /[EeBbXxNn]/.test(c) && src[i + 1] === "'" && !(start > 0 && identPart.test(src[start - 1]!))) {
      i = quoted(i + 1, "'", c === "E" || c === "e");
      push("string", start, i);
    } else if (rules.prefixedStrings && /[Uu]/.test(c) && src[i + 1] === "&" && (src[i + 2] === "'" || src[i + 2] === '"') && !(start > 0 && identPart.test(src[start - 1]!))) {
      const q = src[i + 2]!;
      i = quoted(i + 2, q, false);
      push(q === "'" ? "string" : "qident", start, i);
    } else if (c === "'" || rules.identQuotes.includes(c)) {
      i = quoted(i, c, rules.backslashEscapes);
      push(c === "'" ? "string" : "qident", start, i);
    } else if (rules.dollarQuotes && c === "$" && /[0-9]/.test(src[i + 1] ?? "")) {
      i++;
      while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      push("param", start, i);
    } else if (rules.dollarQuotes && c === "$" && /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.test(src.slice(i))) {
      const delimiter = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(src.slice(i))![0];
      const close = src.indexOf(delimiter, i + delimiter.length);
      if (close < 0) throw new SqlSyntaxError(`unterminated ${delimiter} string`, part, start);
      i = close + delimiter.length;
      push("string", start, i);
    } else if (rules.numbers === "sql" && (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? "")))) {
      if (/^0[xXoObB]/.test(src.slice(i, i + 2))) {
        i += 2;
        while (i < src.length && /[0-9A-Fa-f_]/.test(src[i]!)) i++;
      } else {
        while (i < src.length && /[0-9_]/.test(src[i]!)) i++;
        if (src[i] === "." && src[i + 1] !== ".") {
          i++;
          while (i < src.length && /[0-9_]/.test(src[i]!)) i++;
        }
        if (/[eE]/.test(src[i] ?? "") && /^([0-9]|[+-][0-9])/.test(src.slice(i + 1, i + 3))) {
          i += 2;
          while (i < src.length && /[0-9]/.test(src[i]!)) i++;
        }
      }
      push("number", start, i);
    } else if (rules.numbers !== "sql" && /[0-9]/.test(c)) {
      // `1.5`, `1e3`, `0x1F`; and a name that starts with a digit (`00662_events`), which the parser accepts as a name.
      while (i < src.length && /[0-9a-zA-Z_.]/.test(src[i]!)) {
        if (src[i] === "." && !/[0-9]/.test(src[i + 1] ?? "")) break;
        i++;
      }
      push("number", start, i);
    } else if (identStart.test(c)) {
      while (i < src.length && identPart.test(src[i]!)) i++;
      push("ident", start, i);
    } else if (rules.punct.includes(c)) {
      i++;
      push("punct", start, i);
    } else {
      while (
        i < src.length &&
        rules.opChars.test(src[i]!) &&
        !(src[i] === "-" && src[i + 1] === "-") &&
        !(rules.nestedComments && src[i] === "/" && src[i + 1] === "*")
      )
        i++;
      if (i === start) i++;
      if (rules.operatorsEndWithoutSign && i - start > 1 && !/[~!@#%^&|`?]/.test(src.slice(start, i))) {
        while (i - start > 1 && /[+-]/.test(src[i - 1]!)) i--;
      }
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
