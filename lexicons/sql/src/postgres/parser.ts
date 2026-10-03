/**
 * A hand-written, lossless parser for the Postgres statements the dialect
 * declares (chant #3278, #3279): `CREATE SCHEMA`, `TABLE`, `INDEX`, `VIEW`,
 * `MATERIALIZED VIEW`, `SEQUENCE`, `TYPE ... AS ENUM`, `DOMAIN`, `EXTENSION`,
 * and `COMMENT ON` for those objects.
 *
 * As for ClickHouse (#3196), statement structure is parsed and expressions are
 * not: a default, a check, a generated expression, an index element, a
 * partition bound and a view's query are token spans, verbatim, with the
 * interpolations inside them recorded. Postgres itself is the backstop.
 *
 * What the spike measured as missing is closed here: a column default is a
 * `b_expr`, so a top-level `IN`, `AND`, `LIKE` or `IS NULL` in it is an error
 * at that token; `LIKE ... INCLUDING` and `ON COMMIT` take only their own
 * option words; a storage parameter list (`WITH (fillfactor = 70)`) is parsed
 * as `name [= value]` items; a type cannot be a reserved word (`a ARRAY[4]`
 * fails at `ARRAY`); and a range partition bound cannot be empty.
 *
 * An interpolation (`ref` token) is accepted wherever a name, a type or an
 * expression goes. Lint parses with every interpolation still a `ref`.
 *
 * Grammar source: the Postgres 18 reference pages for each statement
 * (sql-createtable, sql-createindex, sql-createview,
 * sql-creatematerializedview, sql-createsequence, sql-createtype,
 * sql-createdomain, sql-createextension, sql-createschema, sql-comment) and
 * `src/backend/parser/gram.y` at `REL_18_6` where a page is silent.
 */

import { kw, SqlCursor, type Span } from "../core/cursor";
import { SqlSyntaxError, type Token } from "../core/tokens";
import { keywordCategory } from "./keywords";

export type { Span } from "../core/cursor";
export { SqlSyntaxError };

/** An identifier as Postgres reads it: an unquoted name folds to lower case, a quoted one is exact. */
export function identValue(t: Token | string): string {
  const text = typeof t === "string" ? t : t.text;
  const quoted = typeof t === "string" ? /^(U&)?"/i.test(text) : t.kind === "qident";
  if (quoted) {
    if (/^[Uu]&/.test(text)) return text.slice(3, -1).replace(/""/g, '"');
    return text.slice(1, -1).replace(/""/g, '"');
  }
  return text.toLowerCase();
}

const isKeywordToken = (t: Token): boolean => t.kind === "ident" && keywordCategory(t.text) !== undefined;

export interface NameNode {
  /** The name's pieces, folded. An empty string where a piece is an interpolation. */
  pieces: string[];
  span: Span;
}

export interface ReferencesNode {
  table: NameNode;
  columns: Array<{ name: string; span: Span }>;
  match?: string;
  onDelete?: Span;
  onUpdate?: Span;
}

export type ConstraintKind = "PRIMARY KEY" | "UNIQUE" | "CHECK" | "FOREIGN KEY" | "EXCLUDE" | "NOT NULL";

export interface ConstraintNode {
  name?: string;
  kind: ConstraintKind;
  /** The columns a table constraint is on, by name. */
  columns: Array<{ name: string; span: Span }>;
  /** A check's expression, or an exclusion's element list. */
  expr?: Span;
  /** An exclusion constraint's access method. */
  using?: string;
  /** An exclusion constraint's predicate. */
  where?: Span;
  references?: ReferencesNode;
  nullsNotDistinct?: boolean;
  /** `INCLUDE (...)`, as written, parentheses excluded. */
  include?: Span;
  /** `WITH (...)` storage parameters, as written, parentheses excluded. */
  with?: Span;
  deferrable?: boolean;
  initiallyDeferred?: boolean;
  notValid?: boolean;
  noInherit?: boolean;
  /** `NOT ENFORCED` (Postgres 18). */
  notEnforced?: boolean;
  span: Span;
}

export interface ColumnNode {
  name: string;
  nameSpan: Span;
  type?: Span;
  collate?: Span;
  compression?: Span;
  storage?: Span;
  /** `NOT NULL` (true) or `NULL` (false), when written. */
  notNull?: boolean;
  /** A name given to the column's NOT NULL constraint (`CONSTRAINT x NOT NULL`). */
  notNullName?: string;
  default?: Span;
  generated?: { kind: "stored" | "virtual" | "identity"; expr?: Span; always: boolean; options?: Span };
  /** Column constraints other than NOT NULL, NULL, DEFAULT and GENERATED. */
  constraints: ConstraintNode[];
}

export interface TableNode {
  statement: "table";
  persistence?: "temporary" | "unlogged";
  ifNotExists: boolean;
  name: NameNode;
  ofType?: NameNode;
  partitionOf?: NameNode;
  partitionBound?: Span;
  columns: ColumnNode[];
  constraints: ConstraintNode[];
  like: Span[];
  inherits?: NameNode[];
  partitionBy?: Span;
  using?: Span;
  with?: Span;
  onCommit?: Span;
  tablespace?: Span;
}

export interface IndexElement {
  span: Span;
  /** When the element is a plain column (a name, then only opclass, collation and ordering words), its name. */
  column?: string;
}

export interface IndexNode {
  statement: "index";
  unique: boolean;
  concurrently: boolean;
  ifNotExists: boolean;
  name?: NameNode;
  only: boolean;
  table: NameNode;
  using?: string;
  elements: IndexElement[];
  include?: Span;
  nullsNotDistinct?: boolean;
  with?: Span;
  tablespace?: Span;
  where?: Span;
}

export interface ViewNode {
  statement: "view";
  materialized: boolean;
  orReplace: boolean;
  temporary: boolean;
  recursive: boolean;
  ifNotExists: boolean;
  name: NameNode;
  columnNames: Array<{ name: string; span: Span }>;
  using?: Span;
  with?: Span;
  tablespace?: Span;
  query: Span;
  checkOption?: Span;
  /** `WITH DATA` (true) or `WITH NO DATA` (false), for a materialized view. */
  withData?: boolean;
}

export interface SequenceNode {
  statement: "sequence";
  persistence?: "temporary" | "unlogged";
  ifNotExists: boolean;
  name: NameNode;
  options: Array<{ option: string; value?: Span }>;
}

export interface SchemaNode {
  statement: "schema";
  ifNotExists: boolean;
  name?: NameNode;
  authorization?: Span;
}

export interface EnumNode {
  statement: "enum";
  name: NameNode;
  labels: Span[];
}

export interface DomainNode {
  statement: "domain";
  name: NameNode;
  type: Span;
  collate?: Span;
  default?: Span;
  notNull?: boolean;
  checks: Array<{ name?: string; expr: Span; notValid?: boolean }>;
}

export interface ExtensionNode {
  statement: "extension";
  ifNotExists: boolean;
  name: NameNode;
  schema?: Span;
  version?: Span;
  cascade: boolean;
}

export interface CommentNode {
  statement: "comment";
  /** TABLE, COLUMN, INDEX, VIEW, MATERIALIZED VIEW, SEQUENCE, TYPE, DOMAIN, SCHEMA, EXTENSION, CONSTRAINT, DOMAIN CONSTRAINT. */
  objectType: string;
  target: NameNode;
  /** For `COMMENT ON CONSTRAINT c ON [DOMAIN] t`: the table or domain. */
  on?: NameNode;
  /** The comment, a string, or undefined for `IS NULL`. */
  text?: Span;
}

export type StatementNode =
  | TableNode
  | IndexNode
  | ViewNode
  | SequenceNode
  | SchemaNode
  | EnumNode
  | DomainNode
  | ExtensionNode
  | CommentNode;

const isNameToken = (t: Token | undefined): boolean =>
  t !== undefined && (t.kind === "ident" || t.kind === "qident" || t.kind === "ref");

/** Words that end a column's type or a column clause: a column constraint, or a clause after the type. */
const COLUMN_CLAUSE = [
  "CONSTRAINT",
  "NOT",
  "NULL",
  "DEFAULT",
  "GENERATED",
  "UNIQUE",
  "PRIMARY",
  "CHECK",
  "REFERENCES",
  "COLLATE",
  "DEFERRABLE",
  "INITIALLY",
  "COMPRESSION",
  "STORAGE",
  "ENFORCED",
];

/** `LIKE source_table [ like_option ... ]`'s option words. */
const LIKE_OPTIONS = ["COMMENTS", "COMPRESSION", "CONSTRAINTS", "DEFAULTS", "GENERATED", "IDENTITY", "INDEXES", "STATISTICS", "STORAGE", "ALL"];

/**
 * Words a `b_expr` cannot hold at its top level (gram.y): a column default and
 * a domain default are `b_expr`, which has no `IN`, boolean operators, pattern
 * matching, `BETWEEN`, `IS NULL`-style tests or `AT TIME ZONE`.
 */
const NOT_IN_B_EXPR = ["IN", "AND", "OR", "LIKE", "ILIKE", "SIMILAR", "BETWEEN", "ISNULL", "NOTNULL", "AT", "COLLATE", "OVERLAPS"];

/** What may follow `IS` inside a `b_expr`. */
const B_EXPR_IS = [["DISTINCT", "FROM"], ["NOT", "DISTINCT", "FROM"], ["DOCUMENT"], ["NOT", "DOCUMENT"]];

class PgParser extends SqlCursor {
  /** A multi-word stop is written with spaces: `"WITH CHECK OPTION"`. A stop never ends an expression at its first token. */
  protected override stopsAt(stop: readonly string[]): boolean {
    return stop.some((s) => this.is(...s.split(" ")));
  }

  /** `[` opens and `]` closes, as `(` and `)` do. */
  protected override depthChange(t: Token): number {
    if (t.kind === "punct" && (t.text === "(" || t.text === "[")) return 1;
    if (t.kind === "punct" && (t.text === ")" || t.text === "]")) return -1;
    return 0;
  }

  /**
   * An expression span, up to a top-level `,` (unless `stopAtComma` is
   * false), `)`, `]` or `;`, or a stop that is not its first token.
   */
  protected override expr(stop: readonly string[] = [], stopAtComma = true): Span {
    const from = this.idx();
    const refs: number[] = [];
    let depth = 0;
    const startP = this.p;
    for (;;) {
      const t = this.peek();
      if (t === undefined) break;
      if (depth === 0) {
        if (t.kind === "punct" && (t.text === ")" || t.text === "]" || t.text === ";" || (stopAtComma && t.text === ","))) break;
        if (this.p > startP && this.stopsAt(stop)) break;
      }
      depth += this.depthChange(t);
      if (t.kind === "ref") refs.push(t.part);
      this.p++;
    }
    if (this.p === startP) this.fail("expected an expression");
    return this.span(from, refs);
  }

  private isOp(text: string, n = 0): boolean {
    const t = this.peek(n);
    return t !== undefined && t.kind === "op" && t.text === text;
  }

  /** A ColId: an identifier, or a key word that is neither reserved nor a type/function name word. */
  private colId(t: Token, what: string): void {
    if (!isNameToken(t)) this.fail(`expected ${what}`, t);
    const k = t.kind === "ident" ? keywordCategory(t.text) : undefined;
    if (k === "R" || k === "T") this.fail(`expected ${what} ('${t.text}' is a reserved key word; quote it to use it as a name)`, t);
  }

  private nameTok(what: string): { text: string; span: Span } {
    const t = this.next();
    this.colId(t, what);
    const i = this.idx(-1);
    return { text: t.kind === "ref" ? "" : identValue(t), span: { from: i, to: i + 1, refs: t.kind === "ref" ? [t.part] : [] } };
  }

  /** `name`, `schema.name`, `db.schema.name`. The first piece is a ColId; a piece after a dot may be any word. */
  private qualifiedName(what = "a name"): NameNode {
    const from = this.idx();
    const refs: number[] = [];
    const pieces: string[] = [];
    const one = () => {
      const t = this.next();
      if (pieces.length === 0) this.colId(t, what);
      else if (!isNameToken(t)) this.fail(`expected ${what}`, t);
      if (t.kind === "ref") refs.push(t.part);
      pieces.push(t.kind === "ref" ? "" : identValue(t));
    };
    one();
    while (this.isPunct(".") && isNameToken(this.peek(1))) {
      this.p++;
      one();
    }
    if (this.isPunct(".")) this.fail(`expected ${what}`, this.peek(1));
    return { pieces, span: this.span(from, refs) };
  }

  private ifNotExists(): boolean {
    return this.acceptSeq("IF", "NOT", "EXISTS");
  }

  private checkedParens(): Span {
    const span = this.parenthesized();
    this.checkSpan(span);
    return span;
  }

  /** `(a, b, c)`: a list of names. */
  private nameList(what = "a column name"): Array<{ name: string; span: Span }> {
    this.expectPunct("(");
    const out: Array<{ name: string; span: Span }> = [];
    for (;;) {
      out.push((({ text, span }) => ({ name: text, span }))(this.nameTok(what)));
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      return out;
    }
  }

  /** A comma-separated list of expression spans inside parentheses. */
  private parenList(): Span[] {
    this.expectPunct("(");
    const out: Span[] = [];
    if (this.acceptPunct(")")) return out;
    for (;;) {
      out.push(this.expr());
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      return out;
    }
  }

  /**
   * `( name [= value] [, ...] )`: storage parameters (`WITH (fillfactor = 70)`)
   * or index parameters. A name may be qualified (`toast.autovacuum_enabled`);
   * a value is a number, a string, a word or a signed number.
   */
  private reloptions(): Span {
    const from = this.idx();
    this.expectPunct("(");
    const refs: number[] = [];
    for (;;) {
      const t = this.next();
      if (t.kind === "ref") refs.push(t.part);
      else if (t.kind !== "ident" && t.kind !== "qident") this.fail("expected a storage parameter name", t);
      if (this.acceptPunct(".")) {
        const u = this.next();
        if (u.kind !== "ident" && u.kind !== "qident") this.fail("expected a storage parameter name", u);
      }
      if (this.isOp("=")) {
        this.p++;
        if (this.isOp("-") || this.isOp("+")) this.p++;
        const v = this.next();
        if (v.kind === "ref") refs.push(v.part);
        else if (!["number", "string", "ident", "qident"].includes(v.kind)) this.fail("expected a storage parameter value", v);
      }
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      break;
    }
    // The span keeps the parentheses: `(fillfactor = 70)`.
    return this.span(from, refs);
  }

  /** Constraint attributes after a constraint, recorded on it. */
  private constraintAttributes(node: ConstraintNode): void {
    for (;;) {
      if (this.acceptSeq("NOT", "DEFERRABLE")) node.deferrable = false;
      else if (this.accept("DEFERRABLE")) node.deferrable = true;
      else if (this.acceptSeq("INITIALLY", "DEFERRED")) node.initiallyDeferred = true;
      else if (this.acceptSeq("INITIALLY", "IMMEDIATE")) node.initiallyDeferred = false;
      else if (this.acceptSeq("NOT", "VALID")) node.notValid = true;
      else if (this.acceptSeq("NO", "INHERIT")) node.noInherit = true;
      else if (this.acceptSeq("NOT", "ENFORCED")) node.notEnforced = true;
      else if (this.accept("ENFORCED")) node.notEnforced = false;
      else if (this.accept("INCLUDE")) node.include = this.parenthesized();
      else if (kw(this.peek(), "WITH") && this.isPunct("(", 1)) {
        this.p++;
        node.with = this.reloptions();
      } else if (this.acceptSeq("USING", "INDEX", "TABLESPACE")) this.nameTok("a tablespace");
      else break;
    }
  }

  private references(): ReferencesNode {
    const table = this.qualifiedName("a referenced table");
    const node: ReferencesNode = { table, columns: [] };
    if (this.isPunct("(")) {
      this.expectPunct("(");
      for (;;) {
        this.accept("PERIOD");
        const { text, span } = this.nameTok("a referenced column");
        node.columns.push({ name: text, span });
        if (this.acceptPunct(",")) continue;
        this.expectPunct(")");
        break;
      }
    }
    if (this.accept("MATCH")) {
      if (!this.accept("FULL", "PARTIAL", "SIMPLE")) this.fail("expected FULL, PARTIAL or SIMPLE");
      node.match = this.tokens[this.idx(-1)]!.text.toUpperCase();
    }
    for (;;) {
      if (this.acceptSeq("ON", "DELETE")) node.onDelete = this.fkAction();
      else if (this.acceptSeq("ON", "UPDATE")) node.onUpdate = this.fkAction();
      else break;
    }
    return node;
  }

  private fkAction(): Span {
    const from = this.idx();
    if (this.acceptSeq("NO", "ACTION") || this.accept("RESTRICT") || this.accept("CASCADE")) return this.span(from, []);
    if (this.acceptSeq("SET", "NULL") || this.acceptSeq("SET", "DEFAULT")) {
      if (this.isPunct("(")) this.nameList();
      return this.span(from, []);
    }
    return this.fail("expected NO ACTION, RESTRICT, CASCADE, SET NULL or SET DEFAULT");
  }

  /** `(a, b [, c WITHOUT OVERLAPS | PERIOD c])` for a key. */
  private keyColumns(): Array<{ name: string; span: Span }> {
    this.expectPunct("(");
    const out: Array<{ name: string; span: Span }> = [];
    for (;;) {
      this.accept("PERIOD");
      const { text, span } = this.nameTok("a column name");
      out.push({ name: text, span });
      this.acceptSeq("WITHOUT", "OVERLAPS");
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      return out;
    }
  }

  /** A table constraint, after an optional `CONSTRAINT name`. Undefined when the element is not one. */
  private tableConstraint(): ConstraintNode | undefined {
    const from = this.idx();
    let name: string | undefined;
    if (kw(this.peek(), "CONSTRAINT")) {
      this.p++;
      name = this.nameTok("a constraint name").text;
    }
    const at = (kind: ConstraintKind, extra: Partial<ConstraintNode> = {}): ConstraintNode => ({
      name,
      kind,
      columns: [],
      ...extra,
      span: { from, to: from, refs: [] },
    });
    let node: ConstraintNode;
    if (this.accept("CHECK")) node = at("CHECK", { expr: this.checkedParens() });
    else if (this.acceptSeq("PRIMARY", "KEY")) node = at("PRIMARY KEY", { columns: this.keyColumns() });
    else if (this.accept("UNIQUE")) {
      // NULLS [NOT] DISTINCT comes before the column list.
      const nnd = this.acceptSeq("NULLS", "NOT", "DISTINCT") ? true : this.acceptSeq("NULLS", "DISTINCT") ? false : undefined;
      node = at("UNIQUE", { columns: this.keyColumns(), nullsNotDistinct: nnd });
    } else if (this.acceptSeq("FOREIGN", "KEY")) {
      const columns = this.keyColumns();
      this.expect("REFERENCES");
      node = at("FOREIGN KEY", { columns, references: this.references() });
    } else if (kw(this.peek(), "EXCLUDE") && (this.isPunct("(", 1) || kw(this.peek(1), "USING"))) {
      this.p++;
      const using = this.accept("USING") ? this.nameTok("an access method").text : undefined;
      if (this.isPunct("(") && this.isPunct(")", 1)) this.fail("expected an exclusion element", this.peek(1));
      node = at("EXCLUDE", { expr: this.parenthesized(), using });
    } else if (this.acceptSeq("NOT", "NULL")) {
      const { text, span } = this.nameTok("a column name");
      node = at("NOT NULL", { columns: [{ name: text, span }] });
    } else {
      if (name !== undefined) this.fail("expected CHECK, PRIMARY KEY, UNIQUE, FOREIGN KEY, EXCLUDE or NOT NULL");
      return undefined;
    }
    this.constraintAttributes(node);
    if (node.kind === "EXCLUDE" && this.accept("WHERE")) {
      node.where = this.checkedParens();
      this.constraintAttributes(node);
    }
    node.span = this.span(from, []);
    return node;
  }

  private column(typed: boolean): ColumnNode {
    const { text, span } = this.nameTok("a column name");
    const col: ColumnNode = { name: text, nameSpan: span, constraints: [] };
    if (!typed) this.acceptSeq("WITH", "OPTIONS");
    const at = this.peek();
    const bare = at === undefined || (at.kind === "punct" && (at.text === "," || at.text === ")"));
    if (typed && !bare && !this.stopsAt(COLUMN_CLAUSE)) col.type = this.typeName();
    else if (typed) this.fail("expected a column type");
    for (;;) {
      if (this.accept("COMPRESSION")) col.compression = this.expr(COLUMN_CLAUSE);
      else if (this.accept("STORAGE")) col.storage = this.expr(COLUMN_CLAUSE);
      else if (this.accept("COLLATE")) col.collate = this.expr(COLUMN_CLAUSE);
      else if (!this.columnConstraint(col)) break;
    }
    const after = this.peek();
    if (after && !(after.kind === "punct" && (after.text === "," || after.text === ")"))) this.fail("expected a column constraint, ',' or ')'");
    return col;
  }

  /**
   * A type name: `[schema.]name [(modifiers)]`, the SQL multi-word forms
   * (`double precision`, `character varying`, `timestamp with time zone`,
   * `interval day to second`, `bit varying`), `SETOF`-free, and array bounds
   * (`int[]`, `int[3]`, `int ARRAY[3]`). An interpolated type is one token.
   * A reserved word is never a type.
   */
  private typeName(): Span {
    const from = this.idx();
    const refs: number[] = [];
    const t = this.next();
    if (t.kind === "ref") refs.push(t.part);
    else if (t.kind !== "ident" && t.kind !== "qident") this.fail("expected a type", t);
    else if (t.kind === "ident" && keywordCategory(t.text) === "R") this.fail("expected a type", t);
    const first = t.kind === "ident" ? t.text.toUpperCase() : "";
    if (t.kind !== "ref") while (this.isPunct(".") && isNameToken(this.peek(1))) this.p += 2;
    const precision = () => {
      if (this.isPunct("(") && this.isPunct(")", 1)) this.fail("expected a type modifier", this.peek(1));
      if (this.isPunct("(")) refs.push(...this.parenthesized().refs);
    };
    if (first === "DOUBLE") this.expect("PRECISION");
    else if (["CHARACTER", "CHAR", "NCHAR", "NATIONAL", "BIT", "VARCHAR"].includes(first)) {
      if (first === "NATIONAL") this.expect("CHARACTER", "CHAR");
      this.accept("VARYING");
      precision();
    } else if (first === "TIME" || first === "TIMESTAMP") {
      precision();
      if (!this.acceptSeq("WITH", "TIME", "ZONE")) this.acceptSeq("WITHOUT", "TIME", "ZONE");
    } else if (first === "INTERVAL") {
      const FIELDS = ["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND"];
      if (this.accept(...FIELDS) && this.accept("TO")) this.expect(...FIELDS);
      precision();
    } else precision();
    for (;;) {
      if (this.isPunct("[")) {
        this.p++;
        if (this.peek()?.kind === "number") this.p++;
        this.expectPunct("]");
      } else if (this.accept("ARRAY")) {
        if (this.isPunct("[")) {
          this.p++;
          if (this.peek()?.kind === "number") this.p++;
          this.expectPunct("]");
        }
      } else break;
    }
    return this.span(from, refs);
  }

  /** An expression span with the operand check {@link checkSpan} makes. */
  private checkedExpr(stop: readonly string[] = [], stopAtComma = true): Span {
    const span = this.expr(stop, stopAtComma);
    this.checkSpan(span);
    return span;
  }

  /** A `b_expr` (a column or domain default): an expression with none of {@link NOT_IN_B_EXPR} at its top level. */
  private bExpr(stop: readonly string[]): Span {
    const span = this.checkedExpr(stop);
    let depth = 0;
    const sig: Token[] = [];
    for (let i = span.from; i < span.to; i++) {
      const t = this.tokens[i]!;
      if (t.kind !== "ws" && t.kind !== "comment") sig.push(t);
    }
    for (let k = 0; k < sig.length; k++) {
      const t = sig[k]!;
      depth += this.depthChange(t);
      if (depth !== 0 || t.kind !== "ident") continue;
      const word = t.text.toUpperCase();
      if (NOT_IN_B_EXPR.includes(word)) this.fail("expected the end of the default (a default cannot hold this operator unparenthesized)", t);
      if (word === "IS") {
        const ok = B_EXPR_IS.some((seq) => seq.every((w, n) => kw(sig[k + 1 + n], w)));
        if (!ok) this.fail("expected the end of the default (a default cannot hold IS unparenthesized)", t);
      }
    }
    return span;
  }

  /**
   * Since Postgres 14 removed postfix operators, an operand is never followed
   * directly by a name that is not a key word, nor by another literal. That
   * catches a misspelt key word after an expression (`DEFAULT 'x' CHEK (...)`)
   * at its token, which a plain span would accept.
   */
  private checkSpan(span: Span): void {
    let prev: Token | undefined;
    const operandEnd = (x: Token) =>
      x.kind === "string" ||
      x.kind === "number" ||
      x.kind === "qident" ||
      x.kind === "param" ||
      x.kind === "ref" ||
      (x.kind === "punct" && (x.text === ")" || x.text === "]")) ||
      (x.kind === "ident" && !isKeywordToken(x));
    for (let i = span.from; i < span.to; i++) {
      const t = this.tokens[i]!;
      if (t.kind === "ws" || t.kind === "comment") continue;
      if (prev && prev.kind === "punct" && prev.text === "," && t.kind === "punct" && t.text === ")") this.fail("expected an expression", t);
      // Two operands in a row: `z 0`, `(a) 'x'`. A name before a string is a typed literal (`date '2020-01-01'`).
      if (prev && operandEnd(prev) && (t.kind === "number" || t.kind === "qident" || t.kind === "param" || (t.kind === "string" && prev.kind !== "ident"))) {
        this.fail("expected an operator, a key word or the end of the expression", t);
      }
      if (prev && t.kind === "ident" && !isKeywordToken(t) && operandEnd(prev)) {
        this.fail("expected an operator, a key word or the end of the expression", t);
      }
      prev = t;
    }
  }

  /** One column constraint; false when there is none here. */
  private columnConstraint(col: ColumnNode): boolean {
    const from = this.idx();
    let name: string | undefined;
    if (kw(this.peek(), "CONSTRAINT")) {
      this.p++;
      name = this.nameTok("a constraint name").text;
    }
    const push = (kind: ConstraintKind, extra: Partial<ConstraintNode> = {}) => {
      const node: ConstraintNode = { name, kind, columns: [], ...extra, span: { from, to: from, refs: [] } };
      this.constraintAttributes(node);
      node.span = this.span(from, []);
      col.constraints.push(node);
    };
    if (this.acceptSeq("NOT", "NULL")) {
      col.notNull = true;
      if (name !== undefined) col.notNullName = name;
      this.acceptSeq("NO", "INHERIT");
    } else if (this.accept("NULL")) col.notNull = false;
    else if (this.accept("DEFAULT")) col.default = this.bExpr(COLUMN_CLAUSE);
    else if (kw(this.peek(), "GENERATED")) {
      this.p++;
      let always: boolean;
      if (this.accept("ALWAYS")) always = true;
      else {
        this.expect("BY");
        this.expect("DEFAULT");
        always = false;
      }
      this.expect("AS");
      if (this.accept("IDENTITY")) {
        col.generated = { kind: "identity", always, options: this.isPunct("(") ? this.parenthesized() : undefined };
      } else {
        if (!always) this.fail("expected IDENTITY (a generated column is GENERATED ALWAYS AS)");
        const expr = this.checkedParens();
        const kind = this.accept("VIRTUAL") ? "virtual" : (this.accept("STORED"), "stored");
        col.generated = { kind, expr, always };
      }
    } else if (this.accept("CHECK")) push("CHECK", { expr: this.checkedParens() });
    else if (this.accept("UNIQUE")) {
      const nnd = this.acceptSeq("NULLS", "NOT", "DISTINCT") ? true : this.acceptSeq("NULLS", "DISTINCT") ? false : undefined;
      push("UNIQUE", { nullsNotDistinct: nnd });
    } else if (this.acceptSeq("PRIMARY", "KEY")) push("PRIMARY KEY");
    else if (this.accept("REFERENCES")) push("FOREIGN KEY", { references: this.references() });
    else if (name === undefined && col.constraints.length > 0 && kw(this.peek(), "DEFERRABLE", "INITIALLY", "NOT")) {
      // `DEFERRABLE` / `INITIALLY ...` written after the constraint it qualifies.
      const last = col.constraints[col.constraints.length - 1]!;
      const before = this.p;
      this.constraintAttributes(last);
      if (this.p === before) return false;
    } else {
      if (name !== undefined) this.fail("expected a column constraint");
      return false;
    }
    return true;
  }

  private tableElements(node: TableNode, typed: boolean): void {
    this.expectPunct("(");
    if (this.acceptPunct(")")) return;
    for (;;) {
      if (this.accept("LIKE")) node.like.push(this.likeClause());
      else {
        const c = this.tableConstraint();
        if (c) node.constraints.push(c);
        else node.columns.push(this.column(typed));
      }
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      return;
    }
  }

  /** `LIKE source [ { INCLUDING | EXCLUDING } option ... ]`, as written after `LIKE`. */
  private likeClause(): Span {
    const from = this.idx();
    const source = this.qualifiedName("a table name");
    while (this.accept("INCLUDING", "EXCLUDING")) {
      if (!this.accept(...LIKE_OPTIONS)) this.fail(`expected ${LIKE_OPTIONS.join(", ")}`);
    }
    return this.span(from, source.span.refs);
  }

  private persistence(): "temporary" | "unlogged" | undefined {
    this.accept("GLOBAL", "LOCAL");
    if (this.accept("TEMPORARY", "TEMP")) return "temporary";
    if (this.accept("UNLOGGED")) return "unlogged";
    return undefined;
  }

  parse(): StatementNode {
    if (this.accept("COMMENT")) return this.comment();
    this.expect("CREATE");
    const orReplace = this.acceptSeq("OR", "REPLACE");
    if (!orReplace) {
      if (this.accept("SCHEMA")) return this.schema();
      if (this.accept("EXTENSION")) return this.extension();
      if (this.accept("DOMAIN")) return this.domain();
      if (this.accept("TYPE")) return this.enumType();
      if (kw(this.peek(), "UNIQUE", "INDEX")) return this.index();
    }
    const persistence = this.persistence();
    if (!orReplace && this.accept("TABLE")) return this.table(persistence);
    if (!orReplace && this.accept("SEQUENCE")) return this.sequence(persistence);
    if (persistence === "unlogged") return this.fail("expected TABLE or SEQUENCE");
    const recursive = this.accept("RECURSIVE");
    if (!orReplace && !recursive && persistence === undefined && this.acceptSeq("MATERIALIZED", "VIEW")) return this.view(true, false, false, false);
    if (this.accept("VIEW")) return this.view(false, orReplace, persistence === "temporary", recursive);
    return this.fail("expected SCHEMA, TABLE, INDEX, VIEW, MATERIALIZED VIEW, SEQUENCE, TYPE, DOMAIN or EXTENSION");
  }

  private schema(): SchemaNode {
    const node: SchemaNode = { statement: "schema", ifNotExists: this.ifNotExists() };
    if (!kw(this.peek(), "AUTHORIZATION")) node.name = this.qualifiedName("a schema name");
    if (this.accept("AUTHORIZATION")) {
      const from = this.idx();
      const t = this.next();
      if (!isNameToken(t)) this.fail("expected a role name", t);
      node.authorization = this.span(from, t.kind === "ref" ? [t.part] : []);
    }
    if (kw(this.peek(), "CREATE", "GRANT")) this.fail("schema elements inside CREATE SCHEMA are not declared here; declare each object on its own");
    return node;
  }

  private extension(): ExtensionNode {
    const node: ExtensionNode = { statement: "extension", ifNotExists: this.ifNotExists(), name: this.qualifiedName("an extension name"), cascade: false };
    this.accept("WITH");
    for (;;) {
      if (this.accept("SCHEMA")) node.schema = this.nameTok("a schema name").span;
      else if (this.accept("VERSION")) {
        const from = this.idx();
        const t = this.next();
        if (!["ident", "qident", "string", "ref"].includes(t.kind)) this.fail("expected a version", t);
        node.version = this.span(from, t.kind === "ref" ? [t.part] : []);
      } else if (this.accept("CASCADE")) node.cascade = true;
      else return node;
    }
  }

  private domain(): DomainNode {
    const name = this.qualifiedName("a domain name");
    this.accept("AS");
    const STOP = ["COLLATE", "DEFAULT", "CONSTRAINT", "NOT", "NULL", "CHECK"];
    const node: DomainNode = { statement: "domain", name, type: this.typeName(), checks: [] };
    for (;;) {
      if (this.accept("COLLATE")) node.collate = this.expr(STOP);
      else if (this.accept("DEFAULT")) node.default = this.bExpr(STOP);
      else {
        let cname: string | undefined;
        if (this.accept("CONSTRAINT")) cname = this.nameTok("a constraint name").text;
        if (this.acceptSeq("NOT", "NULL")) node.notNull = true;
        else if (this.accept("NULL")) node.notNull = false;
        else if (this.accept("CHECK")) {
          const expr = this.checkedParens();
          node.checks.push({ name: cname, expr, ...(this.acceptSeq("NOT", "VALID") ? { notValid: true } : {}) });
        } else if (cname !== undefined) this.fail("expected NOT NULL, NULL or CHECK");
        else return node;
      }
    }
  }

  private enumType(): EnumNode {
    const name = this.qualifiedName("a type name");
    this.expect("AS");
    if (!this.accept("ENUM")) this.fail("expected ENUM (the type tag declares enum types; a domain has its own tag)");
    const labels = this.parenList();
    for (const l of labels) {
      const sig = this.tokens.slice(l.from, l.to).filter((t) => t.kind !== "ws" && t.kind !== "comment");
      if (sig.length !== 1 || (sig[0]!.kind !== "string" && sig[0]!.kind !== "ref")) this.fail("expected a string label", sig[0]);
    }
    return { statement: "enum", name, labels };
  }

  private table(persistence: TableNode["persistence"]): TableNode {
    const ifNotExists = this.ifNotExists();
    const node: TableNode = { statement: "table", persistence, ifNotExists, name: this.qualifiedName("a table name"), columns: [], constraints: [], like: [] };
    if (this.accept("OF")) {
      node.ofType = this.qualifiedName("a type name");
      if (this.isPunct("(")) this.tableElements(node, false);
    } else if (this.acceptSeq("PARTITION", "OF")) {
      node.partitionOf = this.qualifiedName("a partitioned table");
      if (this.isPunct("(")) this.tableElements(node, false);
      node.partitionBound = this.partitionBound();
    } else {
      if (!this.isPunct("(")) this.fail("expected the column list (CREATE TABLE ... AS is not declared here)");
      this.tableElements(node, true);
    }
    for (;;) {
      if (this.accept("INHERITS")) {
        this.expectPunct("(");
        node.inherits = [];
        do node.inherits.push(this.qualifiedName("a parent table"));
        while (this.acceptPunct(","));
        this.expectPunct(")");
      } else if (this.acceptSeq("PARTITION", "BY")) {
        const from = this.idx();
        this.expect("RANGE", "LIST", "HASH");
        if (this.isPunct(")", 1)) this.fail("expected a partition key", this.peek(1));
        node.partitionBy = this.span(from, this.parenthesized().refs);
      } else if (this.accept("USING")) node.using = this.nameTok("an access method").span;
      else if (kw(this.peek(), "WITH") && this.isPunct("(", 1)) {
        this.p++;
        node.with = this.reloptions();
      } else if (this.acceptSeq("WITHOUT", "OIDS")) continue;
      else if (this.acceptSeq("ON", "COMMIT")) {
        const from = this.idx();
        if (!(this.acceptSeq("PRESERVE", "ROWS") || this.acceptSeq("DELETE", "ROWS") || this.accept("DROP"))) this.fail("expected PRESERVE ROWS, DELETE ROWS or DROP");
        node.onCommit = this.span(from, []);
      } else if (this.accept("TABLESPACE")) node.tablespace = this.nameTok("a tablespace").span;
      else break;
    }
    return node;
  }

  /** `DEFAULT`, or `FOR VALUES IN (...)`, `FROM (...) TO (...)` or `WITH (MODULUS n, REMAINDER m)`. */
  private partitionBound(): Span {
    const from = this.idx();
    if (this.accept("DEFAULT")) return this.span(from, []);
    this.expect("FOR");
    this.expect("VALUES");
    const refs: number[] = [];
    const values = () => {
      if (this.isPunct("(") && this.isPunct(")", 1)) this.fail("expected a partition bound value", this.peek(1));
      refs.push(...this.checkedParens().refs);
    };
    if (this.accept("IN")) values();
    else if (this.accept("FROM")) {
      values();
      this.expect("TO");
      values();
    } else if (this.accept("WITH")) {
      this.expectPunct("(");
      for (const w of ["MODULUS", "REMAINDER"]) {
        if (!this.accept(w)) this.fail(`expected ${w}`);
        const t = this.next();
        if (t.kind !== "number" && t.kind !== "ref") this.fail("expected a number", t);
        if (w === "MODULUS") this.expectPunct(",");
      }
      this.expectPunct(")");
    } else this.fail("expected IN, FROM or WITH");
    return this.span(from, refs);
  }

  private index(): IndexNode {
    const unique = this.accept("UNIQUE");
    this.expect("INDEX");
    const concurrently = this.accept("CONCURRENTLY");
    const ifNotExists = this.ifNotExists();
    let name: NameNode | undefined;
    if (!(kw(this.peek(), "ON") && !ifNotExists)) {
      // An index lives in its table's schema: CREATE INDEX takes an unqualified name.
      const { text, span } = this.nameTok("an index name");
      if (this.isPunct(".")) this.fail("expected ON (an index name is not schema-qualified; the index is created in its table's schema)");
      name = { pieces: [text], span };
    }
    this.expect("ON");
    const only = this.accept("ONLY");
    const node: IndexNode = { statement: "index", unique, concurrently, ifNotExists, name, only, table: this.qualifiedName("a table name"), elements: [] };
    if (this.accept("USING")) node.using = this.nameTok("an access method").text;
    if (this.isPunct("(") && this.isPunct(")", 1)) this.fail("expected an index column or expression", this.peek(1));
    for (const span of this.parenList()) {
      const sig = this.tokens.slice(span.from, span.to).filter((t) => t.kind !== "ws" && t.kind !== "comment");
      const first = sig[0];
      // A column element is a bare name, then only opclass, collation and ordering words.
      const column =
        first && (first.kind === "ident" || first.kind === "qident") && sig.slice(1).every((t) => t.kind === "ident" || t.kind === "qident")
          ? identValue(first)
          : undefined;
      node.elements.push({ span, ...(column !== undefined ? { column } : {}) });
    }
    for (;;) {
      if (this.accept("INCLUDE")) node.include = this.parenthesized();
      else if (this.acceptSeq("NULLS", "NOT", "DISTINCT")) node.nullsNotDistinct = true;
      else if (this.acceptSeq("NULLS", "DISTINCT")) node.nullsNotDistinct = false;
      else if (kw(this.peek(), "WITH") && this.isPunct("(", 1)) {
        this.p++;
        node.with = this.reloptions();
      } else if (this.accept("TABLESPACE")) node.tablespace = this.nameTok("a tablespace").span;
      else if (this.accept("WHERE")) node.where = this.checkedExpr([], false);
      else return node;
    }
  }

  private view(materialized: boolean, orReplace: boolean, temporary: boolean, recursive: boolean): ViewNode {
    const ifNotExists = materialized ? this.ifNotExists() : false;
    const node: ViewNode = {
      statement: "view",
      materialized,
      orReplace,
      temporary,
      recursive,
      ifNotExists,
      name: this.qualifiedName("a view name"),
      columnNames: [],
      query: { from: 0, to: 0, refs: [] },
    };
    if (this.isPunct("(")) node.columnNames = this.nameList();
    for (;;) {
      if (materialized && this.accept("USING")) node.using = this.nameTok("an access method").span;
      else if (kw(this.peek(), "WITH") && this.isPunct("(", 1)) {
        this.p++;
        node.with = this.reloptions();
      } else if (materialized && this.accept("TABLESPACE")) node.tablespace = this.nameTok("a tablespace").span;
      else break;
    }
    this.expect("AS");
    const tail = materialized
      ? ["WITH DATA", "WITH NO DATA"]
      : ["WITH CHECK OPTION", "WITH CASCADED CHECK OPTION", "WITH LOCAL CHECK OPTION"];
    node.query = this.expr(tail, false);
    if (materialized) {
      if (this.acceptSeq("WITH", "DATA")) node.withData = true;
      else if (this.acceptSeq("WITH", "NO", "DATA")) node.withData = false;
    } else if (kw(this.peek(), "WITH")) {
      const from = this.idx();
      this.p++;
      this.accept("CASCADED", "LOCAL");
      this.expect("CHECK");
      this.expect("OPTION");
      node.checkOption = this.span(from, []);
    }
    return node;
  }

  private sequence(persistence: SequenceNode["persistence"]): SequenceNode {
    const node: SequenceNode = { statement: "sequence", persistence, ifNotExists: this.ifNotExists(), name: this.qualifiedName("a sequence name"), options: [] };
    const STOP = ["AS", "INCREMENT", "MINVALUE", "MAXVALUE", "NO", "START", "RESTART", "CACHE", "CYCLE", "OWNED", "SEQUENCE", "LOGGED", "UNLOGGED"];
    const value = () => {
      const span = this.expr(STOP);
      this.checkSpan(span);
      return span;
    };
    for (;;) {
      if (this.atEnd()) return node;
      if (this.accept("AS")) node.options.push({ option: "AS", value: this.typeName() });
      else if (this.accept("INCREMENT")) {
        this.accept("BY");
        node.options.push({ option: "INCREMENT", value: value() });
      } else if (this.acceptSeq("NO", "MINVALUE") || this.acceptSeq("NO", "MAXVALUE") || this.acceptSeq("NO", "CYCLE")) {
        node.options.push({ option: `NO ${this.tokens[this.idx(-1)]!.text.toUpperCase()}` });
      } else if (this.accept("MINVALUE", "MAXVALUE", "CACHE")) {
        node.options.push({ option: this.tokens[this.idx(-1)]!.text.toUpperCase(), value: value() });
      } else if (this.accept("START")) {
        this.accept("WITH");
        node.options.push({ option: "START", value: value() });
      } else if (this.accept("CYCLE")) node.options.push({ option: "CYCLE" });
      else if (this.acceptSeq("OWNED", "BY")) {
        if (this.accept("NONE")) node.options.push({ option: "OWNED BY", value: this.span(this.idx(-1), []) });
        else node.options.push({ option: "OWNED BY", value: this.qualifiedName("a column").span });
      } else return node;
    }
  }

  private comment(): CommentNode {
    this.expect("ON");
    let objectType: string;
    let on: NameNode | undefined;
    let target: NameNode;
    if (this.accept("CONSTRAINT")) {
      objectType = "CONSTRAINT";
      target = this.qualifiedName("a constraint name");
      this.expect("ON");
      if (this.accept("DOMAIN")) objectType = "DOMAIN CONSTRAINT";
      on = this.qualifiedName("a table name");
    } else {
      if (this.acceptSeq("MATERIALIZED", "VIEW")) objectType = "MATERIALIZED VIEW";
      else if (this.accept("TABLE", "COLUMN", "INDEX", "VIEW", "SEQUENCE", "TYPE", "DOMAIN", "SCHEMA", "EXTENSION")) {
        objectType = this.tokens[this.idx(-1)]!.text.toUpperCase();
      } else return this.fail("expected TABLE, COLUMN, INDEX, VIEW, MATERIALIZED VIEW, SEQUENCE, TYPE, DOMAIN, SCHEMA, EXTENSION or CONSTRAINT");
      target = this.qualifiedName("an object name");
    }
    this.expect("IS");
    const node: CommentNode = { statement: "comment", objectType, target, on };
    if (!this.accept("NULL")) {
      const t = this.peek();
      if (t?.kind !== "string" && t?.kind !== "ref") this.fail("expected a string or NULL");
      const from = this.idx();
      this.p++;
      node.text = this.span(from, t.kind === "ref" ? [t.part] : []);
    }
    return node;
  }

  /** Statements separated by `;`, to the end. */
  parseMany(): StatementNode[] {
    const out: StatementNode[] = [];
    while (this.peek() !== undefined) {
      if (this.acceptPunct(";")) continue;
      out.push(this.parse());
      if (this.peek() !== undefined && !this.isPunct(";")) this.fail(`unexpected token after the ${describe(out[out.length - 1]!)}`);
    }
    if (out.length === 0) this.fail("expected a statement");
    return out;
  }
}

const describe = (n: StatementNode): string =>
  n.statement === "comment" ? "COMMENT ON" : n.statement === "enum" ? "type definition" : `${n.statement} definition`;

/**
 * Parse a template: one CREATE, optionally followed by COMMENT ON statements,
 * separated by `;`. Throws {@link SqlSyntaxError} located in the template.
 */
export function parseStatements(tokens: Token[]): StatementNode[] {
  return new PgParser(tokens).parseMany();
}
