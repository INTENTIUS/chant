/**
 * The dialect-neutral half of a hand-written CREATE parser (chant #3196,
 * #3278): a cursor over a statement's significant tokens, keyword and
 * punctuation tests, spans, and expressions kept as balanced token spans.
 *
 * Statement structure is a dialect's to parse; expressions are not parsed. An
 * expression (a default, a key, a view's SELECT) is a span of tokens: its
 * source text, verbatim, and the interpolations inside it. A dialect parser
 * extends {@link SqlCursor} with its statements, and says where an expression
 * stops ({@link SqlCursor.stopsAt}) and how a token nests
 * ({@link SqlCursor.depthChange}).
 */

import { isTrivia, SqlSyntaxError, type Token } from "./tokens";

/** A run of tokens [from, to) in the token list, trivia included. */
export interface Span {
  from: number;
  to: number;
  /** Value indexes of the interpolations inside the span. */
  refs: number[];
}

/** Whether `t` is a bare word, any of `words`, case-insensitively. */
export const kw = (t: Token | undefined, ...words: string[]): boolean =>
  t !== undefined && t.kind === "ident" && words.includes(t.text.toUpperCase());

/** `name` with its identifier quotes taken off and doubled quotes undone; `quotes` are the dialect's identifier quotes. */
export const unquoteWith = (text: string, quotes: string): string => {
  if (text.length < 2 || !quotes.includes(text[0]!) || !quotes.includes(text[text.length - 1]!)) return text;
  let inner = text.slice(1, -1);
  for (const q of quotes) inner = inner.split(q + q).join(q);
  return inner;
};

export class SqlCursor {
  /** Indexes of the significant (non-trivia) tokens. */
  protected readonly sig: number[];
  protected p = 0;

  constructor(protected readonly tokens: Token[]) {
    this.sig = tokens.map((t, i) => (isTrivia(t) ? -1 : i)).filter((i) => i >= 0);
  }

  protected peek(n = 0): Token | undefined {
    const idx = this.sig[this.p + n];
    return idx === undefined ? undefined : this.tokens[idx];
  }

  /** Token-list index of the significant token `n` ahead. */
  protected idx(n = 0): number {
    return this.sig[this.p + n] ?? this.tokens.length;
  }

  protected next(): Token {
    const t = this.peek();
    if (!t) this.fail("unexpected end of statement");
    this.p++;
    return t;
  }

  fail(message: string, t: Token | undefined = this.peek()): never {
    const at = t ?? this.lastToken();
    const shown = t ? ` at '${t.kind === "ref" ? "${...}" : t.text}'` : "";
    throw new SqlSyntaxError(`${message}${shown}`, at?.part ?? 0, t ? at!.start : (at?.end ?? 0), at);
  }

  protected lastToken(): Token | undefined {
    const last = this.sig[this.sig.length - 1];
    return last === undefined ? undefined : this.tokens[last];
  }

  protected accept(...words: string[]): boolean {
    if (kw(this.peek(), ...words)) {
      this.p++;
      return true;
    }
    return false;
  }

  protected expect(...words: string[]): void {
    if (!this.accept(...words)) this.fail(`expected ${words.join(" or ")}`);
  }

  /** Whether the next significant tokens are the bare words `words`, in order. */
  protected is(...words: string[]): boolean {
    return words.every((w, n) => kw(this.peek(n), w));
  }

  /** Accept a sequence of bare words, all of them or none. */
  protected acceptSeq(...words: string[]): boolean {
    if (!this.is(...words)) return false;
    this.p += words.length;
    return true;
  }

  protected isPunct(c: string, n = 0): boolean {
    const t = this.peek(n);
    return t !== undefined && t.kind === "punct" && t.text === c;
  }

  protected acceptPunct(c: string): boolean {
    if (this.isPunct(c)) {
      this.p++;
      return true;
    }
    return false;
  }

  protected expectPunct(c: string): void {
    if (!this.acceptPunct(c)) this.fail(`expected '${c}'`);
  }

  protected atEnd(): boolean {
    return this.peek() === undefined || this.isPunct(";");
  }

  protected span(from: number, refs: number[]): Span {
    return { from, to: this.idx(-1) + 1, refs };
  }

  /**
   * Whether the expression being read stops at the current token, a top-level
   * bare word: by default when it is one of `stop`. A dialect overrides this
   * for its multi-word stops (ClickHouse stops at `ORDER` only before `BY`).
   */
  protected stopsAt(stop: readonly string[]): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === "ident" && stop.includes(t.text.toUpperCase());
  }

  /** How `t` changes the nesting depth of an expression: `(` opens and `)` closes. */
  protected depthChange(t: Token): number {
    if (t.kind === "punct" && t.text === "(") return 1;
    if (t.kind === "punct" && t.text === ")") return -1;
    return 0;
  }

  /**
   * An expression as a token span: everything up to a top-level `,` (unless
   * `stopAtComma` is false), `)` or `;`, or a top-level stop word. Nesting is
   * balanced, not parsed.
   */
  protected expr(stop: readonly string[] = [], stopAtComma = true): Span {
    const from = this.idx();
    const refs: number[] = [];
    let depth = 0;
    const startP = this.p;
    for (;;) {
      const t = this.peek();
      if (t === undefined) break;
      if (depth === 0) {
        if (t.kind === "punct" && (t.text === ")" || t.text === ";" || (stopAtComma && t.text === ","))) break;
        if (this.stopsAt(stop)) break;
      }
      depth += this.depthChange(t);
      if (t.kind === "ref") refs.push(t.part);
      this.p++;
    }
    if (this.p === startP) this.fail("expected an expression");
    return this.span(from, refs);
  }

  /** `( ... )` balanced: the span between the parentheses. */
  protected parenthesized(): Span {
    this.expectPunct("(");
    if (this.isPunct(")")) {
      const at = this.idx();
      this.p++;
      return { from: at, to: at, refs: [] };
    }
    const inner = this.exprList();
    this.expectPunct(")");
    return inner;
  }

  /** A comma-separated expression list as one span. */
  protected exprList(stop: readonly string[] = []): Span {
    const first = this.expr(stop);
    let last = first;
    const refs = [...first.refs];
    while (this.isPunct(",")) {
      this.p++;
      last = this.expr(stop);
      refs.push(...last.refs);
    }
    return { from: first.from, to: last.to, refs };
  }
}
