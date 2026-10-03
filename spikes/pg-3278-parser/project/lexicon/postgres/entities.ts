/**
 * Spike (#3278): the Postgres tags. Each parses its DDL at build time into one
 * Declarable, with the same interpolation rules as ClickHouse (#3235): an
 * entity renders as its name, `x.columns.c` as the column's name, a string is
 * SQL text, a number / boolean / null a literal, `literal()` a quoted string.
 *
 * ```ts
 * export const users = table`CREATE TABLE users (id bigint PRIMARY KEY, email text NOT NULL)`;
 * export const orders = table`
 *   CREATE TABLE orders (
 *     id bigint PRIMARY KEY,
 *     user_id bigint NOT NULL REFERENCES ${users} (${users.columns.id}))`;
 * export const ordersUser = index`CREATE INDEX orders_user_id_idx ON ${orders} (${orders.columns.user_id})`;
 * ```
 *
 * Postgres has no inline COMMENT clause, so a template may follow its CREATE
 * with COMMENT ON statements for the same object (and its columns); they fold
 * into the entity's `comment` and each column's.
 */

import type { AttrRef } from "@intentius/chant/attrref";
import {
  isColumnRefOf,
  lineage,
  makeEntity,
  splice,
  SqlLiteral,
  SqlObject,
  SqlSyntaxError,
  SqlTemplateError,
  templateParts,
  templateSyntaxError,
  text,
  untokenize,
  type Ctx,
  type Dialect,
  type LineageEdge,
} from "../core/template";
import { POSTGRES_LEXICAL, type Token } from "../core/tokens";
import {
  identValue,
  parseStatements,
  type ColumnNode,
  type CommentNode,
  type ConstraintNode,
  type NameNode,
  type StatementNode,
} from "./parser";

export const PG = {
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

export abstract class PostgresObject extends SqlObject {}

export interface PostgresRelation extends PostgresObject {
  readonly columns: Readonly<Record<string, AttrRef>>;
}

/** Structural, as ClickHouse's isClickHouseObject: survives the lexicon module being loaded twice. */
export function isPostgresObject(value: unknown): value is PostgresObject {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PostgresObject).lexicon === "sql" &&
    typeof (value as PostgresObject).sqlName === "string" &&
    typeof (value as PostgresObject).entityType === "string" &&
    (value as PostgresObject).entityType.startsWith("Postgres::")
  );
}

/**
 * Reserved key words (Postgres 18, Appendix C, "reserved" and "reserved (can be
 * function or type)"). The slice would generate this from pg_get_keywords()
 * at the #3277 pin.
 */
const RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column " +
    "concurrently constraint create cross current_catalog current_date current_role current_schema current_time " +
    "current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze " +
    "from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit " +
    "localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references " +
    "returning right select session_user similar some symmetric system_user table tablesample then to trailing true union " +
    "unique user using variadic verbose when where window with"
  ).split(" "),
);

/** A name as Postgres reads it back: bare when it is lower case and not reserved, double-quoted otherwise. */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export const POSTGRES: Dialect = {
  name: "postgres",
  lexical: POSTGRES_LEXICAL,
  isObject: isPostgresObject,
  renderReference(value) {
    if (isPostgresObject(value)) return value.sqlName;
    if (isColumnRefOf(POSTGRES, value)) return quoteIdent(value.attribute);
    throw new TypeError("not a reference");
  },
  identValue,
  // standard_conforming_strings is on: a backslash is an ordinary character in '...'.
  quoteLiteral: (v) => `'${v.replace(/'/g, "''")}'`,
};

export function literal(value: string | number | boolean | null): SqlLiteral {
  if (value === null) return new SqlLiteral("NULL");
  if (typeof value !== "string") return new SqlLiteral(String(value));
  return new SqlLiteral(POSTGRES.quoteLiteral(value));
}

export const isColumnRef = (v: unknown): v is AttrRef => isColumnRefOf(POSTGRES, v);

// ── Props ────────────────────────────────────────────────────────────

export interface ColumnDef {
  name: string;
  type?: string;
  notNull?: boolean;
  default?: string;
  generated?: { kind: "stored" | "virtual" | "identity"; expr?: string; always?: boolean; options?: string };
  collate?: string;
  comment?: string;
}

export interface ForeignKeyDef {
  name?: string;
  columns: string[];
  /** The referenced table: the entity when it is interpolated, else its name as written. */
  references: PostgresObject | string;
  refColumns: string[];
  match?: string;
  onDelete?: string;
  onUpdate?: string;
  attributes?: string;
}

export interface ConstraintDef {
  name?: string;
  kind: string;
  columns?: string[];
  expr?: string;
  attributes?: string;
}

interface Common {
  name: string;
  schema?: string;
  comment?: string;
  ddl: string;
  source: { strings: string[] };
}

// ── Building ─────────────────────────────────────────────────────────

type Tag = "schema" | "table" | "index" | "view" | "sequence" | "type" | "domain" | "extension";

const STATEMENT_OF: Record<Tag, StatementNode["statement"]> = {
  schema: "schema",
  table: "table",
  index: "index",
  view: "view",
  sequence: "sequence",
  type: "enum",
  domain: "domain",
  extension: "extension",
};

const strip = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0))) as T;

/** A qualified name's schema and name. An interpolated schema entity names the schema; an interpolated object gives both. */
function qualified(ctx: Ctx, n: NameNode): { schema?: string; name: string } {
  const pieces: string[] = [];
  for (const t of ctx.tokens.slice(n.span.from, n.span.to)) {
    if (t.kind === "ws" || t.kind === "comment" || (t.kind === "punct" && t.text === ".")) continue;
    if (t.kind === "ref") {
      const v = ctx.values[t.part];
      if (isPostgresObject(v)) {
        const p = v.props as Common;
        if (p.schema) pieces.push(p.schema);
        pieces.push(p.name);
      } else pieces.push(POSTGRES.renderReference(v));
    } else pieces.push(identValue(t));
  }
  return pieces.length >= 2 ? { schema: pieces[pieces.length - 2], name: pieces[pieces.length - 1]! } : { name: pieces[0] ?? "" };
}

const sqlNameOf = (q: { schema?: string; name: string }) => (q.schema ? `${quoteIdent(q.schema)}.${quoteIdent(q.name)}` : quoteIdent(q.name));

/** The object a name span refers to: the entity when the whole name is one interpolation, else the name text. */
function target(ctx: Ctx, n: NameNode): PostgresObject | string {
  if (n.span.refs.length === 1 && n.pieces.length === 1) {
    const v = ctx.values[n.span.refs[0]!];
    if (isPostgresObject(v)) return v;
  }
  return sqlNameOf(qualified(ctx, n));
}

/** A string literal's value: '...', E'...', $$...$$. */
function stringValue(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  let m = /^'(.*)'$/s.exec(s);
  if (m) return m[1]!.replace(/''/g, "'");
  m = /^[Ee]'(.*)'$/s.exec(s);
  if (m) return m[1]!.replace(/''/g, "'").replace(/\\(.)/g, "$1");
  m = /^\$([A-Za-z_]*)\$(.*)\$\1\$$/s.exec(s);
  if (m) return m[2];
  return s;
}

function columnDef(ctx: Ctx, c: ColumnNode): ColumnDef {
  const def: ColumnDef = { name: c.name || (text(ctx, c.nameSpan) ?? "") };
  const t = text(ctx, c.type, "columns");
  if (t !== undefined) def.type = t;
  if (c.notNull !== undefined) def.notNull = c.notNull;
  const dflt = text(ctx, c.default, "columns");
  if (dflt !== undefined) def.default = dflt;
  if (c.generated) {
    def.generated = strip({
      kind: c.generated.kind,
      expr: text(ctx, c.generated.expr, "columns"),
      always: c.generated.always,
      options: text(ctx, c.generated.options, "columns"),
    });
  }
  const coll = text(ctx, c.collate, "columns");
  if (coll !== undefined) def.collate = coll;
  return def;
}

function fk(ctx: Ctx, c: ConstraintNode, columns: string[]): ForeignKeyDef {
  const r = c.references!;
  return strip({
    name: c.name,
    columns,
    references: target(ctx, r.table),
    refColumns: r.columns.map((x) => x.name || (text(ctx, x.span) ?? "")),
    match: r.match,
    onDelete: text(ctx, r.onDelete),
    onUpdate: text(ctx, r.onUpdate),
    attributes: text(ctx, c.attributes),
  }) as ForeignKeyDef;
}

function constraintDef(ctx: Ctx, c: ConstraintNode, columns: string[]): ConstraintDef {
  return strip({ name: c.name, kind: c.kind, columns, expr: text(ctx, c.expr, "constraints"), attributes: text(ctx, c.attributes) });
}

/** Apply trailing COMMENT ON statements to the object they name. */
function applyComments(tag: string, ctx: Ctx, comments: CommentNode[], self: { schema?: string; name: string }, columns?: ColumnDef[]): string | undefined {
  let comment: string | undefined;
  for (const c of comments) {
    const q = qualified(ctx, c.target);
    const value = stringValue(text(ctx, c.text, "comment"));
    if (c.objectType === "COLUMN") {
      const all = ctx.tokens.slice(c.target.span.from, c.target.span.to).filter((t) => t.kind === "ident" || t.kind === "qident").map(identValue);
      const col = all[all.length - 1]!;
      const rel = all[all.length - 2];
      const col_ = columns?.find((x) => x.name === col);
      if (rel !== self.name || !col_) throw new SqlTemplateError(tag, `COMMENT ON COLUMN ${all.join(".")} is not a column of ${self.name}`, 0, 0);
      if (value !== undefined) col_.comment = value;
    } else {
      if (q.name !== self.name || (q.schema && self.schema && q.schema !== self.schema)) {
        throw new SqlTemplateError(tag, `COMMENT ON ${c.objectType} ${sqlNameOf(q)} names another object than ${sqlNameOf(self)}`, 0, 0);
      }
      comment = value;
    }
  }
  return comment;
}

function build(tag: Tag, strings: TemplateStringsArray | readonly string[], values: readonly unknown[]): PostgresObject {
  const parts = templateParts(strings);
  const tokens: Token[] = splice(POSTGRES, tag, parts, values);
  let nodes: StatementNode[];
  try {
    nodes = parseStatements(tokens);
  } catch (err) {
    if (err instanceof SqlSyntaxError) throw templateSyntaxError(tag, parts, err);
    throw err;
  }
  const [node, ...rest] = nodes;
  if (!node || node.statement !== STATEMENT_OF[tag]) {
    throw new SqlTemplateError(tag, `holds ${node ? `a ${node.statement} statement` : "no statement"}; use the ${node?.statement === "enum" ? "type" : node?.statement} tag`, 0, 0);
  }
  if (rest.some((n) => n.statement !== "comment")) throw new SqlTemplateError(tag, "only COMMENT ON statements may follow the CREATE in one template", 0, 0);
  const comments = rest as CommentNode[];
  const ctx: Ctx = { d: POSTGRES, tokens, values, fed: values.map(() => new Set<string>()) };
  const ddl = untokenize(tokens, (i) => POSTGRES.renderReference(values[i])).trim().replace(/;\s*$/, "");
  const source = { strings: parts };
  const dependsOn = [...new Set(values.filter((v) => isPostgresObject(v) || isColumnRef(v)))];
  const make = (type: string, q: { schema?: string; name: string }, props: object, cols?: string[]) =>
    makeEntity<PostgresObject>(PostgresObject.prototype, type, sqlNameOf(q), props, cols, dependsOn);

  switch (node.statement) {
    case "schema": {
      const q = node.name ? qualified(ctx, node.name) : { name: text(ctx, node.authorization) ?? "" };
      const comment = applyComments(tag, ctx, comments, q);
      return make(PG.schema, q, strip({ name: q.name, ifNotExists: node.ifNotExists, authorization: text(ctx, node.authorization), comment, ddl, source }));
    }
    case "extension": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q);
      return make(PG.extension, { name: q.name }, strip({ name: q.name, schema: text(ctx, node.schema), version: text(ctx, node.version), cascade: node.cascade, ifNotExists: node.ifNotExists, comment, ddl, source }));
    }
    case "enum": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q);
      return make(PG.enum, q, strip({ ...q, labels: node.labels.map((l) => stringValue(text(ctx, l, "labels"))!), comment, ddl, source }));
    }
    case "domain": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q);
      return make(
        PG.domain,
        q,
        strip({
          ...q,
          type: text(ctx, node.type, "type"),
          collate: text(ctx, node.collate),
          default: text(ctx, node.default, "default"),
          notNull: node.notNull,
          checks: node.checks.map((c) => strip({ name: c.name, expr: text(ctx, c.expr, "checks")!, notValid: c.notValid })),
          comment,
          ddl,
          source,
        }),
      );
    }
    case "sequence": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q);
      const options = Object.fromEntries(node.options.map((o) => [o.option, text(ctx, o.value, "options") ?? true]));
      return make(PG.sequence, q, strip({ ...q, persistence: node.persistence, ifNotExists: node.ifNotExists, options, comment, ddl, source }));
    }
    case "table": {
      const q = qualified(ctx, node.name);
      const columns = node.columns.map((c) => columnDef(ctx, c));
      const primaryKey: ConstraintDef[] = [];
      const uniques: ConstraintDef[] = [];
      const checks: ConstraintDef[] = [];
      const foreignKeys: ForeignKeyDef[] = [];
      const exclusions: ConstraintDef[] = [];
      const file = (c: ConstraintNode, cols: string[]) => {
        if (c.kind === "FOREIGN KEY") foreignKeys.push(fk(ctx, c, cols));
        else if (c.kind === "PRIMARY KEY") primaryKey.push(constraintDef(ctx, c, cols));
        else if (c.kind === "UNIQUE") uniques.push(constraintDef(ctx, c, cols));
        else if (c.kind === "CHECK") checks.push(constraintDef(ctx, c, cols));
        else if (c.kind === "EXCLUDE") exclusions.push(constraintDef(ctx, c, cols));
        else if (c.kind === "NOT NULL") checks.push(constraintDef(ctx, c, cols));
      };
      node.columns.forEach((c, i) => c.constraints.forEach((k) => file(k, [columns[i]!.name])));
      node.constraints.forEach((k) => file(k, k.columns.map((x) => x.name || (text(ctx, x.span) ?? ""))));
      const comment = applyComments(tag, ctx, comments, q, columns);
      const props = strip({
        ...q,
        persistence: node.persistence,
        ifNotExists: node.ifNotExists,
        partitionOf: node.partitionOf ? target(ctx, node.partitionOf) : undefined,
        partitionBound: text(ctx, node.partitionBound),
        ofType: node.ofType ? target(ctx, node.ofType) : undefined,
        columns,
        primaryKey: primaryKey[0],
        uniques,
        checks,
        foreignKeys,
        exclusions,
        like: node.like.map((l) => text(ctx, l)!),
        inherits: node.inherits?.map((n) => target(ctx, n)),
        partitionBy: text(ctx, node.partitionBy, "partitionBy"),
        using: text(ctx, node.using),
        with: text(ctx, node.with, "with"),
        tablespace: text(ctx, node.tablespace),
        comment,
        ddl,
        source,
      });
      return make(PG.table, q, props, columns.map((c) => c.name));
    }
    case "index": {
      const table = target(ctx, node.table);
      const tq = qualified(ctx, node.table);
      if (!node.name) throw new SqlTemplateError(tag, "an index needs a name: the name is its identity on the server", 0, 0);
      const nq = qualified(ctx, node.name);
      // An index lives in its table's schema; CREATE INDEX does not take a qualified name.
      const q = { schema: tq.schema, name: nq.name };
      const comment = applyComments(tag, ctx, comments, q);
      const props = strip({
        ...q,
        table,
        unique: node.unique,
        concurrently: node.concurrently,
        ifNotExists: node.ifNotExists,
        only: node.only,
        method: node.using,
        elements: node.elements.map((e) => {
          const refs = e.span.refs.map((i) => values[i]).filter(isColumnRef);
          // A column element: a name, or one column reference, then only opclass / ordering words.
          const sig = tokens.slice(e.span.from, e.span.to).filter((t) => t.kind !== "ws" && t.kind !== "comment");
          const byRef = sig[0]?.kind === "ref" && refs.length === 1 && sig.slice(1).every((t) => t.kind === "ident") ? refs[0]!.attribute : undefined;
          return strip({ expr: text(ctx, e.span, "elements")!, column: e.column ?? byRef });
        }),
        include: text(ctx, node.include),
        nullsNotDistinct: node.nullsNotDistinct,
        with: text(ctx, node.with, "with"),
        tablespace: text(ctx, node.tablespace),
        where: text(ctx, node.where, "where"),
        comment,
        ddl,
        source,
      });
      return make(PG.index, q, props);
    }
    case "view": {
      const q = qualified(ctx, node.name);
      const lin = lineage(ctx, node.query);
      const declared = node.columnNames.map((c) => c.name);
      const outputs = declared.length > 0 ? declared : lin.edges.map((e) => e.output);
      // A declared column list renames the outputs positionally.
      const edges: LineageEdge[] = lin.edges.map((e, i) => ({ ...e, output: declared[i] ?? e.output }));
      const comment = applyComments(tag, ctx, comments, q);
      const props = strip({
        ...q,
        materialized: node.materialized,
        orReplace: node.orReplace,
        recursive: node.recursive,
        temporary: node.temporary,
        ifNotExists: node.ifNotExists,
        columns: declared,
        with: text(ctx, node.with, "with"),
        using: text(ctx, node.using),
        tablespace: text(ctx, node.tablespace),
        query: text(ctx, node.query, "query"),
        checkOption: text(ctx, node.checkOption),
        withData: node.withData,
        reads: lin.reads,
        lineage: edges,
        comment,
        ddl,
        source,
      });
      return make(node.materialized ? PG.materializedView : PG.view, q, props, outputs);
    }
    case "comment":
      throw new SqlTemplateError(tag, "a COMMENT ON goes after the CREATE it comments on", 0, 0);
  }
}

export const schema = (s: TemplateStringsArray, ...v: unknown[]) => build("schema", s, v);
export const table = (s: TemplateStringsArray, ...v: unknown[]) => build("table", s, v) as PostgresRelation;
export const index = (s: TemplateStringsArray, ...v: unknown[]) => build("index", s, v);
export const view = (s: TemplateStringsArray, ...v: unknown[]) => build("view", s, v) as PostgresRelation;
export const sequence = (s: TemplateStringsArray, ...v: unknown[]) => build("sequence", s, v);
export const type = (s: TemplateStringsArray, ...v: unknown[]) => build("type", s, v);
export const domain = (s: TemplateStringsArray, ...v: unknown[]) => build("domain", s, v);
export const extension = (s: TemplateStringsArray, ...v: unknown[]) => build("extension", s, v);
