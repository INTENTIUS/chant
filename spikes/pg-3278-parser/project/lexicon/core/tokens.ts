/**
 * Spike (#3278): the ClickHouse tokenizer (lexicons/sql/src/clickhouse/tokens.ts)
 * with its lexical rules lifted into a per-dialect table, as the shared core
 * would hold it. The Token shape, SqlSyntaxError, tokenize(), untokenize() and
 * isTrivia() are unchanged from ClickHouse; only tokenizeText() reads the
 * dialect. `check-shared-core.ts` runs ClickHouse's corpus fixture through
 * this file with CLICKHOUSE_LEXICAL and compares every token with the shipped
 * tokenizer's.
 *
 * Lossless, as before: every token's text, with each `ref` written back as
 * `${...}`, gives the template's raw text back byte for byte.
 */

export type TokenKind = "ws" | "comment" | "ident" | "qident" | "string" | "number" | "punct" | "op" | "ref" | "param";

export interface Token {
  kind: TokenKind;
  text: string;
  part: number;
  start: number;
  end: number;
  splice?: number;
}

export class SqlSyntaxError extends Error {
  constructor(
    message: string,
    readonly part: number,
    readonly offset: number,
    readonly token?: Token,
  ) {
    super(message);
    this.name = "SqlSyntaxError";
  }
}

/** What differs between dialects at the character level. */
export interface LexicalRules {
  /** Characters that open a quoted identifier. ClickHouse: ` and "; Postgres: ". */
  identQuotes: string;
  /**
   * Whether a backslash escapes the next character inside quotes. ClickHouse:
   * always. Postgres: only in an `E'...'` string (standard_conforming_strings is
   * on by default since 9.1), never in a plain `'...'` or a quoted identifier.
   */
  backslash: "always" | "e-strings";
  /** `$tag$ ... $tag$` strings (Postgres). */
  dollarQuotes: boolean;
  /** `/* /* nested *\/ *\/` block comments (Postgres). */
  nestedComments: boolean;
  /** Single-character punctuation tokens. */
  punct: string;
  /** Characters an operator run is made of. */
  opChars: RegExp;
  /** A number token may run into letters (`00662_events`, a ClickHouse name). */
  digitNames: boolean;
  /** An operator run ends before `/*` as well as `--` (Postgres). */
  opStopsAtBlockComment: boolean;
}

export const CLICKHOUSE_LEXICAL: LexicalRules = {
  identQuotes: '`"',
  backslash: "always",
  dollarQuotes: false,
  nestedComments: false,
  punct: "(),;.=",
  opChars: /[+\-*/%<>!|&^~?:[\]{}@]/,
  digitNames: true,
  opStopsAtBlockComment: false,
};

export const POSTGRES_LEXICAL: LexicalRules = {
  identQuotes: '"',
  backslash: "e-strings",
  dollarQuotes: true,
  nestedComments: true,
  punct: "(),;.[]",
  // Postgres operator characters (sql-syntax-lexical, "Operators"), plus `:` for `::` casts.
  opChars: /[+\-*/<>=~!@#%^&|`?:]/,
  digitNames: false,
  opStopsAtBlockComment: true,
};

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;

export function tokenizeText(src: string, part: number, rules: LexicalRules): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number) => tokens.push({ kind, text: src.slice(start, end), part, start, end });

  /** Scan a quoted run starting at `i` (on the opening quote). Returns the index after the closing quote. */
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
      let depth = 1;
      i += 2;
      while (depth > 0) {
        if (i >= src.length) throw new SqlSyntaxError("unterminated /* comment", part, start);
        if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else if (rules.nestedComments && src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else i++;
      }
      push("comment", start, i);
    } else if (
      rules.backslash === "e-strings" &&
      /[EeBbXxNn]/.test(c) &&
      src[i + 1] === "'" &&
      !(start > 0 && IDENT_PART.test(src[start - 1]!))
    ) {
      // E'..' (backslash escapes), B'..' X'..' bit strings, N'..' national: one string token, prefix included.
      i = quoted(i + 1, "'", c === "E" || c === "e");
      push("string", start, i);
    } else if (rules.backslash === "e-strings" && /[Uu]/.test(c) && src[i + 1] === "&" && (src[i + 2] === "'" || src[i + 2] === '"')) {
      // U&'...' and U&"...": Unicode escapes with a backslash (or UESCAPE) that a doubled quote still ends.
      const q = src[i + 2]!;
      i = quoted(i + 2, q, false);
      push(q === "'" ? "string" : "qident", start, i);
    } else if (c === "'" || rules.identQuotes.includes(c)) {
      i = quoted(i, c, rules.backslash === "always");
      push(c === "'" ? "string" : "qident", start, i);
    } else if (rules.dollarQuotes && c === "$" && /[0-9]/.test(src[i + 1] ?? "")) {
      // $1: a positional parameter.
      i++;
      while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      push("param", start, i);
    } else if (rules.dollarQuotes && c === "$") {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(src.slice(i));
      if (!m) {
        i++;
        push("op", start, i);
        continue;
      }
      const close = src.indexOf(m[0], i + m[0].length);
      if (close < 0) throw new SqlSyntaxError(`unterminated ${m[0]} string`, part, start);
      i = close + m[0].length;
      push("string", start, i);
    } else if (/[0-9]/.test(c) || (!rules.digitNames && c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      if (rules.digitNames) {
        while (i < src.length && /[0-9a-zA-Z_.]/.test(src[i]!)) {
          if (src[i] === "." && !/[0-9]/.test(src[i + 1] ?? "")) break;
          i++;
        }
      } else {
        // 42, 3.5, .5, 1e-3, 0x1F, 0o17, 0b101, 1_000_000 (Postgres 16+).
        if (/0[xXoObB]/.test(src.slice(i, i + 2))) {
          i += 2;
          while (i < src.length && /[0-9A-Fa-f_]/.test(src[i]!)) i++;
        } else {
          while (i < src.length && /[0-9_]/.test(src[i]!)) i++;
          if (src[i] === "." && src[i + 1] !== ".") {
            i++;
            while (i < src.length && /[0-9_]/.test(src[i]!)) i++;
          }
          if (/[eE]/.test(src[i] ?? "") && /[0-9]|[+-][0-9]/.test(src.slice(i + 1, i + 3))) {
            i += 2;
            while (i < src.length && /[0-9]/.test(src[i]!)) i++;
          }
        }
      }
      push("number", start, i);
    } else if (rules.digitNames ? /[A-Za-z_$]/.test(c) : IDENT_START.test(c)) {
      const part_ = rules.digitNames ? /[A-Za-z0-9_$]/ : IDENT_PART;
      while (i < src.length && part_.test(src[i]!)) i++;
      push("ident", start, i);
    } else if (rules.punct.includes(c)) {
      i++;
      push("punct", start, i);
    } else {
      while (
        i < src.length &&
        rules.opChars.test(src[i]!) &&
        !(src[i] === "-" && src[i + 1] === "-") &&
        !(rules.opStopsAtBlockComment && src[i] === "/" && src[i + 1] === "*")
      )
        i++;
      if (i === start) i++;
      push("op", start, i);
    }
  }
  return tokens;
}

export function tokenize(parts: readonly string[], rules: LexicalRules): Token[] {
  const tokens: Token[] = [];
  parts.forEach((src, part) => {
    tokens.push(...tokenizeText(src, part, rules));
    if (part < parts.length - 1) tokens.push({ kind: "ref", text: "", part, start: 0, end: 0 });
  });
  return tokens;
}

export const isTrivia = (t: Token): boolean => t.kind === "ws" || t.kind === "comment";

export function untokenize(tokens: readonly Token[], ref: (index: number) => string): string {
  return tokens.map((t) => (t.kind === "ref" ? ref(t.part) : t.text)).join("");
}
