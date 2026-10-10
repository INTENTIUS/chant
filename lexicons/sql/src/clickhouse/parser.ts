/**
 * A hand-written recursive-descent parser for the ClickHouse statements the
 * dialect declares: `CREATE DATABASE`, `CREATE TABLE`, `CREATE VIEW`,
 * `CREATE MATERIALIZED VIEW` (chant #3196), `CREATE DICTIONARY` and
 * `CREATE FUNCTION` (#3682).
 *
 * Statement structure is parsed; expressions are not. An expression (a
 * default, a codec, a sort key, a TTL, a view's SELECT) is kept as a span of
 * tokens: its source text, verbatim, and the interpolations inside it. That is
 * what entities, references, dependency order and lineage need. Comparing
 * `INTERVAL 1 DAY` with the server's `toIntervalDay(1)` is normalization's job,
 * which asks the server.
 *
 * An interpolation (`ref` token) is accepted wherever a name, a type or an
 * expression goes. At build time the tag has already spliced plain strings into
 * the token list as SQL text, so a `ref` left here is an entity or a column
 * reference. Lint parses the source with every interpolation still a `ref`,
 * because it cannot know the values; accepting them keeps it from reporting an
 * error the build would not have.
 */

import type { Token } from "./tokens";
import { kw, SqlCursor, unquoteWith, type Span } from "../core/cursor";

export type { Span } from "../core/cursor";

export interface ColumnNode {
  /** The name as written, unquoted. Empty when the name is an interpolation. */
  name: string;
  nameSpan: Span;
  type?: Span;
  /** `NULL` / `NOT NULL` after the type. */
  nullable?: boolean;
  default?: { kind: "DEFAULT" | "MATERIALIZED" | "ALIAS" | "EPHEMERAL"; expr?: Span };
  comment?: Span;
  codec?: Span;
  ttl?: Span;
  statistics?: Span;
  settings?: Span;
  /** `PRIMARY KEY` written on the column. */
  primaryKey?: boolean;
}

export interface IndexNode {
  name: string;
  expr: Span;
  type: Span;
  granularity?: Span;
}

export interface ProjectionNode {
  name: string;
  body: Span;
}

export interface ConstraintNode {
  name: string;
  kind: "CHECK" | "ASSUME";
  expr: Span;
}

export interface StorageNode {
  engine?: { name: string; nameSpan: Span; args?: Span[]; span: Span };
  orderBy?: Span;
  primaryKey?: Span;
  partitionBy?: Span;
  sampleBy?: Span;
  ttl?: Span;
  settings?: Array<{ key: string; value: Span }>;
  /** The whole `SETTINGS ...` clause, keyword included. */
  settingsClause?: Span;
}

export interface DatabaseNode {
  statement: "database";
  ifNotExists: boolean;
  name: Span;
  onCluster?: Span;
  engine?: { name: string; nameSpan: Span; args?: Span[]; span: Span };
  settings?: Array<{ key: string; value: Span }>;
  comment?: Span;
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
  append: boolean;
  to?: Span;
  columns: ColumnNode[];
  /** The parenthesised column list, parentheses included, when there is one. */
  columnsSpan?: Span;
  populate: boolean;
  empty: boolean;
  /** `DEFINER = ...` and `SQL SECURITY ...`, as written. */
  security?: Span;
  select: Span;
  comment?: Span;
}

/** One attribute of a dictionary: `name Type [DEFAULT expr] [EXPRESSION expr] [HIERARCHICAL] [INJECTIVE] [IS_OBJECT_ID]`. */
export interface DictionaryAttributeNode {
  name: string;
  nameSpan: Span;
  type: Span;
  default?: Span;
  expression?: Span;
  /** `HIERARCHICAL`, `BIDIRECTIONAL`, `INJECTIVE`, `IS_OBJECT_ID`, upper case, as written. */
  flags: string[];
}

export interface DictionaryNode {
  statement: "dictionary";
  orReplace: boolean;
  ifNotExists: boolean;
  name: Span;
  onCluster?: Span;
  attributes: DictionaryAttributeNode[];
  /** The key columns, as written after `PRIMARY KEY`. */
  primaryKey?: Span;
  /** What is inside `SOURCE(...)`: `CLICKHOUSE(TABLE 'rates')`. */
  source?: Span;
  /** What is inside `LAYOUT(...)`: `HASHED()`. */
  layout?: Span;
  /** What is inside `LIFETIME(...)`: `300`, `MIN 0 MAX 300`. */
  lifetime?: Span;
  /** What is inside `RANGE(...)`: `MIN start MAX end`. */
  range?: Span;
  /** What is inside `SETTINGS(...)`. */
  settings?: Span;
  comment?: Span;
}

/** A SQL user-defined function: `CREATE FUNCTION name AS (x, y) -> expr`. It lives outside any database. */
export interface FunctionNode {
  statement: "function";
  orReplace: boolean;
  ifNotExists: boolean;
  name: Span;
  onCluster?: Span;
  /** The parameter names, each as written. */
  params: Array<{ name: string; span: Span }>;
  /** The whole lambda after `AS`: `(x, y) -> expr`. */
  lambda: Span;
  /** The expression after `->`. */
  body: Span;
  /** Never set: a function has no comment. Here so every node can be asked. */
  comment?: undefined;
}

export type CreateNode = DatabaseNode | TableNode | ViewNode | DictionaryNode | FunctionNode;

/** A token that can stand where a name goes. */
const isNameToken = (t: Token | undefined): boolean =>
  t !== undefined &&
  (t.kind === "ident" || t.kind === "qident" || t.kind === "ref" || (t.kind === "number" && /[A-Za-z_]/.test(t.text)));

/** A name with its `` ` `` or `"` quotes taken off. */
export const unquote = (text: string): string => unquoteWith(text, '`"');

const countOf = (text: string, c: string): number => text.split(c).length - 1;

const STORAGE_KEYWORDS = ["ENGINE", "ORDER", "PRIMARY", "PARTITION", "SAMPLE", "TTL", "SETTINGS", "COMMENT"];

class Parser extends SqlCursor {
  /** `ORDER`, `PARTITION`, `SAMPLE` and `GROUP` stop only before `BY`, `PRIMARY` only before `KEY`. */
  protected override stopsAt(stop: readonly string[]): boolean {
    if (!super.stopsAt(stop)) return false;
    const word = this.peek()!.text.toUpperCase();
    const two = ["ORDER", "PARTITION", "SAMPLE", "GROUP"].includes(word) ? kw(this.peek(1), "BY") : true;
    const key = word === "PRIMARY" ? kw(this.peek(1), "KEY") : true;
    return two && key;
  }

  /** Array and map literals: `[` and `]` arrive inside operator runs. */
  protected override depthChange(t: Token): number {
    if (t.kind === "op") return countOf(t.text, "[") + countOf(t.text, "{") - countOf(t.text, "]") - countOf(t.text, "}");
    return super.depthChange(t);
  }

  /** One name token. */
  private name(what = "a name"): { text: string; span: Span } {
    const t = this.next();
    if (!isNameToken(t)) this.fail(`expected ${what}`, t);
    const i = this.idx(-1);
    return { text: t.kind === "ref" ? "" : unquote(t.text), span: { from: i, to: i + 1, refs: t.kind === "ref" ? [t.part] : [] } };
  }

  /** A name, optionally `db.`-qualified. */
  private qualifiedName(): Span {
    const from = this.idx();
    const refs: number[] = [];
    const one = () => {
      const t = this.next();
      if (!isNameToken(t)) this.fail("expected a name", t);
      if (t.kind === "ref") refs.push(t.part);
    };
    one();
    while (this.isPunct(".")) {
      this.p++;
      one();
    }
    return this.span(from, refs);
  }

  /** `UInt64`, `Nullable(String)`, `DateTime64(3, 'UTC')`, `Tuple(a UInt8, b String)`. */
  private typeSpan(): Span {
    const from = this.idx();
    const t = this.next();
    if (t.kind !== "ident" && t.kind !== "ref") this.fail("expected a type", t);
    // `DOUBLE PRECISION`, `CHAR VARYING`, `CHAR LARGE OBJECT`: the SQL-compatible multi-word aliases.
    while (kw(this.peek(), "PRECISION", "VARYING", "UNSIGNED", "SIGNED", "LARGE", "OBJECT")) this.p++;
    if (this.isPunct("(")) this.parenthesized();
    // MySQL-compatible modifiers the server accepts and ignores, kept with the type as written.
    for (;;) {
      if (kw(this.peek(), "COLLATE") && isNameToken(this.peek(1))) this.p += 2;
      else if (kw(this.peek(), "AUTO_INCREMENT", "UNSIGNED", "SIGNED")) this.p++;
      else break;
    }
    return this.span(from, t.kind === "ref" ? [t.part] : []);
  }

  private column(typed: boolean): ColumnNode {
    const { text, span } = this.name("a column name");
    const col: ColumnNode = { name: text, nameSpan: span };
    const STOP = ["COMMENT", "CODEC", "TTL", "STATISTICS", "SETTINGS", "PRIMARY"];
    const at = this.peek();
    const bare = at === undefined || (at.kind === "punct" && (at.text === "," || at.text === ")"));
    if (!bare && !kw(at, "DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL", "NULL", "NOT", ...STOP)) {
      col.type = this.typeSpan();
    } else if (typed && bare) {
      this.fail("expected a column type");
    }
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
      else if (kw(this.peek(), "PRIMARY") && kw(this.peek(1), "KEY")) {
        this.p += 2;
        col.primaryKey = true;
      } else break;
    }
    return col;
  }

  /** True when the element starting here is `INDEX name ... TYPE ...`, not a column named `index`. */
  private looksLikeIndex(): boolean {
    if (!kw(this.peek(), "INDEX") || !isNameToken(this.peek(1))) return false;
    let depth = 0;
    for (let n = 2; ; n++) {
      const t = this.peek(n);
      if (t === undefined) return false;
      if (t.kind === "punct" && t.text === "(") depth++;
      else if (t.kind === "punct" && t.text === ")") {
        if (depth === 0) return false;
        depth--;
      } else if (depth === 0 && t.kind === "punct" && t.text === ",") return false;
      else if (depth === 0 && kw(t, "TYPE")) return true;
    }
  }

  private tableElements(node: Pick<TableNode, "columns" | "indexes" | "projections" | "constraints">, typed: boolean): void {
    this.expectPunct("(");
    for (;;) {
      if (this.looksLikeIndex()) {
        this.p++;
        const name = this.name("an index name").text;
        const expr = this.expr(["TYPE"]);
        this.expect("TYPE");
        const type = this.expr(["GRANULARITY"]);
        const granularity = this.accept("GRANULARITY") ? this.expr() : undefined;
        node.indexes.push({ name, expr, type, granularity });
      } else if (kw(this.peek(), "PROJECTION") && isNameToken(this.peek(1)) && this.isPunct("(", 2)) {
        this.p++;
        const name = this.name("a projection name").text;
        node.projections.push({ name, body: this.parenthesized() });
      } else if (kw(this.peek(), "PROJECTION") && isNameToken(this.peek(1)) && kw(this.peek(2), "INDEX")) {
        // `PROJECTION p INDEX expr TYPE basic`: a projection kept as an index.
        this.p++;
        const name = this.name("a projection name").text;
        const from = this.idx();
        this.p++;
        const expr = this.expr(["TYPE"]);
        this.expect("TYPE");
        const type = this.expr();
        node.projections.push({ name, body: { from, to: type.to, refs: [...expr.refs, ...type.refs] } });
      } else if (kw(this.peek(), "CONSTRAINT") && isNameToken(this.peek(1)) && kw(this.peek(2), "CHECK", "ASSUME")) {
        this.p++;
        const name = this.name("a constraint name").text;
        const kind = this.next().text.toUpperCase() as "CHECK" | "ASSUME";
        node.constraints.push({ name, kind, expr: this.expr() });
      } else if (kw(this.peek(), "PRIMARY") && kw(this.peek(1), "KEY")) {
        // `PRIMARY KEY (a, b)` inside the column list.
        this.p += 2;
        (node as TableNode).primaryKey = this.expr();
      } else {
        node.columns.push(this.column(typed));
      }
      // A trailing comma before the closing parenthesis is accepted, as the server accepts it.
      if (this.acceptPunct(",")) {
        if (this.acceptPunct(")")) return;
        continue;
      }
      this.expectPunct(")");
      return;
    }
  }

  private engine(): NonNullable<StorageNode["engine"]> {
    const from = this.idx(-1);
    this.acceptPunct("=");
    const { text, span } = this.name("an engine name");
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
    return { name: text, nameSpan: span, args, span: this.span(from, [...span.refs, ...(args?.flatMap((a) => a.refs) ?? [])]) };
  }

  private settingsList(stop: readonly string[]): Array<{ key: string; value: Span }> {
    const out: Array<{ key: string; value: Span }> = [];
    for (;;) {
      const key = this.name("a setting name").text;
      this.expectPunct("=");
      out.push({ key, value: this.expr(stop) });
      if (!this.acceptPunct(",")) return out;
    }
  }

  /** ENGINE and the storage clauses, in any order, as ClickHouse accepts them. */
  private storage(into: StorageNode, terminators: readonly string[]): void {
    const STOP = [...STORAGE_KEYWORDS, ...terminators];
    for (;;) {
      if (this.accept("ENGINE")) into.engine = this.engine();
      else if (kw(this.peek(), "ORDER") && kw(this.peek(1), "BY")) {
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
      } else if (this.accept("TTL")) into.ttl = this.expr(STOP, false);
      else if (kw(this.peek(), "SETTINGS")) {
        const from = this.idx();
        this.p++;
        into.settings = this.settingsList(STOP);
        into.settingsClause = this.span(from, into.settings.flatMap((s) => s.value.refs));
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
    if (this.accept("DATABASE")) return this.database();
    if (this.accept("TABLE")) return this.table(orReplace);
    if (this.accept("DICTIONARY")) return this.dictionary(orReplace);
    if (this.accept("FUNCTION")) return this.function(orReplace);
    const materialized = this.accept("MATERIALIZED");
    if (this.accept("VIEW")) return this.view(orReplace, materialized);
    return this.fail(materialized ? "expected VIEW" : "expected DATABASE, TABLE, VIEW, MATERIALIZED VIEW, DICTIONARY or FUNCTION");
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

  /** A `UUID '...'` clause after the name, as `SHOW CREATE` can print it. Skipped. */
  private uuid(): void {
    if (kw(this.peek(), "UUID") && this.peek(1)?.kind === "string") this.p += 2;
  }

  private finish(what: string): void {
    this.acceptPunct(";");
    if (this.peek() !== undefined) this.fail(`unexpected token after the ${what}`);
  }

  private database(): DatabaseNode {
    const node: DatabaseNode = { statement: "database", ifNotExists: this.ifNotExists(), name: this.qualifiedName() };
    this.uuid();
    node.onCluster = this.onCluster();
    if (this.accept("ENGINE")) node.engine = this.engine();
    if (this.accept("SETTINGS")) node.settings = this.settingsList(["COMMENT"]);
    if (this.accept("COMMENT")) node.comment = this.expr();
    this.finish("database definition");
    return node;
  }

  private table(orReplace: boolean): TableNode {
    const ifNotExists = this.ifNotExists();
    const name = this.qualifiedName();
    this.uuid();
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
    if (!this.isPunct("(")) this.fail("expected the column list (CREATE TABLE ... AS is not declared here)");
    this.tableElements(node, true);
    this.storage(node, []);
    if (this.accept("COMMENT")) node.comment = this.expr();
    this.finish("table definition");
    return node;
  }

  private dictionaryAttribute(): DictionaryAttributeNode {
    const { text, span } = this.name("an attribute name");
    const STOP = ["DEFAULT", "EXPRESSION", "HIERARCHICAL", "BIDIRECTIONAL", "INJECTIVE", "IS_OBJECT_ID"];
    const attr: DictionaryAttributeNode = { name: text, nameSpan: span, type: this.typeSpan(), flags: [] };
    for (;;) {
      if (this.accept("DEFAULT")) attr.default = this.expr(STOP);
      else if (this.accept("EXPRESSION")) attr.expression = this.expr(STOP);
      else if (kw(this.peek(), "HIERARCHICAL", "BIDIRECTIONAL", "INJECTIVE", "IS_OBJECT_ID")) attr.flags.push(this.next().text.toUpperCase());
      else return attr;
    }
  }

  private dictionary(orReplace: boolean): DictionaryNode {
    const ifNotExists = this.ifNotExists();
    const name = this.qualifiedName();
    this.uuid();
    const node: DictionaryNode = { statement: "dictionary", orReplace, ifNotExists, name, onCluster: this.onCluster(), attributes: [] };
    this.expectPunct("(");
    for (;;) {
      node.attributes.push(this.dictionaryAttribute());
      if (this.acceptPunct(",")) {
        if (this.acceptPunct(")")) break;
        continue;
      }
      this.expectPunct(")");
      break;
    }
    const CLAUSES = ["PRIMARY", "SOURCE", "LAYOUT", "LIFETIME", "RANGE", "SETTINGS", "COMMENT"];
    for (;;) {
      if (kw(this.peek(), "PRIMARY") && kw(this.peek(1), "KEY")) {
        this.p += 2;
        node.primaryKey = this.expr(CLAUSES, false);
      } else if (this.accept("SOURCE")) node.source = this.parenthesized();
      else if (this.accept("LAYOUT")) node.layout = this.parenthesized();
      else if (this.accept("LIFETIME")) node.lifetime = this.parenthesized();
      else if (this.accept("RANGE")) node.range = this.parenthesized();
      else if (this.accept("SETTINGS")) node.settings = this.parenthesized();
      else if (this.accept("COMMENT")) node.comment = this.expr();
      else break;
    }
    if (!node.primaryKey) this.fail("expected PRIMARY KEY: a dictionary needs its key columns");
    if (!node.source) this.fail("expected SOURCE(...): a dictionary needs a source");
    if (!node.layout) this.fail("expected LAYOUT(...): a dictionary needs a layout");
    this.finish("dictionary definition");
    return node;
  }

  private function(orReplace: boolean): FunctionNode {
    const ifNotExists = this.ifNotExists();
    const name = this.qualifiedName();
    if (name.to - name.from > 1 && this.tokens.slice(name.from, name.to).some((t) => t.kind === "punct" && t.text === ".")) {
      this.fail("a function belongs to no database: name it without one");
    }
    const onCluster = this.onCluster();
    this.expect("AS");
    const from = this.idx();
    const params: FunctionNode["params"] = [];
    const param = () => {
      const p = this.name("a parameter name");
      params.push({ name: p.text, span: p.span });
    };
    if (this.acceptPunct("(")) {
      if (!this.acceptPunct(")")) {
        for (;;) {
          param();
          if (this.acceptPunct(",")) continue;
          this.expectPunct(")");
          break;
        }
      }
    } else param();
    const arrow = this.next();
    if (arrow?.kind !== "op" || arrow.text !== "->") this.fail("expected -> and the function's expression", arrow);
    const body = this.expr([], false);
    const lambda = this.span(from, body.refs);
    this.finish("function definition");
    return { statement: "function", orReplace, ifNotExists, name, onCluster, params, lambda, body };
  }

  private view(orReplace: boolean, materialized: boolean): ViewNode {
    const ifNotExists = this.ifNotExists();
    const name = this.qualifiedName();
    this.uuid();
    const node: ViewNode = {
      statement: "view",
      materialized,
      orReplace,
      ifNotExists,
      name,
      onCluster: this.onCluster(),
      append: false,
      columns: [],
      populate: false,
      empty: false,
      select: { from: 0, to: 0, refs: [] },
    };
    if (this.accept("REFRESH")) node.refresh = this.expr(["TO", "ENGINE", "AS", "EMPTY", "APPEND", "DEPENDS", "SETTINGS"]);
    if (this.accept("APPEND")) node.append = true;
    if (this.accept("TO")) node.to = this.qualifiedName();
    if (this.isPunct("(")) {
      const from = this.idx();
      const holder = { columns: node.columns, indexes: [], projections: [], constraints: [] };
      this.tableElements(holder, false);
      node.columnsSpan = this.span(from, []);
    }
    this.storage(node, ["AS", "POPULATE", "EMPTY", "DEFINER", "SQL"]);
    if (this.accept("POPULATE")) node.populate = true;
    if (this.accept("EMPTY")) node.empty = true;
    if (kw(this.peek(), "DEFINER", "SQL")) node.security = this.expr(["AS"], false);
    this.expect("AS");
    node.select = this.expr(["COMMENT"], false);
    if (this.accept("COMMENT")) node.comment = this.expr();
    this.finish("view's SELECT");
    return node;
  }
}

/** Parse one CREATE statement. Throws {@link SqlSyntaxError} located in the template. */
export function parseCreate(tokens: Token[]): CreateNode {
  return new Parser(tokens).parse();
}
