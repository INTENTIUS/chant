/**
 * Spike (#3278): the dialect-neutral half of ClickHouse's `Parser` class
 * (lexicons/sql/src/clickhouse/parser.ts): the cursor over significant tokens,
 * keyword and punctuation tests, spans, names, and expressions kept as balanced
 * token spans. A dialect parser extends it with its statements.
 *
 * The one generalization: ClickHouse's `expr()` hard-codes which stop words
 * are two-word (`ORDER BY`, `PRIMARY KEY`). Here a stop is a word sequence, so
 * Postgres can stop at `WITH CHECK OPTION` or `WITH NO DATA` without stopping
 * at a CTE's `WITH`.
 */

import { isTrivia, SqlSyntaxError, type Token } from "./tokens";

export interface Span {
  from: number;
  to: number;
  refs: number[];
}

/** A stop: one keyword, or a sequence that must all follow (`["WITH", "CHECK"]`). An inner array is alternatives. */
export type Stop = string | Array<string | string[]>;

export const kw = (t: Token | undefined, ...words: string[]): boolean =>
  t !== undefined && t.kind === "ident" && words.includes(t.text.toUpperCase());

export class Cursor {
  protected readonly sig: number[];
  protected p = 0;

  constructor(protected readonly tokens: Token[]) {
    this.sig = tokens.map((t, i) => (isTrivia(t) ? -1 : i)).filter((i) => i >= 0);
  }

  protected peek(n = 0): Token | undefined {
    const idx = this.sig[this.p + n];
    return idx === undefined ? undefined : this.tokens[idx];
  }

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
    const last = this.sig[this.sig.length - 1];
    const at = t ?? (last === undefined ? undefined : this.tokens[last]);
    const shown = t ? ` at '${t.kind === "ref" ? "${...}" : t.text}'` : "";
    throw new SqlSyntaxError(`${message}${shown}`, at?.part ?? 0, t ? at!.start : (at?.end ?? 0), at);
  }

  protected is(...words: string[]): boolean {
    return words.every((w, n) => kw(this.peek(n), w));
  }

  protected accept(...words: string[]): boolean {
    if (kw(this.peek(), ...words)) {
      this.p++;
      return true;
    }
    return false;
  }

  /** Accept a keyword sequence, all or nothing. */
  protected acceptSeq(...words: string[]): boolean {
    if (!this.is(...words)) return false;
    this.p += words.length;
    return true;
  }

  protected expect(...words: string[]): void {
    if (!this.accept(...words)) this.fail(`expected ${words.join(" or ")}`);
  }

  protected isPunct(c: string, n = 0): boolean {
    const t = this.peek(n);
    return t !== undefined && (t.kind === "punct" || t.kind === "op") && t.text === c;
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

  protected stopsHere(stops: readonly Stop[]): boolean {
    return stops.some((s) => {
      const seq = typeof s === "string" ? [s] : s;
      return seq.every((w, n) => (Array.isArray(w) ? kw(this.peek(n), ...w) : kw(this.peek(n), w)));
    });
  }

  /**
   * An expression as a token span: up to a top-level `,` `)` `;` or a stop.
   * Parentheses and brackets are balanced, not parsed.
   */
  protected expr(stops: readonly Stop[] = [], stopAtComma = true): Span {
    const from = this.idx();
    const refs: number[] = [];
    let depth = 0;
    const startP = this.p;
    for (;;) {
      const t = this.peek();
      if (t === undefined) break;
      if (depth === 0) {
        if (t.kind === "punct" && (t.text === ")" || t.text === "]" || t.text === ";" || (stopAtComma && t.text === ","))) break;
        if (this.p > startP && this.stopsHere(stops)) break;
      }
      if (t.kind === "punct" && (t.text === "(" || t.text === "[")) depth++;
      if (t.kind === "punct" && (t.text === ")" || t.text === "]")) depth--;
      if (t.kind === "ref") refs.push(t.part);
      this.p++;
    }
    if (this.p === startP) this.fail("expected an expression");
    return this.span(from, refs);
  }

  /** `( ... )`, balanced: the span between the parentheses. */
  protected parenthesized(): Span {
    this.expectPunct("(");
    if (this.isPunct(")")) {
      const at = this.idx();
      this.p++;
      return { from: at, to: at, refs: [] };
    }
    const first = this.expr();
    let last = first;
    const refs = [...first.refs];
    while (this.acceptPunct(",")) {
      last = this.expr();
      refs.push(...last.refs);
    }
    this.expectPunct(")");
    return { from: first.from, to: last.to, refs };
  }

  /** A comma-separated list of expression spans inside parentheses. */
  protected parenList(stops: readonly Stop[] = []): Span[] {
    this.expectPunct("(");
    const out: Span[] = [];
    if (this.acceptPunct(")")) return out;
    for (;;) {
      out.push(this.expr(stops));
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      return out;
    }
  }
}
