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

/**
 * A clause the parser does not know, kept as written (#3872): a server
 * release can add a clause before chant's parser reads it, and the statement
 * still goes to the server as the author wrote it. What chant reads around it
 * is read; the clause itself is opaque.
 */
export interface UnknownClause {
  /** Its leading words, upper case, as a message names it: `TABLESPACE_POLICY`. */
  clause: string;
  /** The whole clause, from its first word to where a clause the parser knows starts. */
  span: Span;
  /** The column (or dictionary attribute) the clause is written on, when it is one of a column's. */
  column?: string;
}

/** Edit distance with a swap of two neighbours as one edit, for telling a misspelt clause from a new one. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i]!;
      row[j] = Math.min(d[i - 1]![j]! + 1, row[j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The known clause word `word` is a misspelling of, if any: one edit from a
 * known word of four letters or more (two neighbouring letters swapped is
 * one), two from one of seven or more. A word
 * that close is taken as a typo, which fails, not as a new clause, which warns.
 */
export function misspelling(word: string, known: readonly string[]): string | undefined {
  const w = word.toUpperCase();
  for (const k of known) {
    if (k.length < 4 || k === w) continue;
    const d = distance(w, k);
    if (d === 1 || (d === 2 && k.length >= 7 && w.length >= 7)) return k;
  }
  return undefined;
}

export class SqlCursor {
  /** Indexes of the significant (non-trivia) tokens. */
  protected readonly sig: number[];
  protected p = 0;
  /** The clauses read so far that the parser does not know (#3872), in order. */
  protected readonly unknownClauses: UnknownClause[] = [];

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

  /**
   * At a clause boundary, a clause this parser does not know (#3872): a bare
   * word that is not one of `known`, read up to the next top-level word of
   * `known`, the statement's end, or (with `inList`, inside a column list) the
   * element's `,` or `)`, its parentheses balanced. Recorded and returned.
   *
   * Undefined when the next token cannot start one: the end, punctuation, a
   * string, a number, a quoted name or an interpolation, a word shorter than
   * three letters or with a digit in it, or a word of `known`
   * (a clause the parser knows, out of place). A word one letter from a known
   * one fails here as a misspelling, and a run holding a top-level `SELECT`,
   * `CREATE` or `INSERT` as a query or a second statement: genuinely
   * malformed SQL stays an error.
   */
  protected unknownClause(known: readonly string[], options: { inList?: boolean; column?: string } = {}): UnknownClause | undefined {
    const t = this.peek();
    // A clause starts with a key word: three letters or more, no digits.
    if (t === undefined || t.kind !== "ident" || !/^[A-Za-z_]{3,}$/.test(t.text)) return undefined;
    const word = t.text.toUpperCase();
    if (known.includes(word)) return undefined;
    const near = misspelling(word, known);
    if (near !== undefined) this.fail(`expected a clause ('${t.text}' is not one chant reads, and is one letter from ${near}: is it misspelt?)`, t);
    const from = this.idx();
    const startP = this.p;
    // Its name: the first word, and when that is written in upper case, the upper-case words after it (`SQL SECURITY`), not a name it takes.
    const words = [word];
    const upper = (u: Token | undefined) => u?.kind === "ident" && /^[A-Z_]+$/.test(u.text) && !known.includes(u.text);
    if (upper(t)) for (let n = 1; n < 3 && upper(this.peek(n)); n++) words.push(this.peek(n)!.text);
    const refs: number[] = [];
    let depth = 0;
    for (;;) {
      const u = this.peek();
      if (u === undefined) break;
      if (depth === 0) {
        if (u.kind === "punct" && (u.text === ";" || u.text === ")" || (options.inList === true && u.text === ","))) break;
        if (this.p > startP && u.kind === "ident" && known.includes(u.text.toUpperCase())) break;
        // A query or a second statement is not a clause: `CREATE TABLE ... AS SELECT`, `... PARALLEL WITH CREATE ...`.
        if (kw(u, "SELECT", "CREATE", "INSERT")) this.fail(`expected a clause (${u.text.toUpperCase()} starts a query or a statement, which is not declared here)`, u);
      }
      depth += this.depthChange(u);
      if (depth < 0) break;
      if (u.kind === "ref") refs.push(u.part);
      this.p++;
    }
    if (depth !== 0) this.fail(`unbalanced parentheses in the ${words.join(" ")} clause`, t);
    const clause: UnknownClause = { clause: words.join(" "), span: this.span(from, refs), ...(options.column !== undefined ? { column: options.column } : {}) };
    this.unknownClauses.push(clause);
    return clause;
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
