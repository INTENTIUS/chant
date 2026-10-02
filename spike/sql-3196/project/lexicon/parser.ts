/**
 * Spike (#3196): a hand-written recursive-descent parser for the ClickHouse
 * CREATE TABLE / CREATE VIEW / CREATE MATERIALIZED VIEW subset.
 *
 * Statement structure is parsed; expressions are not. An expression (a
 * default, a codec, a sort key, a TTL, a view's SELECT) is kept as a span of
 * tokens: its source text, verbatim, plus the interpolations inside it. That
 * is enough for entities, references, dependency order and lineage. It is not
 * enough to normalize `INTERVAL 1 DAY` against the server's `toIntervalDay(1)`;
 * see the issue comment for where that has to come from.
 */

import { isTrivia, SqlSyntaxError, type Token } from "./tokens";

/** A run of tokens [from, to) in the full token list, trivia included. */
export interface Span {
  from: number;
  to: number;
  /** Value indexes of the interpolations inside the span. */
  refs: number[];
}

export interface ColumnNode {
  name: string;
  nameSpan: Span;
  type?: Span;
  nullable?: boolean;
  default?: { kind: "DEFAULT" | "MATERIALIZED" | "ALIAS" | "EPHEMERAL"; expr?: Span };
  comment?: Span;
  codec?: Span;
  ttl?: Span;
  statistics?: Span;
  settings?: Span;
}

export interface IndexNode { name: string; expr: Span; type: Span; granularity?: Span }
export interface ProjectionNode { name: string; body: Span }
export interface ConstraintNode { name: string; kind: "CHECK" | "ASSUME"; expr: Span }

export interface StorageNode {
  engine?: { name: string; args?: Span[]; span: Span };
  orderBy?: Span;
  primaryKey?: Span;
  partitionBy?: Span;
  sampleBy?: Span;
  ttl?: Span;
  settings?: Array<{ key: string; value: Span }>;
}

export interface TableNode extends StorageNode {
  statement: "table";
  orReplace: boolean;
  ifNotExists: boolean;
  name: Span;
  onCluster?: Span;
  columns: ColumnNode[];
  indexes: IndexNode[];
  projections: ProjectionNode[];
  constraints: ConstraintNode[];
  comment?: Span;
}

export interface ViewNode extends StorageNode {
  statement: "view";
  materialized: boolean;
  orReplace: boolean;
  ifNotExists: boolean;
  name: Span;
  onCluster?: Span;
  refresh?: Span;
  to?: Span;
  columns: ColumnNode[];
  populate: boolean;
  select: Span;
  comment?: Span;
}

export type CreateNode = TableNode | ViewNode;

const kw = (t: Token | undefined, ...words: string[]) =>
  t !== undefined && t.kind === "ident" && words.includes(t.text.toUpperCase());

class Parser {
  /** Indexes of significant (non-trivia) tokens into `tokens`. */
  private sig: number[];
  private p = 0;

  constructor(private tokens: Token[]) {
    this.sig = tokens.map((t, i) => (isTrivia(t) ? -1 : i)).filter((i) => i >= 0);
  }

  private peek(n = 0): Token | undefined {
    const idx = this.sig[this.p + n];
    return idx === undefined ? undefined : this.tokens[idx];
  }
  private idx(n = 0): number {
    return this.sig[this.p + n] ?? this.tokens.length;
  }
  private next(): Token {
    const t = this.peek();
    if (!t) this.fail("unexpected end of statement");
    this.p++;
    return t!;
  }
  private fail(message: string, t = this.peek()): never {
    const at = t ?? this.tokens[this.tokens.length - 1];
    throw new SqlSyntaxError(`${message}${t ? ` at '${t.kind === "ref" ? "${…}" : t.text}'` : ""}`, at?.part ?? 0, at?.start ?? 0);
  }
  private accept(...words: string[]): boolean {
    if (kw(this.peek(), ...words)) {
      this.p++;
      return true;
    }
    return false;
  }
  private expect(...words: string[]): void {
    if (!this.accept(...words)) this.fail(`expected ${words.join(" or ")}`);
  }
  private acceptPunct(c: string): boolean {
    const t = this.peek();
    if (t && t.kind === "punct" && t.text === c) {
      this.p++;
      return true;
    }
    return false;
  }
  private expectPunct(c: string): void {
    if (!this.acceptPunct(c)) this.fail(`expected '${c}'`);
  }
  private atEnd(): boolean {
    const t = this.peek();
    return t === undefined || (t.kind === "punct" && t.text === ";");
  }

  /** One name: an identifier, a quoted identifier, an interpolation, optionally `db.`-qualified. */
  private qualifiedName(): Span {
    const from = this.idx();
    const refs: number[] = [];
    const one = () => {
      const t = this.next();
      if (t.kind === "ref") refs.push(t.part);
      else if (t.kind !== "ident" && t.kind !== "qident") this.fail("expected a name", t);
    };
    one();
    while (this.peek()?.kind === "punct" && this.peek()!.text === "." ) {
      this.p++;
      one();
    }
    return { from, to: this.idx(-1) + 1, refs };
  }

  /**
   * An expression as a token span: everything up to a top-level `,` or `)`,
   * or a top-level keyword in `stop`. Parentheses are only balanced, not parsed.
   */
  private expr(stop: readonly string[] = [], stopAtComma = true): Span {
    const from = this.idx();
    const refs: number[] = [];
    let depth = 0;
    const startP = this.p;
    for (;;) {
      const t = this.peek();
      if (t === undefined) break;
      if (depth === 0) {
        if (t.kind === "punct" && (t.text === ")" || t.text === ";" || (stopAtComma && t.text === ","))) break;
        if (t.kind === "ident" && stop.includes(t.text.toUpperCase())) {
          // `ORDER BY`, `PRIMARY KEY`, … are two-word stops
          const two = t.text.toUpperCase();
          const nx = this.peek(1);
          if ((two === "ORDER" || two === "PARTITION" || two === "SAMPLE" || two === "GROUP") && !kw(nx, "BY")) {
            // not the clause keyword; part of the expression
          } else if (two === "PRIMARY" && !kw(nx, "KEY")) {
            // likewise
          } else break;
        }
      }
      if (t.kind === "punct" && t.text === "(") depth++;
      if (t.kind === "punct" && t.text === ")") depth--;
      if (t.kind === "ref") refs.push(t.part);
      this.p++;
    }
    if (this.p === startP) this.fail("expected an expression");
    return { from, to: this.idx(-1) + 1, refs };
  }

  /** `( … )` balanced, returned as the span between the parentheses, exclusive. */
  private parenthesized(): Span {
    this.expectPunct("(");
    const inner = this.peek()?.kind === "punct" && this.peek()!.text === ")" ? undefined : this.exprList();
    const close = this.idx();
    this.expectPunct(")");
    return inner ?? { from: close, to: close, refs: [] };
  }

  /** A comma-separated expression list as one span. */
  private exprList(stop: readonly string[] = []): Span {
    const first = this.expr(stop);
    let last = first;
    const refs = [...first.refs];
    while (this.peek()?.kind === "punct" && this.peek()!.text === ",") {
      this.p++;
      last = this.expr(stop);
      refs.push(...last.refs);
    }
    return { from: first.from, to: last.to, refs };
  }

  private typeSpan(): Span {
    // `Nullable(String)`, `DateTime64(3, 'UTC')`, `Tuple(a UInt8, b String)`
    const from = this.idx();
    const t = this.next();
    if (t.kind !== "ident") this.fail("expected a type", t);
    if (this.peek()?.kind === "punct" && this.peek()!.text === "(") this.parenthesized();
    return { from, to: this.idx(-1) + 1, refs: [] };
  }

  private column(): ColumnNode {
    const nameTok = this.next();
    if (nameTok.kind !== "ident" && nameTok.kind !== "qident") this.fail("expected a column name", nameTok);
    const nameIdx = this.idx(-1);
    const col: ColumnNode = {
      name: nameTok.kind === "qident" ? nameTok.text.slice(1, -1) : nameTok.text,
      nameSpan: { from: nameIdx, to: nameIdx + 1, refs: [] },
    };
    if (!kw(this.peek(), "DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL")) col.type = this.typeSpan();
    const STOP = ["COMMENT", "CODEC", "TTL", "STATISTICS", "SETTINGS", "PRIMARY"];
    for (;;) {
      if (this.accept("NULL")) col.nullable = true;
      else if (kw(this.peek(), "NOT") && kw(this.peek(1), "NULL")) {
        this.p += 2;
        col.nullable = false;
      } else if (kw(this.peek(), "DEFAULT", "MATERIALIZED", "ALIAS")) {
        const kind = this.next().text.toUpperCase() as "DEFAULT" | "MATERIALIZED" | "ALIAS";
        col.default = { kind, expr: this.expr(STOP) };
      } else if (this.accept("EPHEMERAL")) {
        const t = this.peek();
        const hasExpr = t && !(t.kind === "punct" && (t.text === "," || t.text === ")")) && !kw(t, ...STOP);
        col.default = { kind: "EPHEMERAL", expr: hasExpr ? this.expr(STOP) : undefined };
      } else if (this.accept("COMMENT")) col.comment = this.expr(STOP);
      else if (this.accept("CODEC")) col.codec = this.parenthesized();
      else if (this.accept("STATISTICS")) col.statistics = this.parenthesized();
      else if (this.accept("TTL")) col.ttl = this.expr(STOP);
      else if (this.accept("SETTINGS")) col.settings = this.parenthesized();
      else break;
    }
    return col;
  }

  private tableElements(node: Pick<TableNode, "columns" | "indexes" | "projections" | "constraints">): void {
    this.expectPunct("(");
    for (;;) {
      if (this.accept("INDEX")) {
        const name = this.next().text;
        const expr = this.expr(["TYPE"]);
        this.expect("TYPE");
        const type = this.expr(["GRANULARITY"]);
        const granularity = this.accept("GRANULARITY") ? this.expr() : undefined;
        node.indexes.push({ name, expr, type, granularity });
      } else if (this.accept("PROJECTION")) {
        const name = this.next().text;
        node.projections.push({ name, body: this.parenthesized() });
      } else if (this.accept("CONSTRAINT")) {
        const name = this.next().text;
        const kind = this.next().text.toUpperCase();
        if (kind !== "CHECK" && kind !== "ASSUME") this.fail("expected CHECK or ASSUME");
        node.constraints.push({ name, kind, expr: this.expr() });
      } else {
        node.columns.push(this.column());
      }
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      return;
    }
  }

  /** ENGINE and the storage clauses, in any order, as ClickHouse accepts them. */
  private storage(into: StorageNode, terminators: readonly string[]): void {
    const STOP = ["ORDER", "PRIMARY", "PARTITION", "SAMPLE", "TTL", "SETTINGS", "COMMENT", ...terminators];
    for (;;) {
      if (this.accept("ENGINE")) {
        const from = this.idx(-1);
        this.acceptPunct("=");
        const name = this.next().text;
        let args: Span[] | undefined;
        if (this.acceptPunct("(")) {
          args = [];
          if (!this.acceptPunct(")")) {
            for (;;) {
              args.push(this.expr());
              if (this.acceptPunct(",")) continue;
              this.expectPunct(")");
              break;
            }
          }
        }
        into.engine = { name, args, span: { from, to: this.idx(-1) + 1, refs: args?.flatMap((a) => a.refs) ?? [] } };
      } else if (kw(this.peek(), "ORDER") && kw(this.peek(1), "BY")) {
        this.p += 2;
        into.orderBy = this.expr(STOP, false);
      } else if (kw(this.peek(), "PRIMARY") && kw(this.peek(1), "KEY")) {
        this.p += 2;
        into.primaryKey = this.expr(STOP, false);
      } else if (kw(this.peek(), "PARTITION") && kw(this.peek(1), "BY")) {
        this.p += 2;
        into.partitionBy = this.expr(STOP, false);
      } else if (kw(this.peek(), "SAMPLE") && kw(this.peek(1), "BY")) {
        this.p += 2;
        into.sampleBy = this.expr(STOP, false);
      } else if (this.accept("TTL")) {
        into.ttl = this.expr(STOP, false);
      } else if (this.accept("SETTINGS")) {
        into.settings = [];
        for (;;) {
          const key = this.next().text;
          this.expectPunct("=");
          into.settings.push({ key, value: this.expr(STOP) });
          if (!this.acceptPunct(",")) break;
        }
      } else return;
    }
  }

  parse(): CreateNode {
    this.expect("CREATE");
    let orReplace = false;
    if (this.accept("OR")) {
      this.expect("REPLACE");
      orReplace = true;
    }
    if (this.accept("TABLE")) return this.table(orReplace);
    const materialized = this.accept("MATERIALIZED");
    if (this.accept("VIEW")) return this.view(orReplace, materialized);
    this.fail("expected TABLE, VIEW or MATERIALIZED VIEW");
  }

  private ifNotExists(): boolean {
    if (kw(this.peek(), "IF") && kw(this.peek(1), "NOT") && kw(this.peek(2), "EXISTS")) {
      this.p += 3;
      return true;
    }
    return false;
  }

  private onCluster(): Span | undefined {
    if (kw(this.peek(), "ON") && kw(this.peek(1), "CLUSTER")) {
      this.p += 2;
      return this.qualifiedName();
    }
    return undefined;
  }

  private table(orReplace: boolean): TableNode {
    const ifNotExists = this.ifNotExists();
    const name = this.qualifiedName();
    const node: TableNode = {
      statement: "table",
      orReplace,
      ifNotExists,
      name,
      onCluster: this.onCluster(),
      columns: [],
      indexes: [],
      projections: [],
      constraints: [],
    };
    this.tableElements(node);
    this.storage(node, []);
    if (this.accept("COMMENT")) node.comment = this.expr();
    if (!this.atEnd()) this.fail("unexpected token after the table definition");
    return node;
  }

  private view(orReplace: boolean, materialized: boolean): ViewNode {
    const ifNotExists = this.ifNotExists();
    const name = this.qualifiedName();
    const node: ViewNode = {
      statement: "view",
      materialized,
      orReplace,
      ifNotExists,
      name,
      onCluster: this.onCluster(),
      columns: [],
      populate: false,
      select: { from: 0, to: 0, refs: [] },
    };
    if (this.accept("REFRESH")) node.refresh = this.expr(["TO", "ENGINE", "AS", "EMPTY", "APPEND", "DEPENDS"]);
    if (this.accept("APPEND")) {
      /* refreshable APPEND, kept in the source text */
    }
    if (this.accept("TO")) node.to = this.qualifiedName();
    if (this.peek()?.kind === "punct" && this.peek()!.text === "(") {
      const holder = { columns: node.columns, indexes: [], projections: [], constraints: [] };
      this.tableElements(holder);
    }
    this.storage(node, ["AS", "POPULATE", "EMPTY", "DEFINER", "SQL"]);
    if (this.accept("POPULATE")) node.populate = true;
    this.accept("EMPTY");
    this.expect("AS");
    node.select = this.expr(["COMMENT"], false);
    if (this.accept("COMMENT")) node.comment = this.expr();
    if (!this.atEnd()) this.fail("unexpected token after the view's SELECT");
    return node;
  }
}

export function parseCreate(tokens: Token[]): CreateNode {
  return new Parser(tokens).parse();
}
