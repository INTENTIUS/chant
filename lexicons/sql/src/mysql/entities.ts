/**
 * The MySQL entities (#5449): `database`, `table` and `view` tagged templates
 * that parse their MySQL 8.0 DDL at fold time into one Declarable each.
 *
 * ```ts
 * import { database, table, view } from "@intentius/chant-lexicon-sql/mysql";
 *
 * export const shop = database`CREATE DATABASE shop DEFAULT CHARACTER SET utf8mb4`;
 *
 * export const users = table`
 *   CREATE TABLE ${shop}.users (
 *     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 *     email VARCHAR(255) NOT NULL,
 *     UNIQUE KEY users_email (email)
 *   ) ENGINE = InnoDB`;
 *
 * export const orders = table`
 *   CREATE TABLE ${shop}.orders (
 *     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 *     user_id BIGINT UNSIGNED NOT NULL,
 *     CONSTRAINT orders_user FOREIGN KEY (user_id) REFERENCES ${users} (${users.columns.id})
 *   )`;
 * ```
 *
 * A table holds its indexes, its foreign keys and its checks, as `SHOW CREATE
 * TABLE` prints them. The export name is the object's identity in chant; the
 * name in the SQL is its name on the server. An interpolation means what it
 * means in the other dialects (`../clickhouse/entities.ts`): an entity is a
 * reference, `entity.columns.<name>` a column reference, a string SQL text,
 * `literal(value)` a quoted string.
 */

import type { AttrRef } from "@intentius/chant/attrref";
import { setInterpolationFields } from "@intentius/chant/provenance";
import { isTrivia, MYSQL_LEXICAL, SqlSyntaxError, stringValue, unquote, untokenize, type Token } from "./tokens";
import { parseMysqlCreate, type ColumnNode, type KeyNode, type KeyPartNode, type MysqlCreateNode } from "./parser";
import { lineage, spanText as text, splice as spliceWith, templateSyntaxError, unparsedClauses, type TemplateCtx, type TemplateDialect, type UnparsedClause } from "../core/interpolation";
import type { Span } from "../core/cursor";
import { SqlObject, isColumnRefOf, isSqlObjectOf, makeSqlEntity } from "../core/entity";
import type { LineageEdge } from "../core/references";
import { SqlLiteral, SqlTemplateError, describeValue as describe, stripUnset as strip, templateParts } from "../core/template";
import type { ColumnsIn, Named, RowIn } from "../core/typed";
import { mysqlString, quoteIdent } from "./names";
import { RESERVED_WORDS } from "../generated/mysql";

export { SQL_LEXICON } from "../core/entity";
export type { LineageEdge } from "../core/references";
export type { UnparsedClause } from "../core/interpolation";
export { SqlLiteral, SqlTemplateError } from "../core/template";
export type { AnyColumn, Column, ColumnTraits, KeyColumn, Named, NotNullColumn, UncheckedColumn, Unnamed } from "../core/typed";
export { quoteIdent } from "./names";

export const MYSQL_ENTITY_TYPES = {
  database: "MySQL::Database",
  table: "MySQL::Table",
  view: "MySQL::View",
} as const;

export type MysqlEntityType = (typeof MYSQL_ENTITY_TYPES)[keyof typeof MYSQL_ENTITY_TYPES];

// ── Values ─────────────────────────────────────────────────────────────

/** A column as declared. Expressions are the source text with interpolations rendered. */
export interface ColumnDef {
  name: string;
  /** The type as written, parameters and `UNSIGNED` included: `VARCHAR(255)`, `BIGINT UNSIGNED`. */
  type: string;
  /** `NOT NULL` is false, `NULL` true; absent when the declaration says neither. */
  nullable?: boolean;
  default?: string;
  onUpdate?: string;
  autoIncrement?: boolean;
  generated?: { expr: string; stored: boolean };
  charset?: string;
  collate?: string;
  comment?: string;
  invisible?: boolean;
  srid?: string;
  columnFormat?: string;
  storage?: string;
}

/** One part of a key: a column (with a prefix length), or an expression. */
export interface KeyPartDef {
  column?: string;
  length?: number;
  expr?: string;
  desc?: boolean;
}

export interface PrimaryKeyDef {
  columns: KeyPartDef[];
  using?: string;
  comment?: string;
}

export interface IndexDef {
  kind: "unique" | "index" | "fulltext" | "spatial";
  /** Absent when the declaration leaves it to the server, which names it after its first column. */
  name?: string;
  columns: KeyPartDef[];
  using?: string;
  comment?: string;
  invisible?: boolean;
  parser?: string;
}

export interface ForeignKeyDef {
  /** Absent when the declaration leaves it to the server, which names it `<table>_ibfk_<n>`. */
  name?: string;
  columns: string[];
  /** The referenced table: the entity when it is declared, else its name as written. */
  references: MysqlObject | string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
  match?: string;
}

export interface CheckDef {
  /** Absent when the declaration leaves it to the server, which names it `<table>_chk_<n>`. */
  name?: string;
  expr: string;
  /** False for `NOT ENFORCED`; absent when enforced. */
  enforced?: boolean;
}

interface CommonProps {
  /** The object's name on the server, unquoted. */
  name: string;
  /** The statement as it will be sent: the author's text, interpolations rendered. */
  ddl: string;
  /** The template's raw parts, as written, for a source round trip. */
  source: { strings: string[] };
  /** Clauses chant's parser does not know (#3872), kept in `ddl` as written. */
  unparsed?: UnparsedClause[];
}

export interface DatabaseProps extends CommonProps {
  charset?: string;
  collate?: string;
  encryption?: string;
  ifNotExists?: boolean;
}

export interface TableProps extends CommonProps {
  /** The database it is created in, when the DDL qualifies it. */
  database?: string;
  columns: ColumnDef[];
  primaryKey?: PrimaryKeyDef;
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
  checks: CheckDef[];
  engine?: string;
  charset?: string;
  collate?: string;
  comment?: string;
  rowFormat?: string;
  /** Every other table option, by its upper-case name: `KEY_BLOCK_SIZE`, `STATS_PERSISTENT`. */
  options?: Record<string, string>;
  ifNotExists?: boolean;
}

export interface ViewProps extends CommonProps {
  database?: string;
  /** The declared column list; empty when the view takes its columns from its SELECT. */
  columns: string[];
  select: string;
  /** The tables and views the SELECT reads, as references. */
  reads: MysqlObject[];
  /** Per output column of the top-level select list, the columns it reads. */
  lineage: LineageEdge[];
  algorithm?: string;
  security?: string;
  definer?: string;
  checkOption?: "CASCADED" | "LOCAL";
  orReplace?: boolean;
}

// ── Entities ───────────────────────────────────────────────────────────

/** The members a MySQL entity has besides its props. */
export abstract class MysqlObject extends SqlObject {
  declare readonly entityType: MysqlEntityType;
  /** The name the object is referred to by in SQL: `name`, or `database.name`. */
  declare readonly sqlName: string;
}

export interface MysqlDatabase extends MysqlObject {
  readonly entityType: "MySQL::Database";
  readonly props: DatabaseProps;
}

/**
 * Every MySQL table and view the project declares, keyed by its qualified
 * name. Empty here; the `sql-types.d.ts` that `chant sql types` writes
 * augments it.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by the generated declarations
export interface SqlSchema {}

export interface MysqlRelation<N extends string = string> extends MysqlObject, Named<N> {
  /** One reference per column, by name: `${users.columns.id}`. */
  readonly columns: ColumnsIn<SqlSchema, N>;
}

export interface MysqlTable<N extends string = string> extends MysqlRelation<N> {
  readonly entityType: "MySQL::Table";
  readonly props: TableProps;
}

export interface MysqlView<N extends string = string> extends MysqlRelation<N> {
  readonly entityType: "MySQL::View";
  readonly props: ViewProps;
}

/** A declared table's or view's row, for application code. */
export type RowOf<T extends keyof SqlSchema | Named<keyof SqlSchema & string>> = RowIn<SqlSchema, T>;

export function isMysqlObject(value: unknown): value is MysqlObject {
  return isSqlObjectOf(value, "MySQL::");
}

/** A column reference: an AttrRef whose parent is a MySQL table or view. */
export function isColumnRef(value: unknown): value is AttrRef {
  return isColumnRefOf(value, isMysqlObject);
}

/**
 * A string as a quoted, escaped MySQL string literal. An interpolated plain
 * string is SQL text; wrap it in `literal()` when it is a value.
 */
export function literal(value: string | number | boolean | null): SqlLiteral {
  if (value === null) return new SqlLiteral("NULL");
  if (typeof value !== "string") return new SqlLiteral(String(value));
  return new SqlLiteral(mysqlString(value));
}

function renderReference(value: unknown): string {
  if (isMysqlObject(value)) return value.sqlName;
  if (isColumnRef(value)) return quoteIdent(value.attribute);
  throw new TypeError(`not a reference: ${describe(value)}`);
}

const RESERVED: ReadonlySet<string> = RESERVED_WORDS as ReadonlySet<string>;

/** MySQL as the shared template machinery reads it (`../core/interpolation.ts`). */
export const MYSQL_TEMPLATES: TemplateDialect = {
  lexical: MYSQL_LEXICAL,
  isObject: isMysqlObject,
  isColumnRef,
  renderReference,
  identValue: unquote,
  // MySQL names an unaliased expression's column after its text; chant has no such text for lineage.
  unnamedOutput: (n) => `_${n}`,
  lineage: {
    aliasWithoutAs: true,
    keyword: (t: Token) => (RESERVED.has(t.text.toUpperCase()) ? "reserved" : undefined),
    qualifiedRefs: true,
  },
};

type Ctx = TemplateCtx;

const req = (s: string | undefined): string => s ?? "";

/** `name` or `db.name` from a qualified-name span; an interpolated database names the database, a table or view itself. */
function qualified(ctx: Ctx, span: Span): { database?: string; name: string } {
  const pieces: string[] = [];
  for (const t of ctx.tokens.slice(span.from, span.to).filter((x) => !isTrivia(x))) {
    if (t.kind === "punct" && t.text === ".") continue;
    if (t.kind === "ref") {
      const v = ctx.values[t.part];
      if (isMysqlObject(v) && v.entityType === MYSQL_ENTITY_TYPES.database) pieces.push((v as MysqlDatabase).props.name);
      else if (isMysqlObject(v)) {
        const p = v.props as { database?: string; name: string };
        if (p.database) pieces.push(p.database);
        pieces.push(p.name);
      } else pieces.push(renderReference(v));
    } else {
      pieces.push(unquote(t.text));
      if (t.splice !== undefined) ctx.fed[t.splice]!.add("name");
    }
  }
  return pieces.length >= 2 ? { database: pieces[pieces.length - 2], name: pieces[pieces.length - 1]! } : { name: pieces[0] ?? "" };
}

/** A name span's value: a column reference's column, or the name with its backquotes off. */
function nameOf(ctx: Ctx, span: Span): string {
  const t = ctx.tokens.slice(span.from, span.to).find((x) => !isTrivia(x));
  if (!t) return "";
  if (t.kind === "ref") {
    const v = ctx.values[t.part];
    return isColumnRef(v) ? v.attribute : renderReference(v);
  }
  return unquote(t.text);
}

function keyParts(ctx: Ctx, parts: readonly KeyPartNode[], path: string): KeyPartDef[] {
  return parts.map((p) =>
    strip({
      column: p.column ? nameOf(ctx, p.column) : undefined,
      length: p.length !== undefined ? Number(p.length) : undefined,
      expr: text(ctx, p.expr, path),
      desc: p.desc,
    }),
  );
}

function columnDef(ctx: Ctx, c: ColumnNode): ColumnDef {
  // `stripUnset` drops false, and NOT NULL is `nullable: false`.
  const def = strip({
    name: c.name,
    type: req(text(ctx, c.type.span, "columns")).replace(/\s+/g, " "),
    nullable: c.nullable,
    default: text(ctx, c.default, "columns"),
    onUpdate: text(ctx, c.onUpdate, "columns"),
    autoIncrement: c.autoIncrement,
    generated: c.generated ? { expr: req(text(ctx, c.generated.expr, "columns")), stored: c.generated.stored } : undefined,
    charset: c.charset,
    collate: c.collate,
    comment: c.comment,
    invisible: c.invisible,
    srid: c.srid,
    columnFormat: c.columnFormat,
    storage: c.storage,
  }) as ColumnDef;
  return c.nullable === false ? { ...def, nullable: false } : def;
}

function indexDef(ctx: Ctx, k: KeyNode): IndexDef {
  return strip({
    kind: k.kind as IndexDef["kind"],
    name: k.name,
    columns: keyParts(ctx, k.parts, "indexes"),
    using: k.using,
    comment: k.comment,
    invisible: k.invisible,
    parser: k.parser,
  }) as IndexDef;
}

/** An option's value as written: a string's value, else the text. */
function optionText(ctx: Ctx, span: Span, path: string): string {
  const t = req(text(ctx, span, path));
  return /^'.*'$|^".*"$/s.test(t) ? stringValue(t) : t;
}

type Tag = "database" | "table" | "view";

const HOLDS: Record<MysqlCreateNode["statement"], string> = { database: "CREATE DATABASE", table: "CREATE TABLE", view: "CREATE VIEW", index: "CREATE INDEX" };

function makeEntity(entityType: MysqlEntityType, sqlName: string, props: object, columnNames: readonly string[] | undefined, dependsOn: unknown[]): MysqlObject {
  return makeSqlEntity(MysqlObject.prototype as MysqlObject, entityType, sqlName, props, columnNames, dependsOn);
}

function build(tag: Tag, strings: TemplateStringsArray | readonly string[], values: readonly unknown[]): MysqlObject {
  const parts = templateParts(strings);
  const tokens = spliceWith(MYSQL_TEMPLATES, tag, parts, values);
  let node: MysqlCreateNode;
  try {
    node = parseMysqlCreate(tokens);
  } catch (err) {
    if (!(err instanceof SqlSyntaxError)) throw err;
    throw templateSyntaxError(tag, parts, err);
  }
  if (node.statement !== tag) {
    const hint = node.statement === "index" ? "declare the index inside its table's CREATE TABLE, as KEY or UNIQUE KEY" : `use the ${node.statement} tag`;
    throw new SqlTemplateError(tag, `holds a ${HOLDS[node.statement]}; ${hint}`, 0, 0);
  }
  const ctx: Ctx = { d: MYSQL_TEMPLATES, tokens, values, fed: values.map(() => new Set<string>()) };
  for (const t of tokens) if (t.splice !== undefined) ctx.fed[t.splice]!.add("ddl");
  const { database, name } = qualified(ctx, node.name);
  const sqlName = database ? `${quoteIdent(database)}.${quoteIdent(name)}` : quoteIdent(name);
  const ddl = untokenize(tokens, (i) => renderReference(values[i])).trim().replace(/;\s*$/, "");
  const source = { strings: parts };
  const dependsOn = [...new Set(values.filter((v) => isMysqlObject(v) || isColumnRef(v)))];
  const unparsed = unparsedClauses(ctx, node.unknown);
  const done = <T extends MysqlObject>(entity: T): T => {
    setInterpolationFields(entity, ctx.fed.map((paths) => [...paths].sort()));
    return entity;
  };
  const option = (key: string, path: string): string | undefined => {
    const o = (node as { options: Array<{ key: string; value: Span }> }).options.find((x) => x.key === key);
    return o ? optionText(ctx, o.value, path) : undefined;
  };

  if (node.statement === "database") {
    const props: DatabaseProps = strip({
      name,
      charset: option("CHARSET", "charset"),
      collate: option("COLLATE", "collate"),
      encryption: option("ENCRYPTION", "encryption"),
      ifNotExists: node.ifNotExists,
      ddl,
      source,
      unparsed,
    });
    return done(makeEntity(MYSQL_ENTITY_TYPES.database, quoteIdent(name), props, undefined, dependsOn));
  }

  if (node.statement === "table") {
    const columns = node.columns.map((c) => columnDef(ctx, c));
    const indexes: IndexDef[] = [];
    let primaryKey: PrimaryKeyDef | undefined;
    for (const c of node.columns) {
      if (c.key === "primary") primaryKey = { columns: [{ column: c.name }] };
      else if (c.key === "unique") indexes.push({ kind: "unique", columns: [{ column: c.name }] });
    }
    for (const k of node.keys) {
      if (k.kind === "primary") {
        if (primaryKey) throw new SqlTemplateError(tag, "declares two primary keys", 0, 0);
        primaryKey = strip({ columns: keyParts(ctx, k.parts, "primaryKey"), using: k.using, comment: k.comment }) as PrimaryKeyDef;
      } else indexes.push(indexDef(ctx, k));
    }
    const foreignKeys: ForeignKeyDef[] = node.foreignKeys.map((f) => {
      const target = f.table.refs.length === 1 && f.table.to - f.table.from === 1 ? values[f.table.refs[0]!] : undefined;
      const references = isMysqlObject(target) ? target : req(text(ctx, f.table, "foreignKeys"));
      return strip({
        name: f.name,
        columns: f.columns.map((s) => nameOf(ctx, s)),
        references,
        refColumns: f.refColumns.map((s) => nameOf(ctx, s)),
        onDelete: f.onDelete,
        onUpdate: f.onUpdate,
        match: f.match,
      }) as ForeignKeyDef;
    });
    const checks: CheckDef[] = node.checks.map((c) => ({ ...(strip({ name: c.name, expr: req(text(ctx, c.expr, "checks")) }) as CheckDef), ...(c.enforced ? {} : { enforced: false }) }));
    const known = new Set(["ENGINE", "CHARSET", "COLLATE", "COMMENT", "ROW_FORMAT"]);
    const others = node.options.filter((o) => !known.has(o.key));
    const props: TableProps = strip({
      name,
      database,
      columns,
      primaryKey,
      indexes,
      foreignKeys,
      checks,
      engine: option("ENGINE", "engine"),
      charset: option("CHARSET", "charset"),
      collate: option("COLLATE", "collate"),
      comment: option("COMMENT", "comment"),
      rowFormat: option("ROW_FORMAT", "rowFormat"),
      options: others.length > 0 ? Object.fromEntries(others.map((o) => [o.key, optionText(ctx, o.value, "options")])) : undefined,
      ifNotExists: node.ifNotExists,
      ddl,
      source,
      unparsed,
    });
    return done(makeEntity(MYSQL_ENTITY_TYPES.table, sqlName, props, columns.map((c) => c.name), dependsOn));
  }

  {
    const lin = lineage<MysqlObject>(ctx, node.select);
    const columns = node.columns.length > 0 ? node.columns : lin.edges.map((e) => e.output);
    const props: ViewProps = strip({
      name,
      database,
      columns: node.columns,
      select: req(text(ctx, node.select, "select")),
      reads: lin.reads,
      lineage: lin.edges,
      algorithm: node.algorithm,
      security: node.security,
      definer: text(ctx, node.definer, "definer"),
      checkOption: node.checkOption,
      orReplace: node.orReplace,
      ddl,
      source,
      unparsed,
    });
    return done(makeEntity(MYSQL_ENTITY_TYPES.view, sqlName, props, columns, dependsOn));
  }
}

/** A MySQL `CREATE DATABASE` (or `CREATE SCHEMA`). */
export function database(strings: TemplateStringsArray, ...values: unknown[]): MysqlDatabase {
  return build("database", strings, values) as MysqlDatabase;
}

/** A MySQL `CREATE TABLE`, with its keys, foreign keys and checks. Give it its qualified name to type its columns. */
export function table<N extends string = string>(strings: TemplateStringsArray, ...values: unknown[]): MysqlTable<N> {
  return build("table", strings, values) as MysqlTable<N>;
}

/** A MySQL `CREATE VIEW`, with its reads and column lineage. */
export function view<N extends string = string>(strings: TemplateStringsArray, ...values: unknown[]): MysqlView<N> {
  return build("view", strings, values) as MysqlView<N>;
}

/** The entity type each tag declares, and the tag for each type. */
export const MYSQL_TAG_OF: Readonly<Record<string, Tag>> = {
  [MYSQL_ENTITY_TYPES.database]: "database",
  [MYSQL_ENTITY_TYPES.table]: "table",
  [MYSQL_ENTITY_TYPES.view]: "view",
};

/** The tag function for an entity type. */
export function mysqlTag(type: string): ((strings: TemplateStringsArray, ...values: unknown[]) => MysqlObject) | undefined {
  const tag = MYSQL_TAG_OF[type];
  return tag === "database" ? database : tag === "table" ? table : tag === "view" ? view : undefined;
}

