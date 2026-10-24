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
import { kw, SqlCursor, unquoteWith, type Span, type UnknownClause } from "../core/cursor";

export type { Span, UnknownClause } from "../core/cursor";

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
  /** Clauses the parser does not know (#3872), kept in the DDL as written; absent when there are none. */
  unknown?: UnknownClause[];
  ifNotExists: boolean;
  name: Span;
  onCluster?: Span;
  engine?: { name: string; nameSpan: Span; args?: Span[]; span: Span };
  settings?: Array<{ key: string; value: Span }>;
  comment?: Span;
}

export interface TableNode extends StorageNode {
  statement: "table";
  /** Clauses the parser does not know (#3872), kept in the DDL as written; absent when there are none. */
  unknown?: UnknownClause[];
  orReplace: boolean;
  ifNotExists: boolean;
  name: Span;
  onCluster?: Span;
  columns: ColumnNode[];
  indexes: IndexNode[];
  projections: ProjectionNode[];
  constraints: ConstraintNode[];
  /**
   * A table over a table function (#3911): `AS numbers(10)`, `AS remote(...)`,
   * the call after `AS`. Such a table has no engine and no data of its own;
   * its column list is optional, and the server prints the one it inferred.
   */
  asFunction?: Span;
  comment?: Span;
}

export interface ViewNode extends StorageNode {
  statement: "view";
  /** Clauses the parser does not know (#3872), kept in the DDL as written; absent when there are none. */
  unknown?: UnknownClause[];
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
  /** Clauses the parser does not know (#3872), kept in the DDL as written; absent when there are none. */
  unknown?: UnknownClause[];
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
  /** Clauses the parser does not know (#3872), kept in the DDL as written; absent when there are none. */
  unknown?: UnknownClause[];
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

/**
 * Words an expression in a DDL clause holds between two operands, or right
 * after one: operators, `CASE`, `INTERVAL` and its units, a TTL's actions.
 * Any other key word right after an operand starts a new clause (#3872).
 */
const EXPRESSION_WORDS = new Set(
  (
    "AND OR NOT IN IS NULL LIKE ILIKE BETWEEN ASC DESC NULLS FIRST LAST COLLATE CASE WHEN THEN ELSE END AS INTERVAL GLOBAL ANY ALL " +
    "DISTINCT FROM TO IF EXISTS DISK VOLUME DELETE RECOMPRESS CODEC WHERE GROUP BY SET WITH FILL STEP TRUE FALSE " +
    "NANOSECOND MICROSECOND MILLISECOND SECOND MINUTE HOUR DAY WEEK MONTH QUARTER YEAR"
  ).split(" "),
);

/** The units an interval is counted in, singular and plural: what ends a refresh schedule before a column list. */
const INTERVAL_UNIT_WORDS = new Set(
  ["NANOSECOND", "MICROSECOND", "MILLISECOND", "SECOND", "MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "QUARTER", "YEAR"].flatMap((u) => [u, `${u}S`]),
);

/**
 * The `CREATE` kinds the pinned server has (26.8: `system.*` and its parser's
 * own list) that chant does not declare, each with why (#3911). A statement
 * of one is refused with that reason, by name, never as a parse error.
 */
export const REFUSED_CREATE_KINDS: ReadonlyArray<{ words: readonly string[]; kind: string; reason: string }> = [
  { words: ["LIVE", "VIEW"], kind: "LIVE VIEW", reason: "the pinned server no longer has live views (removed in 25.x); a refreshable materialized view (REFRESH EVERY ...) is the replacement" },
  {
    words: ["WINDOW", "VIEW"],
    kind: "WINDOW VIEW",
    reason: "a window view is experimental and the pinned server refuses it under the default query analyzer (allow_experimental_analyzer), so it cannot be applied as declared",
  },
  { words: ["TEMPORARY"], kind: "TEMPORARY TABLE", reason: "a temporary table lives for one session and is never in the catalog a plan reads" },
  {
    words: ["NAMED", "COLLECTION"],
    kind: "NAMED COLLECTION",
    reason:
      "a named collection holds credentials (a password, a secret key), which are the environment's and never in a build. Create it on the server, and name it where it is used: ENGINE = S3(lake_creds, format = 'Parquet'), s3(lake_creds), SOURCE(MYSQL(NAME mysql_creds)). A plan checks that it exists",
  },
  { words: ["MASKING", "POLICY"], kind: "MASKING POLICY", reason: "masking policies are available only in ClickHouse Cloud, not on the pinned server" },
  { words: ["WORKLOAD"], kind: "WORKLOAD", reason: "a workload is server-level scheduling, configured with the server, not a schema object" },
  { words: ["RESOURCE"], kind: "RESOURCE", reason: "a resource is a server-level scheduling resource (a disk's read or write), configured with the server, not a schema object" },
  { words: ["HANDLER"], kind: "HANDLER", reason: "an HTTP handler is server-level configuration, not a schema object" },
  {
    words: ["INDEX"],
    kind: "INDEX",
    reason: "a skip index belongs to its table: declare it in the table's column list (INDEX name expr TYPE type GRANULARITY n), and a plan adds or drops it with ALTER TABLE",
  },
  { words: ["UNIQUE", "INDEX"], kind: "UNIQUE INDEX", reason: "the pinned server has no unique index on its table engines; declare a skip index in the table's column list" },
  { words: ["HYPOTHETICAL", "INDEX"], kind: "HYPOTHETICAL INDEX", reason: "a hypothetical index is a session's what-if for the query planner, never stored" },
];

const STORAGE_KEYWORDS = ["ENGINE", "ORDER", "PRIMARY", "PARTITION", "SAMPLE", "TTL", "SETTINGS", "COMMENT"];

/** A column's own clause words: an unknown one stops at the next of these (#3872). */
const COLUMN_WORDS = ["DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL", "NULL", "NOT", "COMMENT", "CODEC", "TTL", "STATISTICS", "SETTINGS", "PRIMARY"];

class Parser extends SqlCursor {
  /** Where the clause-aware expression being read started (#3872); undefined outside one. */
  private clauseFrom: number | undefined;
  /** Reading a refreshable materialized view's schedule, which a column list ends. */
  private refreshing = false;

  /**
   * `ORDER`, `PARTITION`, `SAMPLE` and `GROUP` stop only before `BY`, `PRIMARY`
   * only before `KEY`. In a clause-aware expression, a clause the parser does
   * not know stops it too.
   */
  protected override stopsAt(stop: readonly string[]): boolean {
    // `REFRESH EVERY 1 HOUR (a UInt64) ENGINE ...`, as `SHOW CREATE` prints it: the column list follows the schedule.
    if (this.refreshing && this.isPunct("(") && INTERVAL_UNIT_WORDS.has(this.peek(-1)?.text.toUpperCase() ?? "")) return true;
    if (!super.stopsAt(stop)) return this.startsUnknownClause();
    const word = this.peek()!.text.toUpperCase();
    const two = ["ORDER", "PARTITION", "SAMPLE", "GROUP"].includes(word) ? kw(this.peek(1), "BY") : true;
    const key = word === "PRIMARY" ? kw(this.peek(1), "KEY") : true;
    return two && key;
  }

  /**
   * Whether a clause the parser does not know starts here, inside a
   * clause-aware expression (#3872): a bare key word right after a complete
   * operand (a name, a literal, a closing parenthesis), which no expression
   * puts side by side unless the word is one of an expression's own.
   */
  private startsUnknownClause(): boolean {
    if (this.clauseFrom === undefined || this.p <= this.clauseFrom) return false;
    const t = this.peek();
    const prev = this.peek(-1);
    if (t?.kind !== "ident" || !/^[A-Za-z_]{3,}$/.test(t.text) || EXPRESSION_WORDS.has(t.text.toUpperCase())) return false;
    if (prev === undefined) return false;
    // A query read into the expression (`ORDER BY id AS SELECT ...`, which the server takes as CREATE TABLE ... AS) is the query's, as it always was.
    for (let n = this.clauseFrom; n < this.p; n++) if (kw(this.tokens[this.sig[n]!], "SELECT")) return false;
    return (
      prev.kind === "number" ||
      prev.kind === "string" ||
      prev.kind === "qident" ||
      (prev.kind === "punct" && prev.text === ")") ||
      (prev.kind === "ident" && !EXPRESSION_WORDS.has(prev.text.toUpperCase()))
    );
  }

  /** An expression a clause the parser does not know can follow (#3872): it ends where that clause starts. */
  private clauseExpr(stop: readonly string[] = [], stopAtComma = true): Span {
    const saved = this.clauseFrom;
    this.clauseFrom = this.p;
    try {
      return this.expr(stop, stopAtComma);
    } finally {
      this.clauseFrom = saved;
    }
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
        col.default = { kind, expr: this.clauseExpr(STOP) };
      } else if (this.accept("EPHEMERAL")) {
        const t = this.peek();
        const hasExpr = t && !(t.kind === "punct" && (t.text === "," || t.text === ")")) && !kw(t, ...STOP);
        col.default = { kind: "EPHEMERAL", expr: hasExpr ? this.clauseExpr(STOP) : undefined };
      } else if (this.accept("COMMENT")) col.comment = this.clauseExpr(STOP);
      else if (this.accept("CODEC")) col.codec = this.parenthesized();
      else if (this.accept("STATISTICS")) col.statistics = this.parenthesized();
      else if (this.accept("TTL")) col.ttl = this.clauseExpr(STOP);
      else if (this.accept("SETTINGS")) col.settings = this.parenthesized();
      else if (kw(this.peek(), "PRIMARY") && kw(this.peek(1), "KEY")) {
        this.p += 2;
        col.primaryKey = true;
      } else if (!this.unknownClause(COLUMN_WORDS, { inList: true, column: text || undefined })) break;
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
      out.push({ key, value: this.clauseExpr(stop) });
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
        into.orderBy = this.clauseExpr(STOP, false);
      } else if (kw(this.peek(), "PRIMARY") && kw(this.peek(1), "KEY")) {
        this.p += 2;
        into.primaryKey = this.clauseExpr(STOP, false);
      } else if (kw(this.peek(), "PARTITION") && kw(this.peek(1), "BY")) {
        this.p += 2;
        into.partitionBy = this.clauseExpr(STOP, false);
      } else if (kw(this.peek(), "SAMPLE") && kw(this.peek(1), "BY")) {
        this.p += 2;
        into.sampleBy = this.clauseExpr(STOP, false);
      } else if (this.accept("TTL")) into.ttl = this.clauseExpr(STOP, false);
      else if (kw(this.peek(), "SETTINGS")) {
        const from = this.idx();
        this.p++;
        into.settings = this.settingsList(STOP);
        into.settingsClause = this.span(from, into.settings.flatMap((s) => s.value.refs));
      } else if (!this.unknownClause(STOP)) return;
    }
  }

  parse(): CreateNode {
    const node = this.statement();
    if (this.unknownClauses.length > 0) node.unknown = [...this.unknownClauses];
    return node;
  }

  private statement(): CreateNode {
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
    if (!materialized) {
      const refused = REFUSED_CREATE_KINDS.find((k) => k.words.every((w, i) => kw(this.peek(i), w)));
      if (refused) this.fail(`CREATE ${refused.kind} is not declared: ${refused.reason}`);
      // Access control is read by its own tags (`./access.ts`).
      const access: Array<[string[], string, string]> = [
        [["USER"], "USER", "user"],
        [["ROLE"], "ROLE", "role"],
        [["ROW", "POLICY"], "ROW POLICY", "policy"],
        [["POLICY"], "ROW POLICY", "policy"],
        [["QUOTA"], "QUOTA", "quota"],
        [["SETTINGS", "PROFILE"], "SETTINGS PROFILE", "settingsProfile"],
        [["PROFILE"], "SETTINGS PROFILE", "settingsProfile"],
      ];
      const hit = access.find(([words]) => words.every((w, i) => kw(this.peek(i), w)));
      if (hit) this.fail(`CREATE ${hit[1]} is access control: declare it with the ${hit[2]} tag`);
    }
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

  /** The statement's end, after any trailing clauses the parser does not know (#3872); `known` are the statement's own clause words. */
  private finish(what: string, known: readonly string[] = []): void {
    while (this.unknownClause(known));
    this.acceptPunct(";");
    if (this.peek() !== undefined) this.fail(`unexpected token after the ${what}`);
  }

  private database(): DatabaseNode {
    const node: DatabaseNode = { statement: "database", ifNotExists: this.ifNotExists(), name: this.qualifiedName() };
    this.uuid();
    node.onCluster = this.onCluster();
    const CLAUSES = ["ENGINE", "SETTINGS", "COMMENT"];
    for (;;) {
      // In the server's order: ENGINE, SETTINGS, COMMENT, with clauses chant does not know between them.
      if (!node.engine && !node.settings && !node.comment && this.accept("ENGINE")) node.engine = this.engine();
      else if (!node.settings && !node.comment && this.accept("SETTINGS")) node.settings = this.settingsList(CLAUSES);
      else if (!node.comment && this.accept("COMMENT")) node.comment = this.clauseExpr();
      else if (!this.unknownClause(CLAUSES)) break;
    }
    this.finish("database definition", CLAUSES);
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
    if (this.isPunct("(")) this.tableElements(node, true);
    else if (!kw(this.peek(), "AS")) this.refuseCopy();
    const asWord = this.peek();
    if (this.accept("AS")) {
      // `AS numbers(10)`: a table over a table function. `AS other` and `AS SELECT` copy, and are refused.
      if (kw(this.peek(), "SELECT", "WITH") || this.isPunct("(")) this.refuseCopy("select", asWord);
      const from = this.idx();
      this.qualifiedName();
      if (!this.isPunct("(")) this.refuseCopy("table", asWord);
      this.parenthesized();
      node.asFunction = this.span(from, this.tokens.slice(from, this.idx(-1) + 1).flatMap((t) => (t.kind === "ref" ? [t.part] : [])));
      if (this.accept("COMMENT")) node.comment = this.clauseExpr();
      if (kw(this.peek(), ...STORAGE_KEYWORDS)) this.fail("a table over a table function has no engine or storage clauses: the function is its storage");
      this.finish("table definition", ["COMMENT"]);
      return node;
    }
    this.storage(node, []);
    if (this.accept("COMMENT")) node.comment = this.clauseExpr();
    if (kw(this.peek(), "AS") && (kw(this.peek(1), "SELECT", "WITH") || this.peek(1)?.text === "(")) this.refuseCopy("select");
    this.finish("table definition", STORAGE_KEYWORDS);
    return node;
  }

  /**
   * The `CREATE TABLE` forms that copy another table or a query, refused
   * with why (#3911). Each is a one-off the server keeps no trace of: it
   * prints the copied columns and engine, or the query's result's, as if
   * they were written out.
   */
  private refuseCopy(what?: "select" | "table", at: Token | undefined = this.peek()): never {
    if (what === "select") {
      return this.fail(
        "CREATE TABLE ... AS SELECT is not declared: it creates the table and fills it once, and the server keeps the columns, not the query. Declare the table's columns and fill it with INSERT ... SELECT, or declare a materialized view",
        at,
      );
    }
    if (what === "table") {
      return this.fail(
        "CREATE TABLE ... AS <table> is not declared: the server copies the other table's columns and engine and keeps no link to it. Declare them (a composite can share them), or write AS <table function>(...) for a table over a table function",
        at,
      );
    }
    if (kw(this.peek(), "CLONE")) return this.fail("CREATE TABLE ... CLONE AS is not declared: it copies another table's columns, engine and data once. Declare the columns and engine");
    if (kw(this.peek(), "EMPTY")) return this.fail("CREATE TABLE ... EMPTY AS SELECT is not declared: the server keeps the query's columns, not the query. Declare the columns");
    return this.fail("expected the column list (a table declared without one, CREATE TABLE ... ENGINE = ... AS SELECT, is not declared: declare the columns)");
  }

  private dictionaryAttribute(): DictionaryAttributeNode {
    const { text, span } = this.name("an attribute name");
    const STOP = ["DEFAULT", "EXPRESSION", "HIERARCHICAL", "BIDIRECTIONAL", "INJECTIVE", "IS_OBJECT_ID"];
    const attr: DictionaryAttributeNode = { name: text, nameSpan: span, type: this.typeSpan(), flags: [] };
    for (;;) {
      if (this.accept("DEFAULT")) attr.default = this.clauseExpr(STOP);
      else if (this.accept("EXPRESSION")) attr.expression = this.clauseExpr(STOP);
      else if (kw(this.peek(), "HIERARCHICAL", "BIDIRECTIONAL", "INJECTIVE", "IS_OBJECT_ID")) attr.flags.push(this.next().text.toUpperCase());
      else if (!this.unknownClause(STOP, { inList: true, column: text || undefined })) return attr;
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
        node.primaryKey = this.clauseExpr(CLAUSES, false);
      } else if (this.accept("SOURCE")) node.source = this.parenthesized();
      else if (this.accept("LAYOUT")) node.layout = this.parenthesized();
      else if (this.accept("LIFETIME")) node.lifetime = this.parenthesized();
      else if (this.accept("RANGE")) node.range = this.parenthesized();
      else if (this.accept("SETTINGS")) node.settings = this.parenthesized();
      else if (this.accept("COMMENT")) node.comment = this.clauseExpr();
      else if (!this.unknownClause(CLAUSES)) break;
    }
    if (!node.primaryKey) this.fail("expected PRIMARY KEY: a dictionary needs its key columns");
    if (!node.source) this.fail("expected SOURCE(...): a dictionary needs a source");
    if (!node.layout) this.fail("expected LAYOUT(...): a dictionary needs a layout");
    this.finish("dictionary definition", CLAUSES);
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
    if (this.accept("REFRESH")) {
      this.refreshing = true;
      try {
        node.refresh = this.expr(["TO", "ENGINE", "AS", "EMPTY", "APPEND", "DEPENDS", "SETTINGS"]);
      } finally {
        this.refreshing = false;
      }
    }
    if (this.accept("APPEND")) node.append = true;
    if (this.accept("TO")) node.to = this.qualifiedName();
    if (this.isPunct("(")) {
      const from = this.idx();
      const holder = { columns: node.columns, indexes: [], projections: [], constraints: [] };
      this.tableElements(holder, false);
      node.columnsSpan = this.span(from, []);
    }
    const BEFORE_AS = ["AS", "POPULATE", "EMPTY", "DEFINER", "SQL"];
    this.storage(node, BEFORE_AS);
    if (this.accept("POPULATE")) node.populate = true;
    if (this.accept("EMPTY")) node.empty = true;
    if (kw(this.peek(), "DEFINER", "SQL")) node.security = this.expr(["AS"], false);
    while (!kw(this.peek(), "AS") && this.unknownClause([...STORAGE_KEYWORDS, ...BEFORE_AS]));
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
