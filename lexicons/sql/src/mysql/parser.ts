/**
 * The MySQL 8.0 `CREATE` statements chant declares, parsed by hand into spans
 * (the shared core's cursor, `../core/cursor.ts`): `CREATE DATABASE` (and its
 * synonym `CREATE SCHEMA`), `CREATE TABLE` with its columns, keys, foreign
 * keys, checks and table options, `CREATE VIEW`, and `CREATE INDEX`, which a
 * file of DDL may hold and which becomes part of its table.
 *
 * The grammar is the reference manual's ("CREATE DATABASE Statement",
 * "CREATE TABLE Statement", "CREATE VIEW Statement", "CREATE INDEX
 * Statement"). Expressions (a default, a generated column, a check, a view's
 * SELECT) are not parsed: each is a balanced token span.
 *
 * Refused, each with the reason in the message:
 *
 * - `CREATE TEMPORARY TABLE`: a temporary table lives in one session.
 * - `CREATE TABLE ... LIKE` and `CREATE TABLE ... SELECT`: the table's
 *   definition or rows come from somewhere else at create time.
 * - `PARTITION BY`: chant does not plan partition changes.
 * - A column's own `REFERENCES`: MySQL parses it and makes no foreign key.
 * - MariaDB's own syntax, which MySQL 8.0 does not have: `CREATE OR REPLACE
 *   TABLE`, `CREATE VIEW IF NOT EXISTS`, a `PERSISTENT` generated column,
 *   `WITH SYSTEM VERSIONING`, `CREATE SEQUENCE`.
 * - Every other `CREATE` (a trigger, a routine, an event, a user): see the
 *   coverage table, `../coverage/mysql.json`.
 *
 * A clause the parser does not know is kept as written (#3872) where a
 * clause may start: among a column's attributes and among the table options.
 */

import { SqlCursor, kw, type Span, type UnknownClause } from "../core/cursor";
import type { Token } from "./tokens";
import { stringValue, unquote } from "./tokens";
import { TYPE_SPELLINGS } from "../generated/mysql";

const SPELLINGS: Readonly<Record<string, string>> = TYPE_SPELLINGS;

/** A column type as written: its canonical name, and the span of the whole type (parameters, `UNSIGNED`, `ZEROFILL`). */
export interface TypeNode {
  name: string;
  span: Span;
}

export interface CheckNode {
  name?: string;
  expr: Span;
  /** False for `NOT ENFORCED`. */
  enforced: boolean;
}

export interface ColumnNode {
  name: string;
  type: TypeNode;
  nullable?: boolean;
  /** The default as written: a literal, `CURRENT_TIMESTAMP[(n)]`, or a parenthesized expression with its parentheses. */
  default?: Span;
  onUpdate?: Span;
  autoIncrement?: boolean;
  /** `PRIMARY KEY` (or `KEY`) or `UNIQUE [KEY]` written on the column. */
  key?: "primary" | "unique";
  comment?: string;
  charset?: string;
  collate?: string;
  generated?: { expr: Span; stored: boolean };
  invisible?: boolean;
  srid?: string;
  check?: CheckNode;
  columnFormat?: string;
  storage?: string;
}

export interface KeyPartNode {
  /** The column, by name or as a column reference. */
  column?: Span;
  /** A prefix length: `name(10)`. */
  length?: string;
  /** A functional key part: `((lower(email)))`, the expression inside the parentheses. */
  expr?: Span;
  desc?: boolean;
}

export type KeyKind = "primary" | "unique" | "index" | "fulltext" | "spatial";

export interface KeyNode {
  kind: KeyKind;
  /** The index's name; a `CONSTRAINT` symbol on a primary or unique key is its name when the key has none. */
  name?: string;
  parts: KeyPartNode[];
  using?: string;
  comment?: string;
  invisible?: boolean;
  parser?: string;
  keyBlockSize?: string;
}

export interface ForeignKeyNode {
  name?: string;
  /** The index name written after `FOREIGN KEY`, which MySQL uses for the index it creates when none fits. */
  indexName?: string;
  columns: Span[];
  table: Span;
  refColumns: Span[];
  match?: string;
  onDelete?: string;
  onUpdate?: string;
}

export interface TableOption {
  /** Upper case, as the manual names it: `ENGINE`, `CHARSET`, `COLLATE`, `COMMENT`, `ROW_FORMAT`, `DATA DIRECTORY`. */
  key: string;
  value: Span;
}

export interface DatabaseNode {
  statement: "database";
  name: Span;
  ifNotExists: boolean;
  options: TableOption[];
  unknown?: UnknownClause[];
}

export interface TableNode {
  statement: "table";
  name: Span;
  ifNotExists: boolean;
  columns: ColumnNode[];
  keys: KeyNode[];
  foreignKeys: ForeignKeyNode[];
  checks: CheckNode[];
  options: TableOption[];
  unknown?: UnknownClause[];
}

export interface ViewNode {
  statement: "view";
  name: Span;
  orReplace: boolean;
  algorithm?: string;
  definer?: Span;
  security?: string;
  columns: string[];
  select: Span;
  checkOption?: "CASCADED" | "LOCAL";
  unknown?: UnknownClause[];
}

export interface IndexNode {
  statement: "index";
  key: KeyNode;
  table: Span;
  unknown?: UnknownClause[];
}

export type MysqlCreateNode = DatabaseNode | TableNode | ViewNode | IndexNode;

/** The words a column attribute may start with. */
const COLUMN_WORDS = [
  "NOT",
  "NULL",
  "DEFAULT",
  "ON",
  "AUTO_INCREMENT",
  "UNIQUE",
  "PRIMARY",
  "KEY",
  "COMMENT",
  "COLLATE",
  "CHARACTER",
  "CHARSET",
  "COLUMN_FORMAT",
  "STORAGE",
  "GENERATED",
  "AS",
  "VIRTUAL",
  "STORED",
  "VISIBLE",
  "INVISIBLE",
  "SRID",
  "CONSTRAINT",
  "CHECK",
  "REFERENCES",
  "ENGINE_ATTRIBUTE",
  "SECONDARY_ENGINE_ATTRIBUTE",
  "PERSISTENT",
];

/** Table options that take one value, besides those with a reading of their own. */
const VALUE_OPTIONS = [
  "AUTOEXTEND_SIZE",
  "AVG_ROW_LENGTH",
  "CHECKSUM",
  "COMPRESSION",
  "CONNECTION",
  "DELAY_KEY_WRITE",
  "ENCRYPTION",
  "ENGINE_ATTRIBUTE",
  "INSERT_METHOD",
  "KEY_BLOCK_SIZE",
  "MAX_ROWS",
  "MIN_ROWS",
  "PACK_KEYS",
  "PASSWORD",
  "SECONDARY_ENGINE",
  "SECONDARY_ENGINE_ATTRIBUTE",
  "STATS_AUTO_RECALC",
  "STATS_PERSISTENT",
  "STATS_SAMPLE_PAGES",
];

const TABLE_WORDS = ["ENGINE", "DEFAULT", "CHARACTER", "CHARSET", "COLLATE", "COMMENT", "AUTO_INCREMENT", "ROW_FORMAT", "DATA", "INDEX", "TABLESPACE", "UNION", "PARTITION", "START", ...VALUE_OPTIONS];

const MARIADB = "is MariaDB's, and MySQL 8.0 has no such syntax";

class MysqlParser extends SqlCursor {
  parse(): MysqlCreateNode {
    this.expect("CREATE");
    if (this.is("TEMPORARY")) this.fail("a temporary table lives in one session, and chant declares none");
    let orReplace = false;
    if (this.acceptSeq("OR", "REPLACE")) {
      if (this.is("TABLE")) this.fail(`CREATE OR REPLACE TABLE ${MARIADB}; write CREATE TABLE`);
      orReplace = true;
    }
    let algorithm: string | undefined;
    let definer: Span | undefined;
    let security: string | undefined;
    for (;;) {
      if (this.accept("ALGORITHM")) {
        this.expectPunct("=");
        algorithm = this.word(["UNDEFINED", "MERGE", "TEMPTABLE"]);
      } else if (this.accept("DEFINER")) {
        this.expectPunct("=");
        definer = this.definer();
      } else if (this.acceptSeq("SQL", "SECURITY")) {
        security = this.word(["DEFINER", "INVOKER"]);
      } else break;
    }
    if (this.accept("VIEW")) return this.view(orReplace, algorithm, definer, security);
    if (orReplace || algorithm !== undefined || definer !== undefined || security !== undefined) {
      if (!this.is("TRIGGER") && !this.is("PROCEDURE") && !this.is("FUNCTION") && !this.is("EVENT")) this.fail("expected VIEW");
      this.refuseKind();
    }
    if (this.accept("DATABASE", "SCHEMA")) return this.database();
    if (this.accept("TABLE")) return this.table();
    if (this.is("UNIQUE") || this.is("FULLTEXT") || this.is("SPATIAL") || this.is("INDEX")) return this.index();
    if (this.is("SEQUENCE")) this.fail(`CREATE SEQUENCE ${MARIADB}; MySQL numbers rows with an AUTO_INCREMENT column`);
    return this.refuseKind();
  }

  private refuseKind(): never {
    const t = this.peek();
    const what = t?.kind === "ident" ? t.text.toUpperCase() : "this";
    this.fail(`chant declares MySQL databases, tables (with their indexes) and views; a CREATE ${what} is not one of them`, t);
  }

  /** One of `words`, upper case. */
  private word(words: readonly string[]): string {
    const t = this.peek();
    if (!kw(t, ...words)) this.fail(`expected ${words.join(" or ")}`);
    this.p++;
    return t!.text.toUpperCase();
  }

  /** `user@host`, `'user'@'host'`, or `CURRENT_USER[()]`, as a span. */
  private definer(): Span {
    const from = this.idx();
    if (this.accept("CURRENT_USER")) {
      if (this.isPunct("(")) this.parenthesized();
      return this.span(from, []);
    }
    this.next();
    const at = this.peek();
    if (at?.kind === "op" && at.text === "@") {
      this.p++;
      this.next();
    }
    return this.span(from, []);
  }

  /** A name: a bare or backquoted identifier. */
  protected name(what = "a name"): string {
    const t = this.peek();
    if (!t || (t.kind !== "ident" && t.kind !== "qident")) this.fail(`expected ${what}`);
    this.p++;
    return t.kind === "qident" ? unquote(t.text) : t.text;
  }

  /** A name, a reference, or a column reference, as a span: a key part's column, a foreign key's referenced column. */
  private columnSpan(): Span {
    const from = this.idx();
    const t = this.peek();
    if (t?.kind === "ref") {
      this.p++;
      return this.span(from, [t.part]);
    }
    this.name("a column name");
    return this.span(from, []);
  }

  /** `name`, `db.name`, `${ref}` or `${db}.name`, as a span. */
  private qualified(): Span {
    const from = this.idx();
    const refs: number[] = [];
    const one = () => {
      const t = this.peek();
      if (t?.kind === "ref") {
        refs.push(t.part);
        this.p++;
      } else this.name();
    };
    one();
    if (this.acceptPunct(".")) one();
    return this.span(from, refs);
  }

  private ifNotExists(): boolean {
    return this.acceptSeq("IF", "NOT", "EXISTS");
  }

  private stringLiteral(what: string): string {
    const t = this.peek();
    if (t?.kind !== "string") this.fail(`expected ${what} as a quoted string`);
    this.p++;
    return stringValue(t.text);
  }

  /** `[=] value`: one token, or a parenthesized list. */
  private optionValue(): Span {
    this.acceptPunct("=");
    const from = this.idx();
    if (this.isPunct("(")) {
      const inner = this.parenthesized();
      return { from, to: this.idx(-1) + 1, refs: inner.refs };
    }
    const t = this.next();
    // `_utf8mb4'x'`, `b'01'`, `x'1F'`: an introducer and its string are one value.
    const after = this.peek();
    if (t.kind === "ident" && after?.kind === "string" && after.part === t.part && after.start === t.end && after.splice === t.splice) this.p++;
    return this.span(from, t.kind === "ref" ? [t.part] : []);
  }

  // ── CREATE DATABASE ────────────────────────────────────────────────

  private database(): DatabaseNode {
    const ifNotExists = this.ifNotExists();
    const name = this.qualified();
    const options: TableOption[] = [];
    while (!this.atEnd()) {
      this.accept("DEFAULT");
      if (this.acceptSeq("CHARACTER", "SET") || this.accept("CHARSET")) options.push({ key: "CHARSET", value: this.optionValue() });
      else if (this.accept("COLLATE")) options.push({ key: "COLLATE", value: this.optionValue() });
      else if (this.accept("ENCRYPTION")) options.push({ key: "ENCRYPTION", value: this.optionValue() });
      else if (this.acceptSeq("READ", "ONLY")) options.push({ key: "READ ONLY", value: this.optionValue() });
      else if (!this.unknownClause(["DEFAULT", "CHARACTER", "CHARSET", "COLLATE", "ENCRYPTION", "READ"])) this.fail("expected a database option");
    }
    return { statement: "database", name, ifNotExists, options, ...(this.unknownClauses.length > 0 ? { unknown: [...this.unknownClauses] } : {}) };
  }

  // ── CREATE TABLE ───────────────────────────────────────────────────

  private table(): TableNode {
    const ifNotExists = this.ifNotExists();
    const name = this.qualified();
    if (this.is("LIKE") || (this.isPunct("(") && kw(this.peek(1), "LIKE"))) {
      this.fail("CREATE TABLE ... LIKE copies another table's definition when it runs; declare the columns");
    }
    if (!this.isPunct("(")) this.ctas();
    this.expectPunct("(");
    const node: TableNode = { statement: "table", name, ifNotExists, columns: [], keys: [], foreignKeys: [], checks: [], options: [] };
    for (;;) {
      this.element(node);
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      break;
    }
    this.tableOptions(node);
    if (this.unknownClauses.length > 0) node.unknown = [...this.unknownClauses];
    return node;
  }

  private ctas(): never {
    this.fail("CREATE TABLE ... SELECT fills the table from a query when it runs; declare the columns, and load the rows another way");
  }

  private element(node: TableNode): void {
    let constraint: string | undefined;
    if (this.accept("CONSTRAINT")) {
      if (!this.is("PRIMARY") && !this.is("UNIQUE") && !this.is("FOREIGN") && !this.is("CHECK")) constraint = this.name("a constraint name");
    }
    if (this.acceptSeq("PRIMARY", "KEY")) {
      node.keys.push(this.keyBody("primary", undefined, constraint));
      return;
    }
    if (this.accept("UNIQUE")) {
      this.accept("INDEX", "KEY");
      node.keys.push(this.keyBody("unique", this.optionalIndexName(), constraint));
      return;
    }
    if (this.acceptSeq("FOREIGN", "KEY")) {
      node.foreignKeys.push(this.foreignKey(constraint));
      return;
    }
    if (this.accept("CHECK")) {
      node.checks.push(this.check(constraint));
      return;
    }
    if (constraint !== undefined) this.fail("expected PRIMARY KEY, UNIQUE, FOREIGN KEY or CHECK after the constraint name");
    if (this.accept("INDEX", "KEY")) {
      node.keys.push(this.keyBody("index", this.optionalIndexName()));
      return;
    }
    if (this.is("FULLTEXT") || this.is("SPATIAL")) {
      const kind = this.next().text.toLowerCase() as "fulltext" | "spatial";
      this.accept("INDEX", "KEY");
      node.keys.push(this.keyBody(kind, this.optionalIndexName()));
      return;
    }
    if (this.is("PERIOD")) this.fail(`PERIOD FOR ${MARIADB}`);
    node.columns.push(this.column(node));
  }

  /** An index name before `USING` or the key parts, when there is one. */
  private optionalIndexName(): string | undefined {
    if (this.isPunct("(") || this.is("USING")) return undefined;
    return this.name("an index name");
  }

  /** `[USING x] (parts) [options]` of a key. */
  private keyBody(kind: KeyKind, name: string | undefined, constraint?: string): KeyNode {
    const key: KeyNode = { kind, parts: [] };
    const keyName = name ?? (kind === "unique" ? constraint : undefined);
    if (keyName !== undefined) key.name = keyName;
    if (this.accept("USING")) key.using = this.word(["BTREE", "HASH"]);
    key.parts = this.keyParts();
    this.indexOptions(key);
    return key;
  }

  private keyParts(): KeyPartNode[] {
    this.expectPunct("(");
    const parts: KeyPartNode[] = [];
    for (;;) {
      const part: KeyPartNode = {};
      if (this.isPunct("(")) {
        this.p++;
        part.expr = this.expr([], false);
        this.expectPunct(")");
      } else {
        part.column = this.columnSpan();
        if (this.isPunct("(")) {
          this.p++;
          const t = this.next();
          if (t.kind !== "number") this.fail("expected a prefix length", t);
          part.length = t.text;
          this.expectPunct(")");
        }
      }
      if (this.accept("DESC")) part.desc = true;
      else this.accept("ASC");
      parts.push(part);
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      return parts;
    }
  }

  private indexOptions(key: KeyNode): void {
    for (;;) {
      if (this.accept("USING")) key.using = this.word(["BTREE", "HASH"]);
      else if (this.accept("COMMENT")) key.comment = this.stringLiteral("a comment");
      else if (this.accept("VISIBLE")) delete key.invisible;
      else if (this.accept("INVISIBLE")) key.invisible = true;
      else if (this.acceptSeq("WITH", "PARSER")) key.parser = this.name("a parser name");
      else if (this.accept("KEY_BLOCK_SIZE")) {
        this.acceptPunct("=");
        key.keyBlockSize = this.next().text;
      } else if (this.accept("ENGINE_ATTRIBUTE", "SECONDARY_ENGINE_ATTRIBUTE")) {
        this.acceptPunct("=");
        this.stringLiteral("an attribute");
      } else if (this.is("IGNORED")) this.fail(`an IGNORED index ${MARIADB}; MySQL 8.0 writes INVISIBLE`);
      else return;
    }
  }

  private foreignKey(constraint: string | undefined): ForeignKeyNode {
    const fk: ForeignKeyNode = { columns: [], table: { from: 0, to: 0, refs: [] }, refColumns: [] };
    if (constraint !== undefined) fk.name = constraint;
    if (!this.isPunct("(")) fk.indexName = this.name("an index name");
    fk.columns = this.columnList();
    this.expect("REFERENCES");
    fk.table = this.qualified();
    fk.refColumns = this.columnList();
    for (;;) {
      if (this.accept("MATCH")) fk.match = this.word(["FULL", "PARTIAL", "SIMPLE"]);
      else if (this.acceptSeq("ON", "DELETE")) fk.onDelete = this.referentialAction();
      else if (this.acceptSeq("ON", "UPDATE")) fk.onUpdate = this.referentialAction();
      else return fk;
    }
  }

  private columnList(): Span[] {
    this.expectPunct("(");
    const out: Span[] = [];
    for (;;) {
      out.push(this.columnSpan());
      if (this.acceptPunct(",")) continue;
      this.expectPunct(")");
      return out;
    }
  }

  private referentialAction(): string {
    if (this.accept("RESTRICT")) return "RESTRICT";
    if (this.accept("CASCADE")) return "CASCADE";
    if (this.acceptSeq("SET", "NULL")) return "SET NULL";
    if (this.acceptSeq("SET", "DEFAULT")) return "SET DEFAULT";
    if (this.acceptSeq("NO", "ACTION")) return "NO ACTION";
    this.fail("expected RESTRICT, CASCADE, SET NULL, SET DEFAULT or NO ACTION");
  }

  private check(name: string | undefined): CheckNode {
    this.expectPunct("(");
    const expr = this.expr([], false);
    this.expectPunct(")");
    let enforced = true;
    if (this.acceptSeq("NOT", "ENFORCED")) enforced = false;
    else this.accept("ENFORCED");
    return { ...(name !== undefined ? { name } : {}), expr, enforced };
  }

  // ── Columns ────────────────────────────────────────────────────────

  private type(): TypeNode {
    const from = this.idx();
    const first = this.peek();
    if (!first || first.kind !== "ident") this.fail("expected a column type");
    const two = kw(this.peek(1), "PRECISION", "VARYING", "VARCHAR", "VARBINARY") ? `${first.text} ${this.peek(1)!.text}`.toUpperCase() : undefined;
    let name: string | undefined;
    if (two !== undefined && SPELLINGS[two]) {
      name = SPELLINGS[two];
      this.p += 2;
    } else {
      name = SPELLINGS[first.text.toUpperCase()];
      if (name === undefined) {
        const word = first.text.toUpperCase();
        if (word === "SERIAL") this.fail("SERIAL is BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE; write those, so the declaration says what the server holds", first);
        if (word === "UUID" || word === "INET4" || word === "INET6") this.fail(`${first.text} as a column type ${MARIADB}`, first);
        this.fail(`${first.text} is not a MySQL 8.0 column type`, first);
      }
      this.p++;
    }
    if (this.isPunct("(")) this.parenthesized();
    while (this.accept("UNSIGNED", "SIGNED", "ZEROFILL"));
    return { name, span: this.span(from, []) };
  }

  /** A literal value: a string (with an introducer), a signed number, a word (`NULL`, `TRUE`), or `CURRENT_TIMESTAMP[(n)]`. */
  private literal(): Span {
    const from = this.idx();
    if (this.isPunct("(")) {
      const inner = this.parenthesized();
      return { from, to: this.idx(-1) + 1, refs: inner.refs };
    }
    const t = this.next();
    if (t.kind === "op" && (t.text === "-" || t.text === "+")) this.next();
    else if (t.kind === "ident") {
      const after = this.peek();
      if (after?.kind === "string" && after.part === t.part && after.start === t.end && after.splice === t.splice) this.p++;
      else if (this.isPunct("(") && /^(CURRENT_TIMESTAMP|NOW|LOCALTIME|LOCALTIMESTAMP)$/i.test(t.text)) this.parenthesized();
    }
    return this.span(from, t.kind === "ref" ? [t.part] : []);
  }

  private column(table: TableNode): ColumnNode {
    const name = this.name("a column name or a key");
    const column: ColumnNode = { name, type: this.type() };
    for (;;) {
      if (this.isPunct(",") || this.isPunct(")") || this.atEnd()) return column;
      if (this.acceptSeq("NOT", "NULL")) column.nullable = false;
      else if (this.accept("NULL")) column.nullable = true;
      else if (this.accept("DEFAULT")) column.default = this.literal();
      else if (this.acceptSeq("ON", "UPDATE")) column.onUpdate = this.literal();
      else if (this.accept("AUTO_INCREMENT")) column.autoIncrement = true;
      else if (this.accept("UNIQUE")) {
        this.accept("KEY");
        column.key = "unique";
      } else if (this.acceptSeq("PRIMARY", "KEY") || this.accept("KEY")) column.key = "primary";
      else if (this.accept("COMMENT")) column.comment = this.stringLiteral("a comment");
      else if (this.accept("COLLATE")) column.collate = this.name("a collation");
      else if (this.acceptSeq("CHARACTER", "SET") || this.accept("CHARSET")) column.charset = this.name("a character set");
      else if (this.accept("COLUMN_FORMAT")) column.columnFormat = this.word(["FIXED", "DYNAMIC", "DEFAULT"]);
      else if (this.accept("STORAGE")) column.storage = this.word(["DISK", "MEMORY"]);
      else if (this.acceptSeq("GENERATED", "ALWAYS", "AS") || this.accept("AS")) {
        this.expectPunct("(");
        const expr = this.expr([], false);
        this.expectPunct(")");
        if (this.is("PERSISTENT")) this.fail(`a PERSISTENT generated column ${MARIADB}; MySQL 8.0 writes STORED`);
        const stored = this.accept("STORED");
        if (!stored) this.accept("VIRTUAL");
        column.generated = { expr, stored };
      } else if (this.accept("VISIBLE")) delete column.invisible;
      else if (this.accept("INVISIBLE")) column.invisible = true;
      else if (this.accept("SRID")) column.srid = this.next().text;
      else if (this.is("CONSTRAINT") || this.is("CHECK")) {
        let checkName: string | undefined;
        if (this.accept("CONSTRAINT") && !this.is("CHECK")) checkName = this.name("a constraint name");
        this.expect("CHECK");
        table.checks.push(this.check(checkName));
      } else if (this.is("REFERENCES")) {
        this.fail("MySQL parses a column's own REFERENCES and creates no foreign key; declare it as a table element, FOREIGN KEY (column) REFERENCES ...");
      } else if (this.accept("ENGINE_ATTRIBUTE", "SECONDARY_ENGINE_ATTRIBUTE")) {
        this.acceptPunct("=");
        this.stringLiteral("an attribute");
      } else if (this.is("PERSISTENT")) this.fail(`a PERSISTENT generated column ${MARIADB}; MySQL 8.0 writes STORED`);
      else if (!this.unknownClause(COLUMN_WORDS, { inList: true, column: name })) this.fail("expected a column attribute");
    }
  }

  // ── Table options ──────────────────────────────────────────────────

  private tableOptions(node: TableNode): void {
    while (!this.atEnd()) {
      if (this.acceptPunct(",")) continue;
      if (this.is("PARTITION")) this.fail("a partitioned table is not declared: chant does not plan partition changes. Declare the table without PARTITION BY");
      if (this.is("AS") || this.is("SELECT") || this.is("IGNORE") || this.is("REPLACE") || (this.is("WITH") && kw(this.peek(1), "RECURSIVE"))) this.ctas();
      if (this.is("WITH") && kw(this.peek(1), "SYSTEM")) this.fail(`WITH SYSTEM VERSIONING ${MARIADB}`);
      if (this.is("START") && kw(this.peek(1), "TRANSACTION")) this.fail("START TRANSACTION belongs to CREATE TABLE ... SELECT, which chant does not declare");
      if (this.accept("ENGINE")) node.options.push({ key: "ENGINE", value: this.optionValue() });
      else if (this.is("DEFAULT") || this.is("CHARACTER") || this.is("CHARSET") || this.is("COLLATE")) {
        this.accept("DEFAULT");
        if (this.acceptSeq("CHARACTER", "SET") || this.accept("CHARSET")) node.options.push({ key: "CHARSET", value: this.optionValue() });
        else if (this.accept("COLLATE")) node.options.push({ key: "COLLATE", value: this.optionValue() });
        else this.fail("expected CHARACTER SET or COLLATE");
      } else if (this.accept("COMMENT")) node.options.push({ key: "COMMENT", value: this.optionValue() });
      else if (this.accept("AUTO_INCREMENT")) node.options.push({ key: "AUTO_INCREMENT", value: this.optionValue() });
      else if (this.accept("ROW_FORMAT")) node.options.push({ key: "ROW_FORMAT", value: this.optionValue() });
      else if (this.acceptSeq("DATA", "DIRECTORY")) node.options.push({ key: "DATA DIRECTORY", value: this.optionValue() });
      else if (this.acceptSeq("INDEX", "DIRECTORY")) node.options.push({ key: "INDEX DIRECTORY", value: this.optionValue() });
      else if (this.accept("TABLESPACE")) {
        node.options.push({ key: "TABLESPACE", value: this.optionValue() });
        if (this.accept("STORAGE")) this.word(["DISK", "MEMORY"]);
      } else if (this.accept("UNION")) node.options.push({ key: "UNION", value: this.optionValue() });
      else {
        const t = this.peek();
        const word = t?.kind === "ident" ? t.text.toUpperCase() : undefined;
        if (word !== undefined && VALUE_OPTIONS.includes(word)) {
          this.p++;
          node.options.push({ key: word, value: this.optionValue() });
        } else if (!this.unknownClause(TABLE_WORDS)) this.fail("expected a table option");
      }
    }
  }

  // ── CREATE VIEW ────────────────────────────────────────────────────

  private view(orReplace: boolean, algorithm: string | undefined, definer: Span | undefined, security: string | undefined): ViewNode {
    if (this.is("IF")) this.fail(`CREATE VIEW IF NOT EXISTS ${MARIADB}; write CREATE OR REPLACE VIEW, or CREATE VIEW`);
    const name = this.qualified();
    const columns: string[] = [];
    if (this.acceptPunct("(")) {
      for (;;) {
        columns.push(this.name("a column name"));
        if (this.acceptPunct(",")) continue;
        this.expectPunct(")");
        break;
      }
    }
    this.expect("AS");
    // The query runs to the end, less a closing `WITH [CASCADED | LOCAL] CHECK OPTION`.
    const from = this.idx();
    const refs: number[] = [];
    let depth = 0;
    let n = 0;
    let checkOption: ViewNode["checkOption"];
    let checkWords = 0;
    for (; ; n++) {
      const t = this.peek(n);
      if (t === undefined || (depth === 0 && t.kind === "punct" && t.text === ";")) break;
      if (depth === 0 && kw(t, "WITH")) {
        const [a, b, c] = [this.peek(n + 1), this.peek(n + 2), this.peek(n + 3)];
        if (kw(a, "CHECK") && kw(b, "OPTION")) {
          checkOption = "CASCADED";
          checkWords = 3;
          break;
        }
        if (kw(a, "CASCADED", "LOCAL") && kw(b, "CHECK") && kw(c, "OPTION")) {
          checkOption = a!.text.toUpperCase() as "CASCADED" | "LOCAL";
          checkWords = 4;
          break;
        }
      }
      depth += this.depthChange(t);
      if (t.kind === "ref") refs.push(t.part);
    }
    if (n === 0) this.fail("expected a query after AS");
    this.p += n;
    const select = this.span(from, refs);
    this.p += checkWords;
    return {
      statement: "view",
      name,
      orReplace,
      ...(algorithm !== undefined ? { algorithm } : {}),
      ...(definer !== undefined ? { definer } : {}),
      ...(security !== undefined ? { security } : {}),
      columns,
      select,
      ...(checkOption !== undefined ? { checkOption } : {}),
    };
  }

  // ── CREATE INDEX ───────────────────────────────────────────────────

  private index(): IndexNode {
    let kind: KeyKind = "index";
    if (this.accept("UNIQUE")) kind = "unique";
    else if (this.accept("FULLTEXT")) kind = "fulltext";
    else if (this.accept("SPATIAL")) kind = "spatial";
    this.expect("INDEX");
    const name = this.name("an index name");
    let using: string | undefined;
    if (this.accept("USING")) using = this.word(["BTREE", "HASH"]);
    this.expect("ON");
    const table = this.qualified();
    const key: KeyNode = { kind, name, parts: this.keyParts(), ...(using !== undefined ? { using } : {}) };
    this.indexOptions(key);
    // The online DDL clauses say how the index is built, not what it is.
    while (this.accept("ALGORITHM", "LOCK")) {
      this.acceptPunct("=");
      this.next();
    }
    if (!this.atEnd()) this.fail("expected the end of the statement");
    return { statement: "index", key, table, ...(this.unknownClauses.length > 0 ? { unknown: [...this.unknownClauses] } : {}) };
  }
}

/** Parse one MySQL `CREATE` statement chant declares. Throws a `SqlSyntaxError` at the offending token. */
export function parseMysqlCreate(tokens: Token[]): MysqlCreateNode {
  const parser = new MysqlParser(tokens);
  const node = parser.parse();
  const rest = (parser as unknown as { p: number; sig: number[] }).p;
  const sig = (parser as unknown as { sig: number[] }).sig;
  if (rest < sig.length) {
    const t = tokens[sig[rest]!]!;
    if (!(t.kind === "punct" && t.text === ";" && rest === sig.length - 1)) parser.fail("expected the end of the statement", t);
  }
  return node;
}
