/**
 * The Postgres entities: `schema`, `table`, `index`, `view`, `sequence`,
 * `type`, `domain` and `extension` tagged templates that parse their DDL at
 * fold time into one Declarable each (chant #3278, #3279).
 *
 * ```ts
 * import { schema, table, index } from "@intentius/chant-lexicon-sql/postgres";
 *
 * export const app = schema`CREATE SCHEMA app`;
 * export const users = table`
 *   CREATE TABLE ${app}.users (
 *     id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 *     email text NOT NULL UNIQUE
 *   );
 *   COMMENT ON TABLE ${app}.users IS 'One row per account'`;
 * export const usersEmail = index`CREATE INDEX users_email_idx ON ${users} (lower(${users.columns.email}))`;
 * ```
 *
 * The export name is the object's identity in chant; the name in the SQL is
 * its name in the database. An unquoted name folds to lower case, as Postgres
 * folds it, so `CREATE TABLE Users` is `users` and `.columns` is keyed by the
 * folded name.
 *
 * What an interpolation means is decided by its value, as for ClickHouse
 * (#3235):
 *
 * - a Postgres entity is a reference to that object and renders as its
 *   schema-qualified name; a schema renders as its name, so `${app}.users`
 *   reads `app.users`;
 * - `entity.columns.<name>` is a reference to one column, and renders as the
 *   column's name (write `u.${users.columns.id}` in a join);
 * - a sequence inside `nextval(...)`, `currval(...)` or `setval(...)`, and any
 *   object followed by `::regclass`, renders as a `regclass` literal:
 *   `DEFAULT nextval(${ticketSeq})` reads `nextval('app.ticket_seq'::regclass)`,
 *   which is also how the catalog prints it, and the table depends on the
 *   sequence;
 * - a string is SQL text, spliced into the statement before it is parsed;
 * - a number or bigint is a numeric literal, a boolean `true`/`false`, `null`
 *   is `NULL`;
 * - `literal(value)` is a quoted string literal (`'` doubled; a backslash is an
 *   ordinary character, since standard_conforming_strings is on).
 *
 * Postgres has no inline comment clause, so a template may follow its CREATE
 * with `COMMENT ON` statements for the same object, its columns and its
 * constraints. They fold into the entity's `comment`, each column's and each
 * constraint's, and stay in the DDL.
 */

import type { AttrRef } from "@intentius/chant/attrref";
import { setInterpolationFields } from "@intentius/chant/provenance";
import { isTrivia, POSTGRES_LEXICAL, SqlSyntaxError, untokenize, type Token } from "./tokens";
import { identValue, parseStatements, type ColumnNode, type CommentNode, type ConstraintNode, type NameNode, type Span, type StatementNode } from "./parser";
import { keywordCategory, quoteIdent } from "./keywords";
import { feed, lineage, spanText as text, splice as spliceWith, templateSyntaxError, type TemplateCtx, type TemplateDialect } from "../core/interpolation";
import { SqlObject, isColumnRefOf, isSqlObjectOf, makeSqlEntity } from "../core/entity";
import type { LineageEdge } from "../core/references";
import { SqlLiteral, SqlTemplateError, describeValue as describe, stripUnset, templateParts } from "../core/template";

export { SQL_LEXICON } from "../core/entity";
export type { LineageEdge } from "../core/references";
export { SqlLiteral, SqlTemplateError } from "../core/template";
export { quoteIdent } from "./keywords";

export const POSTGRES_ENTITY_TYPES = {
  schema: "Postgres::Schema",
  table: "Postgres::Table",
  index: "Postgres::Index",
  view: "Postgres::View",
  materializedView: "Postgres::MaterializedView",
  sequence: "Postgres::Sequence",
  enum: "Postgres::Enum",
  domain: "Postgres::Domain",
  extension: "Postgres::Extension",
} as const;

export type PostgresEntityType = (typeof POSTGRES_ENTITY_TYPES)[keyof typeof POSTGRES_ENTITY_TYPES];

// ── Values ─────────────────────────────────────────────────────────────

/** A column as declared. Expressions are the source text with interpolations rendered. */
export interface ColumnDef {
  name: string;
  /** Absent on a typed table (`OF type`) or a partition, whose columns take their type elsewhere. */
  type?: string;
  /** `NOT NULL` (true) or `NULL` (false), when written. */
  notNull?: boolean;
  /** The name given to the column's NOT NULL constraint. */
  notNullName?: string;
  default?: string;
  /** `GENERATED ALWAYS AS (expr) STORED | VIRTUAL`, or `GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [(options)]`. */
  generated?: { kind: "stored" | "virtual" | "identity"; expr?: string; always: boolean; options?: string };
  collate?: string;
  compression?: string;
  storage?: string;
  comment?: string;
}

/** Deferral attributes, on the constraints that take them. */
interface Deferral {
  deferrable?: boolean;
  initiallyDeferred?: boolean;
}

export interface KeyDef extends Deferral {
  name?: string;
  columns: string[];
  nullsNotDistinct?: boolean;
  include?: string;
  with?: string;
  comment?: string;
}

export interface CheckDef {
  name?: string;
  expr: string;
  noInherit?: boolean;
  notValid?: boolean;
  notEnforced?: boolean;
  comment?: string;
}

export interface ForeignKeyDef extends Deferral {
  name?: string;
  columns: string[];
  /** The referenced table: the entity when it is interpolated, else its name as written. */
  references: PostgresObject | string;
  /** The referenced table's SQL name, schema-qualified as written. */
  refTable: string;
  /** The referenced columns; empty means the referenced table's primary key. */
  refColumns: string[];
  match?: string;
  onDelete?: string;
  onUpdate?: string;
  notValid?: boolean;
  notEnforced?: boolean;
  comment?: string;
}

export interface ExclusionDef extends Deferral {
  name?: string;
  using?: string;
  /** The element list, `col WITH op, ...`, as written. */
  elements: string;
  where?: string;
  include?: string;
  with?: string;
  comment?: string;
}

interface CommonProps {
  /** The object's name in the database, folded as Postgres folds it. */
  name: string;
  /** The schema the DDL qualifies it with. */
  schema?: string;
  comment?: string;
  /** The statements as they will be sent: the author's text, interpolations rendered. */
  ddl: string;
  /** The template's raw parts, as written, for a source round trip. */
  source: { strings: string[] };
}

export interface SchemaProps extends Omit<CommonProps, "schema"> {
  ifNotExists?: boolean;
  authorization?: string;
}

export interface TableProps extends CommonProps {
  persistence?: "temporary" | "unlogged";
  ifNotExists?: boolean;
  /** `PARTITION OF parent`: the entity when interpolated, else its name. */
  partitionOf?: PostgresObject | string;
  partitionBound?: string;
  /** `OF type`: the entity when interpolated, else its name. */
  ofType?: PostgresObject | string;
  columns: ColumnDef[];
  primaryKey?: KeyDef;
  uniques: KeyDef[];
  checks: CheckDef[];
  foreignKeys: ForeignKeyDef[];
  exclusions: ExclusionDef[];
  /** `LIKE source [options]` clauses, as written. */
  like: string[];
  inherits: Array<PostgresObject | string>;
  partitionBy?: string;
  using?: string;
  /** Storage parameters, as written: `(fillfactor = 70)`. */
  with?: string;
  onCommit?: string;
  tablespace?: string;
}

export interface IndexProps extends CommonProps {
  /** The indexed table: the entity when interpolated, else its name. */
  table: PostgresObject | string;
  /** The indexed table's SQL name. */
  tableName: string;
  unique?: boolean;
  /** `CREATE INDEX CONCURRENTLY`: the classifier and the applier read it, since it refuses a transaction block. */
  concurrently?: boolean;
  ifNotExists?: boolean;
  only?: boolean;
  /** The access method (`btree`, `gin`, ...), when written. */
  method?: string;
  elements: Array<{ expr: string; column?: string }>;
  include?: string;
  nullsNotDistinct?: boolean;
  with?: string;
  tablespace?: string;
  where?: string;
}

export interface ViewProps extends CommonProps {
  orReplace?: boolean;
  recursive?: boolean;
  temporary?: boolean;
  ifNotExists?: boolean;
  /** The declared column list; empty when the view names its outputs in its query. */
  columns: string[];
  with?: string;
  using?: string;
  tablespace?: string;
  query: string;
  checkOption?: string;
  /** `WITH DATA` (true) or `WITH NO DATA` (false), for a materialized view. */
  withData?: boolean;
  /** The objects the query reads, as references. */
  reads: PostgresObject[];
  /** Per output column of the top-level select list, the columns it reads. */
  lineage: LineageEdge[];
  /** `COMMENT ON COLUMN` for the view's outputs. */
  columnComments?: Record<string, string>;
}

export interface SequenceProps extends CommonProps {
  persistence?: "temporary" | "unlogged";
  ifNotExists?: boolean;
  /** `AS type`: the sequence's data type. */
  dataType?: string;
  increment?: string;
  /** A value, or `null` for `NO MINVALUE`. */
  minValue?: string | null;
  maxValue?: string | null;
  start?: string;
  cache?: string;
  /** `CYCLE` (true) or `NO CYCLE` (false), when written. */
  cycle?: boolean;
  /** `OWNED BY table.column`, or `NONE`. */
  ownedBy?: string;
}

export interface EnumProps extends CommonProps {
  labels: string[];
}

export interface DomainProps extends CommonProps {
  /** The underlying data type. */
  dataType: string;
  collate?: string;
  default?: string;
  notNull?: boolean;
  checks: CheckDef[];
}

export interface ExtensionProps extends Omit<CommonProps, "schema"> {
  /** `WITH SCHEMA`: the schema the extension's objects are created in. */
  schema?: string;
  version?: string;
  cascade?: boolean;
  ifNotExists?: boolean;
}

/**
 * A string as a quoted Postgres string literal: `'` doubled, a backslash left
 * as written (standard_conforming_strings is on). An interpolated plain string
 * is SQL text; wrap it in `literal()` when it is a value.
 */
export function literal(value: string | number | boolean | null): SqlLiteral {
  if (value === null) return new SqlLiteral("NULL");
  if (typeof value !== "string") return new SqlLiteral(String(value));
  return new SqlLiteral(`'${value.replace(/'/g, "''")}'`);
}

// ── Entities ───────────────────────────────────────────────────────────

/** The members a Postgres entity has besides its props (the shared core's {@link SqlObject}). */
export abstract class PostgresObject extends SqlObject {
  declare readonly entityType: PostgresEntityType;
  /** The name the object is referred to by in SQL: `name`, or `schema.name`, quoted where Postgres needs it. */
  declare readonly sqlName: string;
}

export interface PostgresSchema extends PostgresObject {
  readonly entityType: "Postgres::Schema";
  readonly props: SchemaProps;
}

/** A table or a view: something with columns that SQL can reference. */
export interface PostgresRelation extends PostgresObject {
  /** One reference per column, by its folded name: `${users.columns.email}`. */
  readonly columns: Readonly<Record<string, AttrRef>>;
}

export interface PostgresTable extends PostgresRelation {
  readonly entityType: "Postgres::Table";
  readonly props: TableProps;
}

export interface PostgresView extends PostgresRelation {
  readonly entityType: "Postgres::View" | "Postgres::MaterializedView";
  readonly props: ViewProps;
}

export interface PostgresIndex extends PostgresObject {
  readonly entityType: "Postgres::Index";
  readonly props: IndexProps;
}

export interface PostgresSequence extends PostgresObject {
  readonly entityType: "Postgres::Sequence";
  readonly props: SequenceProps;
}

export interface PostgresEnum extends PostgresObject {
  readonly entityType: "Postgres::Enum";
  readonly props: EnumProps;
}

export interface PostgresDomain extends PostgresObject {
  readonly entityType: "Postgres::Domain";
  readonly props: DomainProps;
}

export interface PostgresExtension extends PostgresObject {
  readonly entityType: "Postgres::Extension";
  readonly props: ExtensionProps;
}

export function isPostgresObject(value: unknown): value is PostgresObject {
  return isSqlObjectOf(value, "Postgres::");
}

/** A column reference: an AttrRef whose parent is a Postgres table or view. */
export function isColumnRef(value: unknown): value is AttrRef {
  return isColumnRefOf(value, isPostgresObject);
}

// ── Rendering interpolations ───────────────────────────────────────────

function renderReference(value: unknown): string {
  if (isPostgresObject(value)) return value.sqlName;
  if (isColumnRef(value)) return quoteIdent(value.attribute);
  throw new TypeError(`not a reference: ${describe(value)}`);
}

/** A name as a `regclass` literal's text: `'app.ticket_seq'`. */
const regclassText = (sqlName: string): string => `'${sqlName.replace(/'/g, "''")}'`;

/** Functions whose first argument is a `regclass`, written as a string (`nextval('s')`). */
const REGCLASS_FUNCTIONS = ["NEXTVAL", "CURRVAL", "SETVAL"];

/**
 * Interpolations that stand where Postgres wants a `regclass` literal: the
 * first argument of `nextval`, `currval` or `setval`, rendered
 * `'name'::regclass`; and an object followed by `::regclass`, rendered
 * `'name'`. By value index.
 */
function regclassPositions(tokens: readonly Token[], values: readonly unknown[]): Map<number, "call" | "cast"> {
  const out = new Map<number, "call" | "cast">();
  const sig = tokens.filter((t) => !isTrivia(t));
  sig.forEach((t, k) => {
    if (t.kind !== "ref" || !isPostgresObject(values[t.part])) return;
    const prev = sig[k - 1];
    const fn = sig[k - 2];
    const next = sig[k + 1];
    if (
      prev?.kind === "punct" && prev.text === "(" &&
      fn?.kind === "ident" && REGCLASS_FUNCTIONS.includes(fn.text.toUpperCase()) &&
      next?.kind === "punct" && (next.text === ")" || next.text === ",")
    ) {
      out.set(t.part, "call");
    } else if (next?.kind === "op" && next.text === "::" && sig[k + 2]?.kind === "ident" && sig[k + 2]!.text.toLowerCase() === "regclass") {
      out.set(t.part, "cast");
    }
  });
  return out;
}

/**
 * The output name Postgres gives a select-list item with no alias
 * (`FigureColname` in the parser): a column's name, a function's name, a
 * cast's operand's name, `case` for a CASE, else `?column?`.
 */
function outputOf(items: readonly Token[], valueOf: (t: Token) => unknown): string | undefined {
  const sig = items.filter((t) => !isTrivia(t));
  if (sig.length === 0) return undefined;
  // `x::type` names its output after `x`.
  const cast = sig.findIndex((t) => t.kind === "op" && t.text === "::");
  const head = cast > 0 ? sig.slice(0, cast) : sig;
  const name = (t: Token): string | undefined => {
    if (t.kind === "ident" || t.kind === "qident") return identValue(t);
    const v = valueOf(t);
    return isColumnRef(v) ? v.attribute : undefined;
  };
  const first = head[0]!;
  const last = head[head.length - 1]!;
  // A column, bare or qualified: `x`, `t.x`, `${t.columns.x}`, `t.${t.columns.x}`.
  if (head.length === 1 || (head.length === 3 && head[1]!.kind === "punct" && head[1]!.text === ".")) {
    const n = name(last);
    if (n !== undefined) return n;
  }
  if (first.kind === "ident" && first.text.toUpperCase() === "CASE") return "case";
  if (first.kind === "ident" && head[1]?.kind === "punct" && head[1].text === "(") return identValue(first);
  return "?column?";
}

/** Postgres as the shared template machinery reads it (`../core/interpolation.ts`). */
export const POSTGRES_TEMPLATES: TemplateDialect = {
  lexical: POSTGRES_LEXICAL,
  isObject: isPostgresObject,
  isColumnRef,
  renderReference,
  identValue: (t) => identValue(t),
  unnamedOutput: () => "?column?",
  lineage: {
    aliasWithoutAs: true,
    keyword: (t) => {
      const k = keywordCategory(t.text);
      return k === undefined ? undefined : k === "R" ? "reserved" : "keyword";
    },
    distinctOn: true,
    qualifiedRefs: true,
    outputOf,
  },
};

// ── Building ───────────────────────────────────────────────────────────

type Ctx = TemplateCtx;

export type PostgresTag = "schema" | "table" | "index" | "view" | "sequence" | "type" | "domain" | "extension";

const STATEMENT_OF: Record<PostgresTag, StatementNode["statement"]> = {
  schema: "schema",
  table: "table",
  index: "index",
  view: "view",
  sequence: "sequence",
  type: "enum",
  domain: "domain",
  extension: "extension",
};

const TAG_OF: Record<StatementNode["statement"], PostgresTag | undefined> = {
  schema: "schema",
  table: "table",
  index: "index",
  view: "view",
  sequence: "sequence",
  enum: "type",
  domain: "domain",
  extension: "extension",
  comment: undefined,
};

/** What each statement kind is called in a message. */
export const STATEMENT_NAMES: Record<StatementNode["statement"], string> = {
  schema: "CREATE SCHEMA",
  table: "CREATE TABLE",
  index: "CREATE INDEX",
  view: "CREATE VIEW",
  sequence: "CREATE SEQUENCE",
  enum: "CREATE TYPE",
  domain: "CREATE DOMAIN",
  extension: "CREATE EXTENSION",
  comment: "COMMENT ON",
};

/** Props without their unset fields and empty optional lists, so props hold only what the DDL says. */
const strip = <T extends object>(o: T, keep: readonly string[] = []): T =>
  Object.fromEntries(
    Object.entries(stripUnset(o)).filter(([k, v]) => keep.includes(k) || !(Array.isArray(v) && v.length === 0)),
  ) as T;

const req = (s: string | undefined): string => s ?? "";

/** A string constant's value: `'...'`, `E'...'`, `$tag$...$tag$`. */
export function stringValue(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  let m = /^'(.*)'$/s.exec(s);
  if (m) return m[1]!.replace(/''/g, "'");
  m = /^[Ee]'(.*)'$/s.exec(s);
  if (m) return m[1]!.replace(/''/g, "'").replace(/\\(.)/gs, (_, c: string) => ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" })[c] ?? c);
  m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$(.*)\$\1\$$/s.exec(s);
  if (m) return m[2];
  return s;
}

/** A qualified name's schema and name. An interpolated schema names the schema; an interpolated object gives both. */
function qualified(ctx: Ctx, n: NameNode): { schema?: string; name: string } {
  const pieces: string[] = [];
  const splices: Array<number | undefined> = [];
  for (const t of ctx.tokens.slice(n.span.from, n.span.to)) {
    if (isTrivia(t) || (t.kind === "punct" && t.text === ".")) continue;
    if (t.kind === "ref") {
      const v = ctx.values[t.part];
      if (isPostgresObject(v)) {
        const p = v.props as { schema?: string; name: string };
        if (v.entityType !== POSTGRES_ENTITY_TYPES.schema && v.entityType !== POSTGRES_ENTITY_TYPES.extension && p.schema) {
          pieces.push(p.schema);
          splices.push(undefined);
        }
        pieces.push(p.name);
        splices.push(undefined);
      } else {
        pieces.push(renderReference(v));
        splices.push(undefined);
      }
    } else {
      pieces.push(identValue(t));
      splices.push(t.splice);
    }
  }
  const last = pieces.length - 1;
  splices.forEach((splice, i) => {
    if (splice !== undefined) ctx.fed[splice]!.add(i === last ? "name" : "schema");
  });
  return pieces.length >= 2 ? { schema: pieces[pieces.length - 2], name: pieces[pieces.length - 1]! } : { name: pieces[0] ?? "" };
}

const sqlNameOf = (q: { schema?: string; name: string }): string => (q.schema ? `${quoteIdent(q.schema)}.${quoteIdent(q.name)}` : quoteIdent(q.name));

/** The object a name refers to: the entity when the whole name is one interpolation, else its SQL name. */
function target(ctx: Ctx, n: NameNode): PostgresObject | string {
  const sig = ctx.tokens.slice(n.span.from, n.span.to).filter((t) => !isTrivia(t));
  if (sig.length === 1 && sig[0]!.kind === "ref") {
    const v = ctx.values[sig[0]!.part];
    if (isPostgresObject(v)) return v;
  }
  return sqlNameOf(qualified(ctx, n));
}

/** The SQL name of what a name refers to. */
const targetName = (ctx: Ctx, n: NameNode): string => {
  const t = target(ctx, n);
  return typeof t === "string" ? t : t.sqlName;
};

/** The name of a column in a key or reference list; an interpolated column reference gives its attribute. */
function columnName(ctx: Ctx, c: { name: string; span: Span }): string {
  if (c.name) return c.name;
  const t = ctx.tokens[c.span.from];
  const v = t?.kind === "ref" ? ctx.values[t.part] : undefined;
  return isColumnRef(v) ? v.attribute : req(text(ctx, c.span));
}

function columnDef(ctx: Ctx, c: ColumnNode): ColumnDef {
  for (const span of [c.nameSpan, c.type, c.default, c.collate, c.compression, c.storage, c.generated?.expr, c.generated?.options]) feed(ctx, span, "columns");
  const def: ColumnDef = { name: columnName(ctx, { name: c.name, span: c.nameSpan }) };
  const set = <K extends keyof ColumnDef>(k: K, v: ColumnDef[K] | undefined) => {
    if (v !== undefined) def[k] = v;
  };
  set("type", text(ctx, c.type));
  set("notNull", c.notNull);
  set("notNullName", c.notNullName);
  set("default", text(ctx, c.default));
  if (c.generated) {
    def.generated = stripUnset({
      kind: c.generated.kind,
      expr: text(ctx, c.generated.expr),
      always: c.generated.always,
      options: text(ctx, c.generated.options),
    });
    // `always` false is meaningful for an identity column (BY DEFAULT).
    def.generated.always = c.generated.always;
  }
  set("collate", text(ctx, c.collate));
  set("compression", text(ctx, c.compression));
  set("storage", text(ctx, c.storage));
  return def;
}

function deferral(c: ConstraintNode): Deferral {
  return stripUnset({ deferrable: c.deferrable, initiallyDeferred: c.initiallyDeferred });
}

function keyDef(ctx: Ctx, c: ConstraintNode, columns: string[], path: string): KeyDef {
  return strip(
    {
      name: c.name,
      columns,
      nullsNotDistinct: c.nullsNotDistinct,
      include: text(ctx, c.include, path),
      with: text(ctx, c.with, path),
      ...deferral(c),
    },
    ["columns"],
  );
}

function checkDef(ctx: Ctx, c: ConstraintNode): CheckDef {
  return stripUnset({
    name: c.name,
    expr: req(text(ctx, c.expr, "checks")),
    noInherit: c.noInherit,
    notValid: c.notValid,
    notEnforced: c.notEnforced,
  });
}

function foreignKeyDef(ctx: Ctx, c: ConstraintNode, columns: string[]): ForeignKeyDef {
  const r = c.references!;
  feed(ctx, r.table.span, "foreignKeys");
  return strip(
    {
      name: c.name,
      columns,
      references: target(ctx, r.table),
      refTable: targetName(ctx, r.table),
      refColumns: r.columns.map((x) => columnName(ctx, x)),
      match: r.match,
      onDelete: text(ctx, r.onDelete),
      onUpdate: text(ctx, r.onUpdate),
      notValid: c.notValid,
      notEnforced: c.notEnforced,
      ...deferral(c),
    },
    ["columns", "refColumns"],
  );
}

function exclusionDef(ctx: Ctx, c: ConstraintNode): ExclusionDef {
  return stripUnset({
    name: c.name,
    using: c.using,
    elements: req(text(ctx, c.expr, "exclusions")),
    where: text(ctx, c.where, "exclusions"),
    include: text(ctx, c.include, "exclusions"),
    with: text(ctx, c.with, "exclusions"),
    ...deferral(c),
  });
}

interface Commentable {
  comment?: string;
}

/**
 * Fold the COMMENT ON statements after the CREATE into the object they name:
 * the object itself, one of its columns, or one of its named constraints.
 * Anything else is refused, since a template declares one object.
 */
function applyComments(
  tag: PostgresTag,
  ctx: Ctx,
  comments: readonly CommentNode[],
  self: { schema?: string; name: string },
  objectTypes: readonly string[],
  parts: { columns?: Map<string, Commentable>; constraints?: Map<string, Commentable>; columnComments?: Record<string, string> } = {},
): string | undefined {
  let comment: string | undefined;
  const isSelf = (q: { schema?: string; name: string }) => q.name === self.name && (q.schema === undefined || self.schema === undefined || q.schema === self.schema);
  const refuse = (c: CommentNode, why: string): never => {
    throw new SqlTemplateError(tag, `COMMENT ON ${c.objectType} ${c.target.pieces.filter(Boolean).join(".") || "${...}"} ${why}`, 0, 0);
  };
  for (const c of comments) {
    const value = c.text ? stringValue(text(ctx, c.text, "comment")) : undefined;
    if (c.objectType === "COLUMN") {
      // `table.column` or `schema.table.column`: the last piece is the column, the rest its relation.
      const all = ctx.tokens.slice(c.target.span.from, c.target.span.to).filter((t) => !isTrivia(t) && !(t.kind === "punct" && t.text === "."));
      const last = all[all.length - 1];
      const col = last === undefined ? "" : last.kind === "ref" ? columnName(ctx, { name: "", span: { from: c.target.span.to - 1, to: c.target.span.to, refs: [] } }) : identValue(last);
      if (all.length < 2) refuse(c, "needs the relation: COMMENT ON COLUMN table.column");
      const owner = qualified(ctx, { pieces: c.target.pieces.slice(0, -1), span: { from: c.target.span.from, to: lastDot(ctx, c.target.span), refs: c.target.span.refs } });
      if (!isSelf(owner)) refuse(c, `is not a column of ${sqlNameOf(self)}`);
      if (parts.columnComments) {
        if (value !== undefined) parts.columnComments[col] = value;
        continue;
      }
      const column = parts.columns?.get(col);
      if (!column) refuse(c, `names no column of ${sqlNameOf(self)}`);
      if (value !== undefined) column!.comment = value;
      else delete column!.comment;
    } else if (c.objectType === "CONSTRAINT") {
      if (!c.on || !isSelf(qualified(ctx, c.on))) refuse(c, `is not on ${sqlNameOf(self)}`);
      const name = qualified(ctx, c.target).name;
      const constraint = parts.constraints?.get(name);
      if (!constraint) refuse(c, `names no constraint of ${sqlNameOf(self)}; a constraint commented on needs CONSTRAINT ${name} in the definition`);
      if (value !== undefined) constraint!.comment = value;
    } else {
      if (!objectTypes.includes(c.objectType)) refuse(c, `does not comment on the ${tag} this template declares`);
      if (!isSelf(qualified(ctx, c.target))) refuse(c, `names another object than ${sqlNameOf(self)}`);
      comment = value;
    }
  }
  return comment;
}

/** The token index of the last `.` in a span, so `a.b.c` without its last piece is `a.b`. */
function lastDot(ctx: Ctx, span: Span): number {
  for (let i = span.to - 1; i >= span.from; i--) {
    const t = ctx.tokens[i]!;
    if (t.kind === "punct" && t.text === ".") return i;
  }
  return span.from;
}

function build(tag: PostgresTag, strings: TemplateStringsArray | readonly string[], values: readonly unknown[]): PostgresObject {
  const parts = templateParts(strings);
  const tokens = spliceWith(POSTGRES_TEMPLATES, tag, parts, values);
  let nodes: StatementNode[];
  try {
    nodes = parseStatements(tokens);
  } catch (err) {
    if (!(err instanceof SqlSyntaxError)) throw err;
    throw templateSyntaxError(tag, parts, err);
  }
  const [node, ...rest] = nodes as [StatementNode, ...StatementNode[]];
  if (node.statement !== STATEMENT_OF[tag]) {
    const holds = STATEMENT_NAMES[node.statement];
    const use = TAG_OF[node.statement];
    throw new SqlTemplateError(tag, use ? `holds a ${holds}; use the ${use} tag` : `holds a ${holds} before any CREATE; a COMMENT ON goes after the CREATE it comments on`, 0, 0);
  }
  const stray = rest.find((n) => n.statement !== "comment");
  if (stray) throw new SqlTemplateError(tag, `holds a second statement (${STATEMENT_NAMES[stray.statement]}); a template declares one object, followed only by COMMENT ON statements for it`, 0, 0);
  const comments = rest as CommentNode[];

  const positions = regclassPositions(tokens, values);
  const render = (v: unknown, i?: number): string => {
    const at = i === undefined ? undefined : positions.get(i);
    if (at && isPostgresObject(v)) return at === "call" ? `${regclassText(v.sqlName)}::regclass` : regclassText(v.sqlName);
    return renderReference(v);
  };
  const ctx: Ctx = { d: { ...POSTGRES_TEMPLATES, renderReference: render }, tokens, values, fed: values.map(() => new Set<string>()) };
  for (const t of tokens) if (t.splice !== undefined) ctx.fed[t.splice]!.add("ddl");
  const ddl = untokenize(tokens, (i) => render(values[i], i)).trim().replace(/;\s*$/, "");
  const source = { strings: parts };
  const dependsOn = [...new Set(values.filter((v) => isPostgresObject(v) || isColumnRef(v)))];
  const make = <T extends PostgresObject>(type: PostgresEntityType, q: { schema?: string; name: string }, props: object, columnNames?: readonly string[]): T => {
    const entity = makeSqlEntity(PostgresObject.prototype as PostgresObject, type, sqlNameOf(q), props, columnNames, dependsOn) as T;
    setInterpolationFields(entity, ctx.fed.map((paths) => [...paths].sort()));
    return entity;
  };

  switch (node.statement) {
    case "schema": {
      const q = node.name ? qualified(ctx, node.name) : { name: identValue(req(text(ctx, node.authorization))) };
      if (q.schema !== undefined) throw new SqlTemplateError(tag, `a schema name is not qualified (${sqlNameOf(q)})`, 0, 0);
      const comment = applyComments(tag, ctx, comments, q, ["SCHEMA"]);
      const props: SchemaProps = stripUnset({ name: q.name, ifNotExists: node.ifNotExists, authorization: text(ctx, node.authorization, "authorization"), comment, ddl, source });
      return make(POSTGRES_ENTITY_TYPES.schema, q, props);
    }
    case "extension": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, { name: q.name }, ["EXTENSION"]);
      const schemaRef = node.schema ? text(ctx, node.schema, "schema") : undefined;
      const props: ExtensionProps = stripUnset({
        name: q.name,
        schema: schemaRef === undefined ? undefined : identValue(schemaRef),
        version: stringValue(text(ctx, node.version, "version")),
        cascade: node.cascade,
        ifNotExists: node.ifNotExists,
        comment,
        ddl,
        source,
      });
      return make(POSTGRES_ENTITY_TYPES.extension, { name: q.name }, props);
    }
    case "enum": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["TYPE"]);
      const props: EnumProps = stripUnset({ ...q, labels: node.labels.map((l) => req(stringValue(text(ctx, l, "labels")))), comment, ddl, source });
      return make(POSTGRES_ENTITY_TYPES.enum, q, props);
    }
    case "domain": {
      const q = qualified(ctx, node.name);
      const checks = node.checks.map((c) => stripUnset({ name: c.name, expr: req(text(ctx, c.expr, "checks")), notValid: c.notValid }) as CheckDef);
      const constraints = new Map<string, Commentable>(checks.filter((c) => c.name !== undefined).map((c) => [c.name!, c]));
      const comment = applyComments(tag, ctx, comments.map((c) => (c.objectType === "DOMAIN CONSTRAINT" ? { ...c, objectType: "CONSTRAINT" } : c)), q, ["DOMAIN", "TYPE"], { constraints });
      const props: DomainProps = strip(
        {
          ...q,
          dataType: req(text(ctx, node.type, "dataType")),
          collate: text(ctx, node.collate, "collate"),
          default: text(ctx, node.default, "default"),
          notNull: node.notNull,
          checks,
          comment,
          ddl,
          source,
        },
        ["checks"],
      );
      return make(POSTGRES_ENTITY_TYPES.domain, q, props);
    }
    case "sequence": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["SEQUENCE"]);
      const opt: Partial<SequenceProps> = {};
      for (const o of node.options) {
        const v = text(ctx, o.value, "options");
        switch (o.option) {
          case "AS":
            opt.dataType = v;
            break;
          case "INCREMENT":
            opt.increment = v;
            break;
          case "MINVALUE":
            opt.minValue = v;
            break;
          case "MAXVALUE":
            opt.maxValue = v;
            break;
          case "NO MINVALUE":
            opt.minValue = null;
            break;
          case "NO MAXVALUE":
            opt.maxValue = null;
            break;
          case "START":
            opt.start = v;
            break;
          case "CACHE":
            opt.cache = v;
            break;
          case "CYCLE":
            opt.cycle = true;
            break;
          case "NO CYCLE":
            opt.cycle = false;
            break;
          case "OWNED BY":
            opt.ownedBy = v;
            break;
          case "LOGGED":
          case "UNLOGGED":
            break;
        }
      }
      const props: SequenceProps = { ...stripUnset({ ...q, persistence: node.persistence, ifNotExists: node.ifNotExists }), ...opt, ...stripUnset({ comment, ddl, source }) } as SequenceProps;
      if (opt.cycle === false) props.cycle = false;
      return make(POSTGRES_ENTITY_TYPES.sequence, q, props);
    }
    case "table": {
      const q = qualified(ctx, node.name);
      const columns = node.columns.map((c) => columnDef(ctx, c));
      let primaryKey: KeyDef | undefined;
      const uniques: KeyDef[] = [];
      const checks: CheckDef[] = [];
      const foreignKeys: ForeignKeyDef[] = [];
      const exclusions: ExclusionDef[] = [];
      const file = (c: ConstraintNode, cols: string[]) => {
        if (c.kind === "FOREIGN KEY") foreignKeys.push(foreignKeyDef(ctx, c, cols));
        else if (c.kind === "PRIMARY KEY") {
          if (primaryKey) throw new SqlTemplateError(tag, `${sqlNameOf(q)} declares more than one primary key`, 0, 0);
          primaryKey = keyDef(ctx, c, cols, "primaryKey");
        } else if (c.kind === "UNIQUE") uniques.push(keyDef(ctx, c, cols, "uniques"));
        else if (c.kind === "CHECK") checks.push(checkDef(ctx, c));
        else if (c.kind === "EXCLUDE") exclusions.push(exclusionDef(ctx, c));
        else if (c.kind === "NOT NULL") {
          const col = columns.find((x) => x.name === cols[0]);
          if (!col) throw new SqlTemplateError(tag, `NOT NULL ${cols[0]} names no column of ${sqlNameOf(q)}`, 0, 0);
          col.notNull = true;
          if (c.name) col.notNullName = c.name;
        }
      };
      node.columns.forEach((c, i) => c.constraints.forEach((k) => file(k, [columns[i]!.name])));
      node.constraints.forEach((k) => file(k, k.columns.map((x) => columnName(ctx, x))));
      const named = new Map<string, Commentable>();
      for (const c of [primaryKey, ...uniques, ...checks, ...foreignKeys, ...exclusions]) if (c?.name) named.set(c.name, c);
      const comment = applyComments(tag, ctx, comments, q, ["TABLE"], { columns: new Map(columns.map((c) => [c.name, c])), constraints: named });
      const props: TableProps = strip(
        {
          ...q,
          persistence: node.persistence,
          ifNotExists: node.ifNotExists,
          partitionOf: node.partitionOf ? target(ctx, node.partitionOf) : undefined,
          partitionBound: text(ctx, node.partitionBound, "partitionBound"),
          ofType: node.ofType ? target(ctx, node.ofType) : undefined,
          columns,
          primaryKey,
          uniques,
          checks,
          foreignKeys,
          exclusions,
          like: node.like.map((l) => req(text(ctx, l, "like"))),
          inherits: (node.inherits ?? []).map((n) => target(ctx, n)),
          partitionBy: text(ctx, node.partitionBy, "partitionBy"),
          using: text(ctx, node.using, "using"),
          with: text(ctx, node.with, "with"),
          onCommit: text(ctx, node.onCommit),
          tablespace: text(ctx, node.tablespace, "tablespace"),
          comment,
          ddl,
          source,
        },
        ["columns", "uniques", "checks", "foreignKeys", "exclusions", "like", "inherits"],
      );
      return make(POSTGRES_ENTITY_TYPES.table, q, props, columns.map((c) => c.name));
    }
    case "index": {
      if (!node.name) {
        throw new SqlTemplateError(tag, "an index needs a name: the name is its identity on the server, and an unnamed index gets a generated one", 0, 0);
      }
      const tableTarget = target(ctx, node.table);
      const tq = qualified(ctx, node.table);
      const name = node.name.pieces[0] || identValue(req(text(ctx, node.name.span)));
      feed(ctx, node.name.span, "name");
      // An index lives in its table's schema.
      const q = { schema: tq.schema, name };
      const comment = applyComments(tag, ctx, comments, q, ["INDEX"]);
      const props: IndexProps = strip(
        {
          ...q,
          table: tableTarget,
          tableName: sqlNameOf(tq),
          unique: node.unique,
          concurrently: node.concurrently,
          ifNotExists: node.ifNotExists,
          only: node.only,
          method: node.using,
          elements: node.elements.map((e) => {
            const sig = tokens.slice(e.span.from, e.span.to).filter((t) => !isTrivia(t));
            const ref = sig[0]?.kind === "ref" ? values[sig[0].part] : undefined;
            const byRef = isColumnRef(ref) && sig.slice(1).every((t) => t.kind === "ident" || t.kind === "qident") ? ref.attribute : undefined;
            return stripUnset({ expr: req(text(ctx, e.span, "elements")), column: e.column ?? byRef });
          }),
          include: text(ctx, node.include, "include"),
          nullsNotDistinct: node.nullsNotDistinct,
          with: text(ctx, node.with, "with"),
          tablespace: text(ctx, node.tablespace, "tablespace"),
          where: text(ctx, node.where, "where"),
          comment,
          ddl,
          source,
        },
        ["elements"],
      );
      if (node.nullsNotDistinct === false) props.nullsNotDistinct = false;
      return make(POSTGRES_ENTITY_TYPES.index, q, props);
    }
    case "view": {
      const q = qualified(ctx, node.name);
      const lin = lineage<PostgresObject>(ctx, node.query);
      const declared = node.columnNames.map((c) => columnName(ctx, c));
      // A declared column list renames the outputs, by position.
      const edges: LineageEdge[] = lin.edges.map((e, i) => ({ ...e, output: declared[i] ?? e.output }));
      const outputs = declared.length > 0 ? declared : edges.map((e) => e.output);
      const columnComments: Record<string, string> = {};
      const comment = applyComments(tag, ctx, comments, q, node.materialized ? ["MATERIALIZED VIEW"] : ["VIEW"], { columnComments });
      const props: ViewProps = strip(
        {
          ...q,
          orReplace: node.orReplace,
          recursive: node.recursive,
          temporary: node.temporary,
          ifNotExists: node.ifNotExists,
          columns: declared,
          with: text(ctx, node.with, "with"),
          using: text(ctx, node.using, "using"),
          tablespace: text(ctx, node.tablespace, "tablespace"),
          query: req(text(ctx, node.query, "query")),
          checkOption: text(ctx, node.checkOption, "checkOption"),
          withData: node.withData,
          reads: lin.reads,
          lineage: edges,
          columnComments: Object.keys(columnComments).length > 0 ? columnComments : undefined,
          comment,
          ddl,
          source,
        },
        ["columns", "reads", "lineage"],
      );
      if (node.withData === false) props.withData = false;
      feed(ctx, node.query, "lineage");
      return make(node.materialized ? POSTGRES_ENTITY_TYPES.materializedView : POSTGRES_ENTITY_TYPES.view, q, props, outputs);
    }
    case "comment":
      throw new SqlTemplateError(tag, "a COMMENT ON goes after the CREATE it comments on", 0, 0);
  }
}

/** `` schema`CREATE SCHEMA ...` ``: one Postgres schema, parsed at build time. */
export function schema(strings: TemplateStringsArray, ...values: unknown[]): PostgresSchema {
  return build("schema", strings, values) as PostgresSchema;
}

/** `` table`CREATE TABLE ...` ``: one Postgres table with its columns and constraints, parsed at build time. */
export function table(strings: TemplateStringsArray, ...values: unknown[]): PostgresTable {
  return build("table", strings, values) as PostgresTable;
}

/** `` index`CREATE [UNIQUE] INDEX [CONCURRENTLY] name ON ...` ``: one named index. */
export function index(strings: TemplateStringsArray, ...values: unknown[]): PostgresIndex {
  return build("index", strings, values) as PostgresIndex;
}

/** `` view`CREATE [MATERIALIZED] VIEW ...` ``: one view or materialized view, with what it reads and its column lineage. */
export function view(strings: TemplateStringsArray, ...values: unknown[]): PostgresView {
  return build("view", strings, values) as PostgresView;
}

/** `` sequence`CREATE SEQUENCE ...` ``: one sequence. Reference it as `nextval(${seq})`. */
export function sequence(strings: TemplateStringsArray, ...values: unknown[]): PostgresSequence {
  return build("sequence", strings, values) as PostgresSequence;
}

/** `` type`CREATE TYPE name AS ENUM (...)` ``: one enum type. */
export function type(strings: TemplateStringsArray, ...values: unknown[]): PostgresEnum {
  return build("type", strings, values) as PostgresEnum;
}

/** `` domain`CREATE DOMAIN ...` ``: one domain. */
export function domain(strings: TemplateStringsArray, ...values: unknown[]): PostgresDomain {
  return build("domain", strings, values) as PostgresDomain;
}

/** `` extension`CREATE EXTENSION ...` ``: one extension. */
export function extension(strings: TemplateStringsArray, ...values: unknown[]): PostgresExtension {
  return build("extension", strings, values) as PostgresExtension;
}
