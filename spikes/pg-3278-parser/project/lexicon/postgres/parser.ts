/**
 * Spike (#3278): a hand-written, lossless parser for the Postgres statements
 * the dialect declares: CREATE SCHEMA, TABLE, INDEX, VIEW, MATERIALIZED VIEW,
 * SEQUENCE, TYPE ... AS ENUM, DOMAIN, EXTENSION, and COMMENT ON.
 *
 * As for ClickHouse (#3196), statement structure is parsed and expressions
 * are not: a default, a check, a generated expression, an index element, a
 * partition bound, a view's query are token spans, verbatim, with the
 * interpolations inside them recorded. Postgres's own parser stays the
 * backstop (a scratch server, or libpg_query if the user approves it).
 *
 * Grammar source: the Postgres 18 reference pages for each statement
 * (sql-createtable, sql-createindex, sql-createview, sql-creatematerializedview,
 * sql-createsequence, sql-createtype, sql-createdomain, sql-createextension,
 * sql-createschema, sql-comment).
 */

import { Cursor, kw, type Span, type Stop } from "../core/cursor";
import { SqlSyntaxError, type Token } from "../core/tokens";
import { KEYWORDS } from "./keywords";

const isKeyword = (t: Token): boolean => t.kind === "ident" && Object.prototype.hasOwnProperty.call(KEYWORDS, t.text.toLowerCase());

export type { Span };

/** An identifier as Postgres reads it: an unquoted name folds to lower case, a quoted one is exact. */
export function identValue(t: Token): string {
  if (t.kind === "qident") {
    if (/^[Uu]&/.test(t.text)) return t.text.slice(3, -1).replace(/""/g, '"');
    return t.text.slice(1, -1).replace(/""/g, '"');
  }
  return t.text.toLowerCase();
}

export interface NameNode {
  /** The name's pieces, folded. Empty strings where a piece is an interpolation. */
  pieces: string[];
  span: Span;
}

export type FkAction = string;

export interface ReferencesNode {
  table: NameNode;
  columns: Array<{ name: string; span: Span }>;
  match?: string;
  onDelete?: Span;
  onUpdate?: Span;
}

export interface ConstraintNode {
  name?: string;
  kind: "PRIMARY KEY" | "UNIQUE" | "CHECK" | "FOREIGN KEY" | "EXCLUDE" | "NOT NULL";
  /** Columns the constraint is on (table form), by name. */
  columns: Array<{ name: string; span: Span }>;
  expr?: Span;
  references?: ReferencesNode;
  /** INCLUDE, WITH, USING INDEX TABLESPACE, NULLS [NOT] DISTINCT, DEFERRABLE, NOT VALID, NO INHERIT ... as written. */
  attributes?: Span;
  span: Span;
}

export interface ColumnNode {
  name: string;
  nameSpan: Span;
  type?: Span;
  collate?: Span;
  compression?: Span;
  storage?: Span;
  notNull?: boolean;
  default?: Span;
  generated?: { kind: "stored" | "virtual" | "identity"; expr?: Span; always?: boolean; options?: Span };
  /** Column constraints other than NOT NULL / NULL / DEFAULT / GENERATED. */
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
  /** When the element is a plain column (a name or a column reference), its name. */
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
  /** `WITH DATA` (true) / `WITH NO DATA` (false), for a materialized view. */
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
  /** TABLE, COLUMN, INDEX, VIEW, MATERIALIZED VIEW, SEQUENCE, TYPE, DOMAIN, SCHEMA, EXTENSION, CONSTRAINT. */
  objectType: string;
  target: NameNode;
  /** For COMMENT ON CONSTRAINT c ON [DOMAIN] t: the table or domain. */
  on?: NameNode;
  /** The comment: a string expression, or undefined for IS NULL. */
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

/** Words that end a column's type: a column constraint, or a clause that follows the type. */
const COLUMN_CLAUSE: Stop[] = [
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

/** Constraint attributes after a constraint, kept as written. */
const CONSTRAINT_ATTRS = ["DEFERRABLE", "INITIALLY", "NOT", "NO", "ENFORCED", "INCLUDE", "WITH", "USING", "NULLS"];

class PgParser extends Cursor {
  /** A ColId: an identifier, or a key word that is neither reserved nor a type/function-name key word. */
  private colId(t: Token, what: string): void {
    if (!isNameToken(t)) this.fail(`expected ${what}`, t);
    const k = t.kind === "ident" ? KEYWORDS[t.text.toLowerCase()] : undefined;
    if (t.kind === "ident" && Object.prototype.hasOwnProperty.call(KEYWORDS, t.text.toLowerCase()) && (k === "R" || k === "T")) {
      this.fail(`expected ${what} ('${t.text}' is a reserved key word; quote it to use it as a name)`, t);
    }
  }

  private nameTok(what: string): { text: string; span: Span } {
    const t = this.next();
    this.colId(t, what);
    const i = this.idx(-1);
    return { text: t.kind === "ref" ? "" : identValue(t), span: { from: i, to: i + 1, refs: t.kind === "ref" ? [t.part] : [] } };
  }

  /** `name`, `schema.name`, `db.schema.name`. */
  private qualifiedName(what = "a name"): NameNode {
    const from = this.idx();
    const refs: number[] = [];
    const pieces: string[] = [];
    const one = () => {
      const t = this.next();
      // The first piece is a ColId; a piece after a dot may be any key word (attr_name).
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
    return { pieces, span: this.span(from, refs) };
  }

  private ifNotExists(): boolean {
    return this.acceptSeq("IF", "NOT", "EXISTS");
  }

  checkedParens(): Span {
    const span = this.parenthesized();
    this.checkSpan(span);
    return span;
  }

  /** `(a, b, c)`: a list of names. */
  private nameList(): Array<{ name: string; span: Span }> {
    this.expectPunct("(");
    const out: Array<{ name: string; span: Span }> = [];
    for (;;) {
      const { text, span } = this.nameTok("a column name");
      out.push({ name: text, span });
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      return out;
    }
  }

  /** Constraint attributes and index parameters, kept as one span. */
  private constraintAttributes(): Span | undefined {
    const from = this.idx();
    const refs: number[] = [];
    const start = this.p;
    for (;;) {
      if (this.acceptSeq("NOT", "DEFERRABLE") || this.accept("DEFERRABLE")) continue;
      if (this.acceptSeq("INITIALLY", "DEFERRED") || this.acceptSeq("INITIALLY", "IMMEDIATE")) continue;
      if (this.acceptSeq("NOT", "VALID") || this.acceptSeq("NO", "INHERIT")) continue;
      if (this.acceptSeq("NOT", "ENFORCED") || this.accept("ENFORCED")) continue;
      if (this.acceptSeq("NULLS", "NOT", "DISTINCT") || this.acceptSeq("NULLS", "DISTINCT")) continue;
      if (this.accept("INCLUDE")) {
        refs.push(...this.parenthesized().refs);
        continue;
      }
      if (kw(this.peek(), "WITH") && this.isPunct("(", 1)) {
        this.p++;
        refs.push(...this.parenthesized().refs);
        continue;
      }
      if (this.acceptSeq("USING", "INDEX", "TABLESPACE")) {
        this.nameTok("a tablespace");
        continue;
      }
      break;
    }
    return this.p === start ? undefined : this.span(from, refs);
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
    if (this.accept("MATCH")) node.match = this.next().text.toUpperCase();
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

  /** A table constraint, after an optional `CONSTRAINT name`. Returns undefined when the element is not one. */
  private tableConstraint(): ConstraintNode | undefined {
    const from = this.idx();
    let name: string | undefined;
    if (kw(this.peek(), "CONSTRAINT")) {
      this.p++;
      name = this.nameTok("a constraint name").text;
    }
    let node: ConstraintNode;
    if (this.accept("CHECK")) {
      node = { name, kind: "CHECK", columns: [], expr: this.checkedParens(), span: { from, to: from, refs: [] } };
    } else if (this.acceptSeq("PRIMARY", "KEY")) {
      node = { name, kind: "PRIMARY KEY", columns: this.keyColumns(), span: { from, to: from, refs: [] } };
    } else if (this.accept("UNIQUE")) {
      // NULLS [NOT] DISTINCT comes before the column list.
      this.acceptSeq("NULLS", "NOT", "DISTINCT") || this.acceptSeq("NULLS", "DISTINCT");
      node = { name, kind: "UNIQUE", columns: this.keyColumns(), span: { from, to: from, refs: [] } };
    } else if (this.acceptSeq("FOREIGN", "KEY")) {
      const columns = this.keyColumns();
      this.expect("REFERENCES");
      node = { name, kind: "FOREIGN KEY", columns, references: this.references(), span: { from, to: from, refs: [] } };
    } else if (kw(this.peek(), "EXCLUDE") && (this.isPunct("(", 1) || kw(this.peek(1), "USING"))) {
      this.p++;
      if (this.accept("USING")) this.nameTok("an access method");
      const elems = this.parenthesized();
      node = { name, kind: "EXCLUDE", columns: [], expr: elems, span: { from, to: from, refs: [] } };
    } else if (this.acceptSeq("NOT", "NULL")) {
      const { text, span } = this.nameTok("a column name");
      node = { name, kind: "NOT NULL", columns: [{ name: text, span }], span: { from, to: from, refs: [] } };
    } else {
      if (name !== undefined) this.fail("expected CHECK, PRIMARY KEY, UNIQUE, FOREIGN KEY, EXCLUDE or NOT NULL");
      return undefined;
    }
    node.attributes = this.constraintAttributes();
    if (node.kind === "EXCLUDE" && this.accept("WHERE")) node.attributes = this.span(node.attributes?.from ?? this.idx(-1), this.parenthesized().refs);
    node.span = this.span(from, []);
    return node;
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

  private column(typed: boolean): ColumnNode {
    const { text, span } = this.nameTok("a column name");
    const col: ColumnNode = { name: text, nameSpan: span, constraints: [] };
    if (!typed) this.acceptSeq("WITH", "OPTIONS");
    const at = this.peek();
    const bare = at === undefined || (at.kind === "punct" && (at.text === "," || at.text === ")"));
    if (typed && !bare && !this.stopsHere(COLUMN_CLAUSE)) col.type = this.typeName();
    else if (typed && !col.type) this.fail("expected a column type");
    for (;;) {
      if (this.accept("COMPRESSION")) col.compression = this.expr(COLUMN_CLAUSE);
      else if (this.accept("STORAGE")) col.storage = this.expr(COLUMN_CLAUSE);
      else if (this.accept("COLLATE")) col.collate = this.expr(COLUMN_CLAUSE);
      else if (!this.columnConstraint(col)) break;
    }
    const at2 = this.peek();
    if (at2 && !(at2.kind === "punct" && (at2.text === "," || at2.text === ")"))) this.fail("expected a column constraint, ',' or ')'");
    return col;
  }

  /**
   * A type name: `[schema.]name [(modifiers)]`, the SQL multi-word forms
   * (double precision, character varying, timestamp with time zone, interval
   * day to second ...), and array bounds. An interpolated type is one token.
   */
  typeName(): Span {
    const from = this.idx();
    const refs: number[] = [];
    const t = this.next();
    if (t.kind === "ref") refs.push(t.part);
    else if (t.kind !== "ident" && t.kind !== "qident") this.fail("expected a type", t);
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
      if (this.acceptSeq("WITH", "TIME", "ZONE") || this.acceptSeq("WITHOUT", "TIME", "ZONE")) {
        // done
      }
    } else if (first === "INTERVAL") {
      const FIELDS = ["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND"];
      if (this.accept(...FIELDS)) {
        if (this.accept("TO")) this.expect(...FIELDS);
      }
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

  /**
   * An expression span with one check the span alone cannot make: since
   * Postgres 14 removed postfix operators, an operand is never followed
   * directly by a name that is not a key word. That catches a misspelt
   * keyword after an expression (`DEFAULT 'x' CHEK (...)`) at its token.
   */
  checkedExpr(stops: readonly Stop[] = [], stopAtComma = true): Span {
    const span = this.expr(stops, stopAtComma);
    this.checkSpan(span);
    return span;
  }

  checkSpan(span: Span): void {
    let prev: Token | undefined;
    for (let i = span.from; i < span.to; i++) {
      const t = this.tokens[i]!;
      if (t.kind === "ws" || t.kind === "comment") continue;
      if (prev && prev.kind === "punct" && prev.text === "," && t.kind === "punct" && t.text === ")") this.fail("expected an expression", t);
      const operandEnd = (x: Token) =>
        x.kind === "string" ||
        x.kind === "number" ||
        x.kind === "qident" ||
        x.kind === "param" ||
        x.kind === "ref" ||
        (x.kind === "punct" && (x.text === ")" || x.text === "]")) ||
        (x.kind === "ident" && !isKeyword(x));
      // Two operands in a row: `z 0`, `(a) 'x'`. A name before a string is a typed literal (`date '2020-01-01'`).
      if (prev && operandEnd(prev) && (t.kind === "number" || t.kind === "qident" || t.kind === "param" || (t.kind === "string" && prev.kind !== "ident"))) {
        this.fail("expected an operator, a key word or the end of the expression", t);
      }
      if (prev && t.kind === "ident" && !isKeyword(t)) {
        const operand =
          prev.kind === "string" ||
          prev.kind === "number" ||
          prev.kind === "qident" ||
          prev.kind === "param" ||
          prev.kind === "ref" ||
          (prev.kind === "punct" && (prev.text === ")" || prev.text === "]")) ||
          (prev.kind === "ident" && !isKeyword(prev));
        if (operand) this.fail("expected an operator, a key word or the end of the expression", t);
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
    const push = (kind: ConstraintNode["kind"], extra: Partial<ConstraintNode> = {}) => {
      const attributes = this.constraintAttributes();
      col.constraints.push({ name, kind, columns: [], ...extra, attributes, span: this.span(from, []) });
    };
    if (this.acceptSeq("NOT", "NULL")) {
      col.notNull = true;
      this.acceptSeq("NO", "INHERIT");
      if (name) push("NOT NULL");
    } else if (this.accept("NULL")) col.notNull = false;
    else if (this.accept("DEFAULT")) col.default = this.checkedExpr(COLUMN_CLAUSE);
    else if (kw(this.peek(), "GENERATED")) {
      this.p++;
      const always = this.accept("ALWAYS") || (this.expect("BY"), this.expect("DEFAULT"), false);
      this.expect("AS");
      if (this.accept("IDENTITY")) {
        col.generated = { kind: "identity", always, options: this.isPunct("(") ? this.parenthesized() : undefined };
      } else {
        const expr = this.checkedParens();
        const kind = this.accept("VIRTUAL") ? "virtual" : (this.accept("STORED"), "stored");
        col.generated = { kind, expr, always };
      }
    } else if (this.accept("CHECK")) push("CHECK", { expr: this.checkedParens() });
    else if (this.accept("UNIQUE")) push("UNIQUE");
    else if (this.acceptSeq("PRIMARY", "KEY")) push("PRIMARY KEY");
    else if (this.accept("REFERENCES")) push("FOREIGN KEY", { references: this.references() });
    else if (name === undefined && this.constraintAttributes()) {
      // A DEFERRABLE / INITIALLY written after the constraint it qualifies; kept on the last constraint's span.
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
      if (this.accept("LIKE")) {
        node.like.push(this.expr());
      } else {
        const c = this.tableConstraint();
        if (c) node.constraints.push(c);
        else node.columns.push(this.column(typed));
      }
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      return;
    }
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

  private finish(what: string): void {
    this.acceptPunct(";");
    if (this.peek() !== undefined) this.fail(`unexpected token after the ${what}`);
  }

  /** Where a statement ends inside a multi-statement template: after its `;`. */
  finishAt(): number {
    this.acceptPunct(";");
    return this.p;
  }

  private schema(): SchemaNode {
    const node: SchemaNode = { statement: "schema", ifNotExists: this.ifNotExists() };
    if (!kw(this.peek(), "AUTHORIZATION")) node.name = this.qualifiedName("a schema name");
    if (this.accept("AUTHORIZATION")) {
      const from = this.idx();
      const t = this.next();
      node.authorization = this.span(from, t.kind === "ref" ? [t.part] : []);
    }
    if (kw(this.peek(), "CREATE", "GRANT")) this.fail("schema elements inside CREATE SCHEMA are not declared here; declare each object on its own");
    return node;
  }

  private extension(): ExtensionNode {
    const node: ExtensionNode = { statement: "extension", ifNotExists: this.ifNotExists(), name: this.qualifiedName("an extension name"), cascade: false };
    this.accept("WITH");
    for (;;) {
      if (this.accept("SCHEMA")) node.schema = this.expr(["VERSION", "CASCADE"]);
      else if (this.accept("VERSION")) node.version = this.expr(["SCHEMA", "CASCADE"]);
      else if (this.accept("CASCADE")) node.cascade = true;
      else return node;
    }
  }

  private domain(): DomainNode {
    const name = this.qualifiedName("a domain name");
    this.accept("AS");
    const STOP: Stop[] = ["COLLATE", "DEFAULT", "CONSTRAINT", "NOT", "NULL", "CHECK"];
    const node: DomainNode = { statement: "domain", name, type: this.typeName(), checks: [] };
    for (;;) {
      if (this.accept("COLLATE")) node.collate = this.expr(STOP);
      else if (this.accept("DEFAULT")) node.default = this.checkedExpr(STOP);
      else {
        let cname: string | undefined;
        if (this.accept("CONSTRAINT")) cname = this.nameTok("a constraint name").text;
        if (this.acceptSeq("NOT", "NULL")) node.notNull = true;
        else if (this.accept("NULL")) node.notNull = false;
        else if (this.accept("CHECK")) {
          const expr = this.checkedParens();
          node.checks.push({ name: cname, expr, notValid: this.acceptSeq("NOT", "VALID") || undefined });
        } else if (cname !== undefined) this.fail("expected NOT NULL, NULL or CHECK");
        else return node;
      }
    }
  }

  private enumType(): EnumNode {
    const name = this.qualifiedName("a type name");
    this.expect("AS");
    if (!this.accept("ENUM")) this.fail("expected ENUM (only enum types are declared with this tag)");
    return { statement: "enum", name, labels: this.parenList() };
  }

  private table(persistence: TableNode["persistence"]): TableNode {
    const ifNotExists = this.ifNotExists();
    const node: TableNode = {
      statement: "table",
      persistence,
      ifNotExists,
      name: this.qualifiedName("a table name"),
      columns: [],
      constraints: [],
      like: [],
    };
    if (this.accept("OF")) {
      node.ofType = this.qualifiedName("a type name");
      if (this.isPunct("(")) this.tableElements(node, false);
    } else if (this.acceptSeq("PARTITION", "OF")) {
      node.partitionOf = this.qualifiedName("a partitioned table");
      if (this.isPunct("(")) this.tableElements(node, false);
      if (this.accept("DEFAULT")) node.partitionBound = this.span(this.idx(-1), []);
      else {
        const from = this.idx();
        this.expect("FOR");
        this.expect("VALUES");
        const refs: number[] = [];
        if (this.accept("IN")) {
          if (this.isPunct(")", 1)) this.fail("expected a partition bound value", this.peek(1));
          refs.push(...this.parenthesized().refs);
        } else if (this.accept("FROM")) {
          refs.push(...this.checkedParens().refs);
          this.expect("TO");
          refs.push(...this.checkedParens().refs);
        } else if (this.accept("WITH")) {
          // (MODULUS n, REMAINDER m)
          this.expectPunct("(");
          for (const w of ["MODULUS", "REMAINDER"]) {
            if (!this.accept(w)) this.fail(`expected ${w}`);
            const t = this.next();
            if (t.kind !== "number" && t.kind !== "ref") this.fail("expected a number", t);
            if (w === "MODULUS") this.expectPunct(",");
          }
          this.expectPunct(")");
        }
        else this.fail("expected IN, FROM or WITH");
        node.partitionBound = this.span(from, refs);
      }
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
      } else if (this.accept("USING")) node.using = this.expr(["WITH", "WITHOUT", "ON", "TABLESPACE"]);
      else if (kw(this.peek(), "WITH") && this.isPunct("(", 1)) {
        this.p++;
        node.with = this.parenthesized();
      } else if (this.acceptSeq("WITHOUT", "OIDS")) continue;
      else if (this.acceptSeq("ON", "COMMIT")) node.onCommit = this.expr(["TABLESPACE"]);
      else if (this.accept("TABLESPACE")) node.tablespace = this.expr();
      else break;
    }
    return node;
  }

  private index(): IndexNode {
    const unique = this.accept("UNIQUE");
    this.expect("INDEX");
    const concurrently = this.accept("CONCURRENTLY");
    const ifNotExists = this.ifNotExists();
    const name = kw(this.peek(), "ON") && !ifNotExists ? undefined : this.qualifiedName("an index name");
    this.expect("ON");
    const only = this.accept("ONLY");
    const node: IndexNode = { statement: "index", unique, concurrently, ifNotExists, name, only, table: this.qualifiedName("a table name"), elements: [] };
    if (this.accept("USING")) node.using = this.nameTok("an access method").text;
    if (this.isPunct("(") && this.isPunct(")", 1)) this.fail("expected an index column or expression", this.peek(1));
    for (const span of this.parenList()) {
      const sig = this.tokens.slice(span.from, span.to).filter((t) => t.kind !== "ws" && t.kind !== "comment");
      const first = sig[0];
      // A column element is a bare name or reference, optionally followed by opclass / ordering words.
      const column =
        first && (first.kind === "ident" || first.kind === "qident") && sig.slice(1).every((t) => t.kind === "ident" || t.kind === "qident")
          ? identValue(first)
          : undefined;
      node.elements.push({ span, column });
    }
    for (;;) {
      if (this.accept("INCLUDE")) node.include = this.parenthesized();
      else if (this.acceptSeq("NULLS", "NOT", "DISTINCT")) node.nullsNotDistinct = true;
      else if (this.acceptSeq("NULLS", "DISTINCT")) node.nullsNotDistinct = false;
      else if (kw(this.peek(), "WITH") && this.isPunct("(", 1)) {
        this.p++;
        node.with = this.parenthesized();
      } else if (this.accept("TABLESPACE")) node.tablespace = this.expr(["WHERE"]);
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
      if (materialized && this.accept("USING")) node.using = this.expr(["WITH", "TABLESPACE", "AS"]);
      else if (kw(this.peek(), "WITH") && this.isPunct("(", 1)) {
        this.p++;
        node.with = this.parenthesized();
      } else if (materialized && this.accept("TABLESPACE")) node.tablespace = this.expr(["AS"]);
      else break;
    }
    this.expect("AS");
    const tail: Stop[] = materialized
      ? [["WITH", "DATA"], ["WITH", "NO", "DATA"]]
      : [["WITH", "CHECK", "OPTION"], ["WITH", ["CASCADED", "LOCAL"], "CHECK"]];
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
    const STOP: Stop[] = ["AS", "INCREMENT", "MINVALUE", "MAXVALUE", "NO", "START", "RESTART", "CACHE", "CYCLE", "OWNED", "SEQUENCE", "LOGGED", "UNLOGGED"];
    for (;;) {
      const t = this.peek();
      if (t === undefined || this.isPunct(";")) return node;
      if (this.accept("AS")) node.options.push({ option: "AS", value: this.expr(STOP) });
      else if (this.accept("INCREMENT")) {
        this.accept("BY");
        node.options.push({ option: "INCREMENT", value: this.expr(STOP) });
      } else if (this.acceptSeq("NO", "MINVALUE") || this.acceptSeq("NO", "MAXVALUE") || this.acceptSeq("NO", "CYCLE")) {
        node.options.push({ option: `NO ${this.tokens[this.idx(-1)]!.text.toUpperCase()}` });
      } else if (this.accept("MINVALUE", "MAXVALUE", "CACHE")) {
        node.options.push({ option: this.tokens[this.idx(-1)]!.text.toUpperCase(), value: this.expr(STOP) });
      } else if (this.accept("START")) {
        this.accept("WITH");
        node.options.push({ option: "START", value: this.expr(STOP) });
      } else if (this.accept("CYCLE")) node.options.push({ option: "CYCLE" });
      else if (this.acceptSeq("OWNED", "BY")) node.options.push({ option: "OWNED BY", value: this.expr(STOP) });
      else if (this.accept("LOGGED", "UNLOGGED")) node.options.push({ option: this.tokens[this.idx(-1)]!.text.toUpperCase() });
      else return node;
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
      if (this.peek()?.kind !== "string" && this.peek()?.kind !== "ref") this.fail("expected a string or NULL");
      node.text = this.expr([], false);
    }
    return node;
  }

  /** Parse one statement and require the end. */
  parseOne(): StatementNode {
    const node = this.parse();
    this.finish(node.statement === "comment" ? "comment" : `${node.statement} definition`);
    return node;
  }

  /** Parse statements separated by `;` until the end. */
  parseMany(): StatementNode[] {
    const out: StatementNode[] = [];
    while (this.peek() !== undefined) {
      out.push(this.parse());
      if (this.peek() !== undefined && !this.isPunct(";")) this.fail(`unexpected token after the ${out[out.length - 1]!.statement} definition`);
      this.acceptPunct(";");
    }
    return out;
  }
}

/** Parse one statement. Throws {@link SqlSyntaxError} located in the template. */
export function parseStatement(tokens: Token[]): StatementNode {
  return new PgParser(tokens).parseOne();
}

/** Parse a template that holds one CREATE followed by COMMENT ON statements for the same object. */
export function parseStatements(tokens: Token[]): StatementNode[] {
  return new PgParser(tokens).parseMany();
}

export { SqlSyntaxError };
