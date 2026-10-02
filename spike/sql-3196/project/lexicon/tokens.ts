/**
 * Spike (#3196): a lossless tokenizer over a tagged template's parts.
 *
 * The template is never joined into one string with placeholders. Each
 * literal part is tokenized on its own and an interpolation becomes a `ref`
 * token between two parts, so a token's offset is an offset into the part the
 * author wrote, which is what an LSP needs to point at.
 *
 * Lossless: concatenating every token's `text` (with each `ref` written back as
 * `${…}`) gives the raw template text back byte for byte. Whitespace and
 * comments are tokens (`ws`, `comment`), not discarded.
 */

export type TokenKind =
  | "ws"
  | "comment"
  | "ident" // bare identifier or keyword
  | "qident" // `quoted` or "quoted" identifier
  | "string"
  | "number"
  | "punct" // ( ) , ; . =
  | "op" // any other operator character run
  | "ref"; // an interpolation

export interface Token {
  kind: TokenKind;
  text: string;
  /** Index of the template part the token sits in. For a `ref`, the index of the value. */
  part: number;
  /** Offsets into that part. A `ref` has start = end = 0. */
  start: number;
  end: number;
}

export class SqlSyntaxError extends Error {
  constructor(
    message: string,
    readonly part: number,
    readonly offset: number,
  ) {
    super(message);
  }
}

const PUNCT = new Set(["(", ")", ",", ";", ".", "="]);

export function tokenize(parts: readonly string[]): Token[] {
  const tokens: Token[] = [];
  parts.forEach((src, part) => {
    let i = 0;
    const push = (kind: TokenKind, start: number, end: number) =>
      tokens.push({ kind, text: src.slice(start, end), part, start, end });
    while (i < src.length) {
      const c = src[i];
      const start = i;
      if (/\s/.test(c)) {
        while (i < src.length && /\s/.test(src[i])) i++;
        push("ws", start, i);
      } else if (c === "-" && src[i + 1] === "-") {
        while (i < src.length && src[i] !== "\n") i++;
        push("comment", start, i);
      } else if (c === "#" && (src[i + 1] === " " || src[i + 1] === "!")) {
        while (i < src.length && src[i] !== "\n") i++;
        push("comment", start, i);
      } else if (c === "/" && src[i + 1] === "*") {
        const close = src.indexOf("*/", i + 2);
        if (close < 0) throw new SqlSyntaxError("unterminated /* comment", part, start);
        i = close + 2;
        push("comment", start, i);
      } else if (c === "'" || c === "`" || c === '"') {
        i++;
        for (;;) {
          if (i >= src.length) throw new SqlSyntaxError(`unterminated ${c} quote`, part, start);
          if (src[i] === "\\") {
            i += 2;
            continue;
          }
          if (src[i] === c) {
            // a doubled quote is an escaped quote
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
        while (i < src.length && /[0-9a-zA-Z_.]/.test(src[i])) i++;
        push("number", start, i);
      } else if (/[A-Za-z_$]/.test(c)) {
        while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
        push("ident", start, i);
      } else if (PUNCT.has(c)) {
        i++;
        push("punct", start, i);
      } else {
        while (i < src.length && /[+\-*/%<>!|&^~?:[\]{}@]/.test(src[i]) && !(src[i] === "-" && src[i + 1] === "-")) i++;
        if (i === start) i++;
        push("op", start, i);
      }
    }
    if (part < parts.length - 1) tokens.push({ kind: "ref", text: "", part, start: 0, end: 0 });
  });
  // a ref token's `part` is the index of the interpolated value
  let refIndex = 0;
  for (const t of tokens) if (t.kind === "ref") t.part = refIndex++;
  return tokens;
}

export const isTrivia = (t: Token) => t.kind === "ws" || t.kind === "comment";

/** Source round trip: every token's text back in order, refs as `${n}`. */
export function untokenize(tokens: readonly Token[], ref: (index: number) => string): string {
  return tokens.map((t) => (t.kind === "ref" ? ref(t.part) : t.text)).join("");
}
