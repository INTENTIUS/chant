/**
 * Reading a live Postgres server's schema from its catalog, and printing each
 * object as the statement that creates it.
 *
 * Postgres has no `SHOW CREATE TABLE`, so the statement is assembled from the
 * server's own printers, the way `pg_dump` assembles it: `format_type()` for
 * every type, `pg_get_expr()` for defaults, generated columns and partition
 * bounds, `pg_get_constraintdef()` for every constraint, `pg_get_indexdef()`,
 * `pg_get_viewdef()` and `pg_get_partkeydef()`. The session reads with an
 * empty `search_path` (`./client.ts`), so every name outside `pg_catalog` is
 * schema-qualified in what they print. That printed form is the canonical
 * one: import writes it, and normalization compares against it.
 *
 * Left out, each for its reason:
 *
 * - the server's own schemas (`pg_catalog`, `information_schema`, `pg_toast`,
 *   the temp schemas) and `public`, which every database has;
 * - objects an extension owns (`pg_depend.deptype = 'e'`): the extension
 *   declares them, so the extension is what is imported;
 * - `plpgsql`, installed in every database;
 * - aggregates, and a trigger the server makes for itself (a foreign key's)
 *   or clones onto a partition from its parent's;
 * - a routine with a SQL-standard body (`RETURN`, `BEGIN ATOMIC`): read, but
 *   marked `unsupported`, since the server prints it rewritten and a
 *   declaration cannot hold it;
 * - a sequence an identity column owns (it is the column's), and a `serial`
 *   column's sequence, since the column prints as `serial`;
 * - an index that backs a constraint (the constraint creates it), and an
 *   index partition (the partitioned index creates it);
 * - chant's own receipts tables and schema (`../../core/ownership.ts`), and the working
 *   columns, constraints and indexes of an expand-and-contract migration in
 *   progress (`../migrate/names.ts`, `../migrate/carry.ts`), so a table reads
 *   as it was before the migration until its switch, and as declared after it.
 *
 * Objects another tool owns, an ORM's or a migration runner's revision table
 * ({@link FOREIGN_TABLES}), are read and marked with the tool, so import
 * leaves them out with a warning and observation reports them foreign, never
 * as orphans (#3047 question 10).
 */

import type { PostgresClient } from "./client";
import { POSTGRES_ENTITY_TYPES, type PostgresEntityType } from "../entity-types";
import { quoteIdent } from "../keywords";
import { hasChantTrailerKey, RECEIPTS_TRAILER_KEY, stripMarker } from "../../core/ownership";
import { MIGRATION_TRAILER_KEY } from "../migrate/names";
import { isProviderOwned, providerData } from "../providers";
import { FOREIGN_TABLES } from "../../core/foreign-tables";
import type { PostgresProvider } from "../providers/types";

/** The server's own schemas, never part of a declared schema. */
export const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

/** Tables another tool keeps its migration history in, by name, with the tool; both dialects share the list. */
export { FOREIGN_TABLES };

export interface LivePgObject {
  type: PostgresEntityType;
  /** The schema it is in; absent for a schema and an extension. */
  schema?: string;
  name: string;
  /** The catalog oid, the object's physical id. */
  oid: string;
  /** The object's comment as the server holds it, chant's ownership trailer included. */
  comment?: string;
  /**
   * The statements that create it as the server prints them, chant's trailer
   * taken out of every comment: the CREATE, then a `COMMENT ON` per comment.
   */
  statement: string;
  /** The tool whose bookkeeping this is, when it is another tool's (an ORM's revision table). */
  foreign?: string;
  /** A routine's input parameter types, `(integer,text)`; a trigger's table, ` ON app.users` (`../plan/normalize.ts`). */
  signature?: string;
  /** What depends on a routine (a view, a trigger, a column default), as the server describes each. */
  dependents?: string[];
  /** Why no declaration can hold this object; it is read so import can say it left it out. */
  unsupported?: string;
}

/** What {@link readLiveSchema} reads. */
export interface SchemaScope {
  /** The schemas in scope; undefined is every schema but the server's own and `public`'s own objects included. */
  schemas?: readonly string[];
  /**
   * Whether access is read (`sql.profiles.<env>.access`): the policies on the
   * tables in scope, each table's row-level security, and the roles named in
   * `roles`. Off, none of it is read, so a project that manages access
   * elsewhere sees none of it.
   */
  access?: boolean;
  /** The roles to read, when access is: the declared ones. A role is the cluster's, never read otherwise. */
  roles?: readonly string[];
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const qname = (schema: string | undefined, name: string): string => (schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name));

/** A comment with chant's trailer taken off, or undefined when nothing is left. */
function ownComment(comment: unknown): string | undefined {
  const c = str(comment);
  if (c === undefined) return undefined;
  const own = stripMarker(c);
  return own === "" ? undefined : own;
}

const commentOn = (what: string, comment: unknown): string[] => {
  const own = ownComment(comment);
  return own === undefined ? [] : [`COMMENT ON ${what} IS ${literal(own)}`];
};

/** The scope as a predicate on a schema name column, with its parameter. */
function scopeSql(column: string, scope: SchemaScope): { sql: string; params: unknown[] } {
  if (scope.schemas) return { sql: `${column} = ANY($1::text[])`, params: [[...scope.schemas]] };
  return {
    sql: `${column} NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND ${column} NOT LIKE 'pg\\_temp\\_%' AND ${column} NOT LIKE 'pg\\_toast\\_temp\\_%'`,
    params: [],
  };
}

/** `NOT <object is owned by an extension>`, for an object of catalog `catalog` with oid column `oid`. */
const notExtensionOwned = (catalog: string, oid: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.${catalog}'::pg_catalog.regclass AND d.objid = ${oid} AND d.deptype = 'e')`;

/** A collation name as a clause, `pg_catalog` names unqualified. */
const COLLATION_NAME = (oid: string) =>
  `(SELECT CASE WHEN cn.nspname = 'pg_catalog' THEN pg_catalog.quote_ident(co.collname) ELSE pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname) END ` +
  `FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = ${oid})`;

// ── Sequences ──────────────────────────────────────────────────────────

interface SequenceParams {
  type: string;
  start: string;
  increment: string;
  min: string;
  max: string;
  cache: string;
  cycle: boolean;
}

const TYPE_RANGE: Record<string, [bigint, bigint]> = {
  smallint: [-32768n, 32767n],
  integer: [-2147483648n, 2147483647n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
};

/** The defaults `CREATE SEQUENCE` gives a sequence of `type` counting by `increment`. */
export function sequenceDefaults(type: string, increment: bigint): Omit<SequenceParams, "type" | "increment" | "cycle"> {
  const [lo, hi] = TYPE_RANGE[type] ?? TYPE_RANGE.bigint!;
  const min = increment > 0n ? 1n : lo;
  const max = increment > 0n ? hi : -1n;
  return { min: String(min), max: String(max), start: String(increment > 0n ? min : max), cache: "1" };
}

/**
 * The sequence options that differ from what `CREATE SEQUENCE` would choose,
 * in the order the reference page lists them. `withType` writes `AS type`
 * when it is not `bigint`; an identity sequence takes its column's type.
 */
export function sequenceOptions(p: SequenceParams, withType: boolean): string[] {
  const inc = BigInt(p.increment);
  const d = sequenceDefaults(p.type, inc);
  const out: string[] = [];
  if (withType && p.type !== "bigint") out.push(`AS ${p.type}`);
  if (inc !== 1n) out.push(`INCREMENT BY ${p.increment}`);
  if (p.min !== d.min) out.push(`MINVALUE ${p.min}`);
  if (p.max !== d.max) out.push(`MAXVALUE ${p.max}`);
  // A sequence starts at its minimum (counting up) or its maximum (counting down) unless told otherwise.
  if (p.start !== (inc > 0n ? p.min : p.max)) out.push(`START WITH ${p.start}`);
  if (p.cache !== d.cache) out.push(`CACHE ${p.cache}`);
  if (p.cycle) out.push("CYCLE");
  return out;
}

const seqParams = (r: Row): SequenceParams => ({
  type: String(r.type),
  start: String(r.start),
  increment: String(r.increment),
  min: String(r.min),
  max: String(r.max),
  cache: String(r.cache),
  cycle: r.cycle === true,
});

// ── Reading ────────────────────────────────────────────────────────────

/**
 * Every object in scope, in a stable order: schemas, extensions, enums,
 * domains, sequences, tables, views and materialized views, indexes,
 * functions and procedures, triggers, and where access is read, policies and
 * the declared roles; each kind by schema then name, in byte order.
 */
export async function readLiveSchema(client: PostgresClient, scope: SchemaScope = {}): Promise<LivePgObject[]> {
  const out: LivePgObject[] = [];
  const C = 'COLLATE "C"';

  // Schemas.
  {
    const s = scopeSql("n.nspname", scope);
    const rows = await client.query<Row>(
      `SELECT n.oid::text AS oid, n.nspname AS name, pg_catalog.obj_description(n.oid, 'pg_namespace') AS comment
       FROM pg_catalog.pg_namespace n WHERE ${s.sql} AND n.nspname <> 'public' AND ${notExtensionOwned("pg_namespace", "n.oid")}
       ORDER BY n.nspname ${C}`,
      s.params,
    );
    for (const r of rows) {
      const name = String(r.name);
      // chant's own receipts schema (`../../receipts.ts`), like the receipts tables.
      if (hasChantTrailerKey(str(r.comment), [RECEIPTS_TRAILER_KEY])) continue;
      out.push({
        type: POSTGRES_ENTITY_TYPES.schema,
        name,
        oid: String(r.oid),
        ...(str(r.comment) ? { comment: str(r.comment) } : {}),
        statement: [`CREATE SCHEMA ${quoteIdent(name)}`, ...commentOn(`SCHEMA ${quoteIdent(name)}`, r.comment)].join(";\n"),
      });
    }
  }

  // Extensions, in a schema in scope.
  {
    const s = scopeSql("n.nspname", scope);
    const rows = await client.query<Row>(
      `SELECT e.oid::text AS oid, e.extname AS name, n.nspname AS schema, e.extversion AS version, x.default_version,
              pg_catalog.obj_description(e.oid, 'pg_extension') AS comment, x.comment AS default_comment
       FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
       LEFT JOIN pg_catalog.pg_available_extensions x ON x.name = e.extname
       WHERE e.extname <> 'plpgsql' AND (${s.sql} OR n.nspname = 'public')
       ORDER BY e.extname ${C}`,
      s.params,
    );
    for (const r of rows) {
      const name = String(r.name);
      const version = str(r.version);
      const create = `CREATE EXTENSION ${quoteIdent(name)} WITH SCHEMA ${quoteIdent(String(r.schema))}${version && version !== str(r.default_version) ? ` VERSION ${literal(version)}` : ""}`;
      // The comment the extension's control file sets is the extension's, not a
      // declared one, also when chant's trailer follows it (`../apply/statements.ts`).
      const own = str(r.comment) !== undefined && ownComment(r.comment) === str(r.default_comment) ? null : r.comment;
      out.push({
        type: POSTGRES_ENTITY_TYPES.extension,
        name,
        oid: String(r.oid),
        ...(str(r.comment) && str(r.comment) !== str(r.default_comment) ? { comment: str(r.comment) } : {}),
        statement: [create, ...commentOn(`EXTENSION ${quoteIdent(name)}`, own)].join(";\n"),
      });
    }
  }

  // Enums.
  {
    const s = scopeSql("n.nspname", scope);
    const rows = await client.query<Row>(
      `SELECT t.oid::text AS oid, n.nspname AS schema, t.typname AS name, pg_catalog.obj_description(t.oid, 'pg_type') AS comment,
              ARRAY(SELECT pg_catalog.quote_literal(e.enumlabel) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS labels
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typtype = 'e' AND ${s.sql} AND ${notExtensionOwned("pg_type", "t.oid")}
       ORDER BY n.nspname ${C}, t.typname ${C}`,
      s.params,
    );
    for (const r of rows) {
      const q = qname(String(r.schema), String(r.name));
      out.push({
        type: POSTGRES_ENTITY_TYPES.enum,
        schema: String(r.schema),
        name: String(r.name),
        oid: String(r.oid),
        ...(str(r.comment) ? { comment: str(r.comment) } : {}),
        statement: [`CREATE TYPE ${q} AS ENUM (${(r.labels as string[]).join(", ")})`, ...commentOn(`TYPE ${q}`, r.comment)].join(";\n"),
      });
    }
  }

  // Domains.
  {
    const s = scopeSql("n.nspname", scope);
    const rows = await client.query<Row>(
      `SELECT t.oid::text AS oid, n.nspname AS schema, t.typname AS name, pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base,
              t.typnotnull AS notnull, t.typdefault AS dflt, pg_catalog.obj_description(t.oid, 'pg_type') AS comment,
              CASE WHEN t.typcollation <> 0 AND t.typcollation <> bt.typcollation THEN ${COLLATION_NAME("t.typcollation")} END AS collation,
              ARRAY(SELECT 'CONSTRAINT ' || pg_catalog.quote_ident(c.conname) || ' ' || pg_catalog.pg_get_constraintdef(c.oid, true)
                    FROM pg_catalog.pg_constraint c WHERE c.contypid = t.oid AND c.contype = 'c' ORDER BY c.conname ${C}) AS checks,
              ARRAY(SELECT pg_catalog.quote_ident(c.conname) || E'\\t' || pg_catalog.obj_description(c.oid, 'pg_constraint')
                    FROM pg_catalog.pg_constraint c WHERE c.contypid = t.oid AND c.contype = 'c' AND pg_catalog.obj_description(c.oid, 'pg_constraint') IS NOT NULL
                    ORDER BY c.conname ${C}) AS check_comments
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace JOIN pg_catalog.pg_type bt ON bt.oid = t.typbasetype
       WHERE t.typtype = 'd' AND ${s.sql} AND ${notExtensionOwned("pg_type", "t.oid")}
       ORDER BY n.nspname ${C}, t.typname ${C}`,
      s.params,
    );
    for (const r of rows) {
      const q = qname(String(r.schema), String(r.name));
      const parts = [`CREATE DOMAIN ${q} AS ${r.base}`];
      if (str(r.collation)) parts.push(`COLLATE ${r.collation}`);
      if (str(r.dflt)) parts.push(`DEFAULT ${r.dflt}`);
      if (r.notnull === true) parts.push("NOT NULL");
      parts.push(...(r.checks as string[]));
      const constraintComments = (r.check_comments as string[]).flatMap((line) => {
        const [con, text] = line.split("\t") as [string, string];
        return commentOn(`CONSTRAINT ${con} ON DOMAIN ${q}`, text);
      });
      out.push({
        type: POSTGRES_ENTITY_TYPES.domain,
        schema: String(r.schema),
        name: String(r.name),
        oid: String(r.oid),
        ...(str(r.comment) ? { comment: str(r.comment) } : {}),
        statement: [parts.join(" "), ...commentOn(`DOMAIN ${q}`, r.comment), ...constraintComments].join(";\n"),
      });
    }
  }

  // Tables, read first so sequences can tell a serial column's sequence.
  const s = scopeSql("n.nspname", scope);
  const tables = await client.query<Row>(
    `SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.relpersistence AS persistence,
            c.relispartition AS ispartition, c.reloftype <> 0 AS typed,
            CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partkey,
            CASE WHEN c.relispartition THEN pg_catalog.pg_get_expr(c.relpartbound, c.oid, true) END AS bound,
            ARRAY(SELECT pg_catalog.quote_ident(pn.nspname) || '.' || pg_catalog.quote_ident(pc.relname)
                  FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
                  WHERE i.inhrelid = c.oid ORDER BY i.inhseqno) AS parents,
            c.reloptions AS reloptions, (SELECT a.amname FROM pg_catalog.pg_am a WHERE a.oid = c.relam) AS am,
            c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forcerowsecurity,
            (SELECT ts.spcname FROM pg_catalog.pg_tablespace ts WHERE ts.oid = c.reltablespace) AS tablespace,
            pg_catalog.obj_description(c.oid, 'pg_class') AS comment
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND ${s.sql} AND ${notExtensionOwned("pg_class", "c.oid")}
     ORDER BY n.nspname ${C}, c.relname ${C}`,
    s.params,
  );
  const tableOids = tables.map((t) => String(t.oid));
  const columns = tableOids.length === 0 ? [] : await client.query<Row>(
    `SELECT a.attrelid::text AS rel, a.attnum AS num, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS notnull, a.attidentity AS identity, a.attgenerated AS generated, a.attislocal AS islocal,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) AS dflt,
            CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN ${COLLATION_NAME("a.attcollation")} END AS collation,
            pg_catalog.col_description(a.attrelid, a.attnum) AS comment, a.attcompression::text AS compression, a.attstorage::text AS storage, t.typstorage::text AS typstorage
     FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attrelid, a.attnum`,
    [tableOids],
  );
  const constraints = tableOids.length === 0 ? [] : await client.query<Row>(
    `SELECT c.conrelid::text AS rel, c.conname AS name, c.contype AS type, pg_catalog.pg_get_constraintdef(c.oid, true) AS def,
            c.conkey AS keys, pg_catalog.obj_description(c.oid, 'pg_constraint') AS comment
     FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = ANY($1::oid[]) AND c.contype IN ('p', 'u', 'c', 'f', 'x') AND c.conislocal AND c.conparentid = 0
     ORDER BY c.conrelid, CASE c.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'c' THEN 3 WHEN 'f' THEN 4 ELSE 5 END, c.conname ${C}`,
    [tableOids],
  );
  const identities = tableOids.length === 0 ? [] : await client.query<Row>(
    `SELECT d.refobjid::text AS rel, d.refobjsubid AS num, pg_catalog.format_type(s.seqtypid, NULL) AS type, s.seqstart::text AS start,
            s.seqincrement::text AS increment, s.seqmin::text AS min, s.seqmax::text AS max, s.seqcache::text AS cache, s.seqcycle AS cycle
     FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_sequence s ON s.seqrelid = d.objid
     WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
       AND d.deptype = 'i' AND d.refobjid = ANY($1::oid[])`,
    [tableOids],
  );

  // Sequences: every one in scope that an identity column does not own.
  const sequences = await client.query<Row>(
    `SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, pg_catalog.format_type(s.seqtypid, NULL) AS type,
            s.seqstart::text AS start, s.seqincrement::text AS increment, s.seqmin::text AS min, s.seqmax::text AS max,
            s.seqcache::text AS cache, s.seqcycle AS cycle, c.relpersistence AS persistence,
            pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
            (SELECT d.refobjid::text || ':' || d.refobjsubid FROM pg_catalog.pg_depend d
              WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
                AND d.deptype = 'a' AND d.refobjsubid > 0 LIMIT 1) AS owner
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'S' AND ${s.sql} AND ${notExtensionOwned("pg_class", "c.oid")}
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'i')
     ORDER BY n.nspname ${C}, c.relname ${C}`,
    s.params,
  );

  // A serial column: an integer column whose default is nextval of a sequence it owns, named as Postgres names it, with default options.
  const tableByOid = new Map(tables.map((t) => [String(t.oid), t]));
  const serialSequences = new Set<string>();
  const serialColumns = new Map<string, string>(); // rel:num -> serial type
  for (const q of sequences) {
    const owner = str(q.owner);
    if (!owner) continue;
    const [rel, num] = owner.split(":") as [string, string];
    const t = tableByOid.get(rel);
    const col = columns.find((c) => String(c.rel) === rel && String(c.num) === num);
    if (!t || !col) continue;
    const seqName = qname(String(q.schema), String(q.name));
    const serial = { integer: "serial", bigint: "bigserial", smallint: "smallserial" }[String(col.type)];
    const expected = `${String(t.name)}_${String(col.name)}_seq`;
    const p = seqParams(q);
    if (
      serial &&
      String(q.schema) === String(t.schema) &&
      String(q.name) === expected &&
      str(col.dflt) === `nextval(${literal(seqName)}::regclass)` &&
      p.type === String(col.type) &&
      sequenceOptions(p, false).length === 0 &&
      ownComment(q.comment) === undefined
    ) {
      serialSequences.add(String(q.oid));
      serialColumns.set(owner, serial);
    }
  }

  for (const q of sequences) {
    if (serialSequences.has(String(q.oid))) continue;
    const qn = qname(String(q.schema), String(q.name));
    const opts = sequenceOptions(seqParams(q), true);
    const owner = str(q.owner);
    const ownerTable = owner ? tableByOid.get(owner.split(":")[0]!) : undefined;
    out.push({
      type: POSTGRES_ENTITY_TYPES.sequence,
      schema: String(q.schema),
      name: String(q.name),
      oid: String(q.oid),
      ...(str(q.comment) ? { comment: str(q.comment) } : {}),
      ...(ownerTable && FOREIGN_TABLES[String(ownerTable.name)] ? { foreign: FOREIGN_TABLES[String(ownerTable.name)] } : {}),
      statement: [
        `CREATE ${q.persistence === "u" ? "UNLOGGED " : ""}SEQUENCE ${qn}${opts.length ? ` ${opts.join(" ")}` : ""}`,
        ...commentOn(`SEQUENCE ${qn}`, q.comment),
      ].join(";\n"),
    });
  }

  for (const t of tables) {
    const rel = String(t.oid);
    const q = qname(String(t.schema), String(t.name));
    if (hasChantTrailerKey(str(t.comment), [RECEIPTS_TRAILER_KEY])) continue;
    const working = (comment: unknown) => hasChantTrailerKey(str(comment), [MIGRATION_TRAILER_KEY]);
    const cols = columns.filter((c) => String(c.rel) === rel && !working(c.comment));
    const cons = constraints.filter((c) => String(c.rel) === rel && !working(c.comment));
    const pkColumns = new Set(
      cons.filter((c) => c.type === "p").flatMap((c) => (c.keys as number[] | null) ?? []).map((n) => String(n)),
    );
    const lines: string[] = [];
    const commentLines: string[] = [];
    for (const c of cols) {
      if (t.ispartition === true || (Array.isArray(t.parents) && (t.parents as string[]).length > 0 && c.islocal !== true)) {
        // A partition's columns, and an inheriting table's inherited ones, are its parent's.
        commentLines.push(...commentOn(`COLUMN ${q}.${quoteIdent(String(c.name))}`, c.comment));
        continue;
      }
      const serial = serialColumns.get(`${rel}:${String(c.num)}`);
      const parts = [quoteIdent(String(c.name)), serial ?? String(c.type)];
      const compression = str(c.compression);
      if (compression === "p") parts.push("COMPRESSION pglz");
      else if (compression === "l") parts.push("COMPRESSION lz4");
      if (str(c.storage) !== str(c.typstorage)) {
        parts.push(`STORAGE ${{ p: "PLAIN", e: "EXTERNAL", m: "MAIN", x: "EXTENDED" }[String(c.storage)] ?? "DEFAULT"}`);
      }
      if (str(c.collation)) parts.push(`COLLATE ${c.collation}`);
      const identity = str(c.identity);
      if (identity === "a" || identity === "d") {
        const seq = identities.find((x) => String(x.rel) === rel && String(x.num) === String(c.num));
        const opts = seq ? sequenceOptions(seqParams(seq), false) : [];
        parts.push(`GENERATED ${identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY${opts.length ? ` (${opts.join(" ")})` : ""}`);
      } else if (str(c.generated) === "s" || str(c.generated) === "v") {
        parts.push(`GENERATED ALWAYS AS (${c.dflt}) ${c.generated === "s" ? "STORED" : "VIRTUAL"}`);
      } else if (str(c.dflt) && !serial) parts.push(`DEFAULT ${c.dflt}`);
      // A primary key and an identity column are NOT NULL by themselves.
      if (c.notnull === true && !pkColumns.has(String(c.num)) && identity !== "a" && identity !== "d" && !serial) parts.push("NOT NULL");
      lines.push(parts.join(" "));
      commentLines.push(...commentOn(`COLUMN ${q}.${quoteIdent(String(c.name))}`, c.comment));
    }
    for (const c of cons) {
      lines.push(`CONSTRAINT ${quoteIdent(String(c.name))} ${c.def}`);
      commentLines.push(...commentOn(`CONSTRAINT ${quoteIdent(String(c.name))} ON ${q}`, c.comment));
    }
    const head = `CREATE ${t.persistence === "u" ? "UNLOGGED " : ""}TABLE ${q}`;
    const parents = (t.parents as string[] | null) ?? [];
    let create: string;
    if (t.ispartition === true) {
      create = `${head} PARTITION OF ${parents[0]}${lines.length ? ` (\n    ${lines.join(",\n    ")}\n)` : ""} ${t.bound}`;
    } else {
      create = `${head} (\n    ${lines.join(",\n    ")}\n)${parents.length ? ` INHERITS (${parents.join(", ")})` : ""}`;
    }
    if (str(t.partkey)) create += ` PARTITION BY ${t.partkey}`;
    if (str(t.am) && t.am !== "heap") create += ` USING ${quoteIdent(String(t.am))}`;
    const opts = (t.reloptions as string[] | null) ?? [];
    if (opts.length) create += ` WITH (${opts.join(", ")})`;
    if (str(t.tablespace)) create += ` TABLESPACE ${quoteIdent(String(t.tablespace))}`;
    out.push({
      type: POSTGRES_ENTITY_TYPES.table,
      schema: String(t.schema),
      name: String(t.name),
      oid: rel,
      ...(str(t.comment) ? { comment: str(t.comment) } : {}),
      ...(FOREIGN_TABLES[String(t.name)] ? { foreign: FOREIGN_TABLES[String(t.name)] } : {}),
      statement: [
        create,
        ...(scope.access && t.rowsecurity === true ? [`ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY`] : []),
        ...(scope.access && t.forcerowsecurity === true ? [`ALTER TABLE ${q} FORCE ROW LEVEL SECURITY`] : []),
        ...commentOn(`TABLE ${q}`, t.comment),
        ...commentLines,
      ].join(";\n"),
    });
  }

  // Views and materialized views.
  {
    const rows = await client.query<Row>(
      `SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind, pg_catalog.pg_get_viewdef(c.oid, true) AS def,
              c.reloptions AS reloptions, c.relispopulated AS populated, (SELECT a.amname FROM pg_catalog.pg_am a WHERE a.oid = c.relam) AS am,
              (SELECT ts.spcname FROM pg_catalog.pg_tablespace ts WHERE ts.oid = c.reltablespace) AS tablespace,
              pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
              ARRAY(SELECT pg_catalog.quote_ident(a.attname) || E'\\t' || pg_catalog.col_description(c.oid, a.attnum) FROM pg_catalog.pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND pg_catalog.col_description(c.oid, a.attnum) IS NOT NULL ORDER BY a.attnum) AS column_comments
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('v', 'm') AND ${s.sql} AND ${notExtensionOwned("pg_class", "c.oid")}
       ORDER BY n.nspname ${C}, c.relname ${C}`,
      s.params,
    );
    for (const r of rows) {
      const q = qname(String(r.schema), String(r.name));
      const materialized = r.kind === "m";
      const query = String(r.def).trim().replace(/;$/, "");
      let opts = (r.reloptions as string[] | null) ?? [];
      const check = opts.find((o) => o.startsWith("check_option="));
      opts = opts.filter((o) => !o.startsWith("check_option="));
      let create = `CREATE ${materialized ? "MATERIALIZED " : ""}VIEW ${q}`;
      if (materialized && str(r.am) && r.am !== "heap") create += ` USING ${quoteIdent(String(r.am))}`;
      if (opts.length) create += ` WITH (${opts.join(", ")})`;
      if (materialized && str(r.tablespace)) create += ` TABLESPACE ${quoteIdent(String(r.tablespace))}`;
      create += ` AS\n${query}`;
      if (check) create += `\nWITH ${check.endsWith("local") ? "LOCAL" : "CASCADED"} CHECK OPTION`;
      if (materialized && r.populated === false) create += "\nWITH NO DATA";
      const what = materialized ? "MATERIALIZED VIEW" : "VIEW";
      const columnComments = (r.column_comments as string[]).flatMap((line) => {
        const [col, text] = line.split("\t") as [string, string];
        return commentOn(`COLUMN ${q}.${col}`, text);
      });
      out.push({
        type: materialized ? POSTGRES_ENTITY_TYPES.materializedView : POSTGRES_ENTITY_TYPES.view,
        schema: String(r.schema),
        name: String(r.name),
        oid: String(r.oid),
        ...(str(r.comment) ? { comment: str(r.comment) } : {}),
        statement: [create, ...commentOn(`${what} ${q}`, r.comment), ...columnComments].join(";\n"),
      });
    }
  }

  // Indexes a constraint does not create, and not index partitions.
  {
    const rows = await client.query<Row>(
      `SELECT ic.oid::text AS oid, n.nspname AS schema, ic.relname AS name, tc.relname AS table_name,
              pg_catalog.pg_get_indexdef(i.indexrelid, 0, true) AS def, pg_catalog.obj_description(ic.oid, 'pg_class') AS comment
       FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = ic.relnamespace
       WHERE tc.relkind IN ('r', 'p', 'm') AND NOT ic.relispartition AND ${s.sql} AND ${notExtensionOwned("pg_class", "tc.oid")}
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = i.indexrelid AND c.contype IN ('p', 'u', 'x'))
       ORDER BY n.nspname ${C}, ic.relname ${C}`,
      s.params,
    );
    for (const r of rows) {
      // An index a migration builds on its new column, or keeps on the old one until its contract.
      if (hasChantTrailerKey(str(r.comment), [MIGRATION_TRAILER_KEY])) continue;
      const q = qname(String(r.schema), String(r.name));
      out.push({
        type: POSTGRES_ENTITY_TYPES.index,
        schema: String(r.schema),
        name: String(r.name),
        oid: String(r.oid),
        ...(str(r.comment) ? { comment: str(r.comment) } : {}),
        ...(FOREIGN_TABLES[String(r.table_name)] ? { foreign: FOREIGN_TABLES[String(r.table_name)] } : {}),
        statement: [String(r.def), ...commentOn(`INDEX ${q}`, r.comment)].join(";\n"),
      });
    }
  }

  // Functions and procedures (not aggregates).
  {
    const rows = await client.query<Row>(
      `SELECT p.oid::text AS oid, n.nspname AS schema, p.proname AS name, p.prokind AS kind, pg_catalog.pg_get_functiondef(p.oid) AS def,
              '(' || pg_catalog.replace(pg_catalog.oidvectortypes(p.proargtypes), ', ', ',') || ')' AS signature,
              p.prosqlbody IS NOT NULL AS sqlbody, pg_catalog.obj_description(p.oid, 'pg_proc') AS comment,
              ARRAY(SELECT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) FROM pg_catalog.pg_depend d
                    WHERE d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.refobjid = p.oid AND d.deptype = 'n'
                    ORDER BY 1) AS dependents
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prokind IN ('f', 'p', 'w') AND ${s.sql} AND ${notExtensionOwned("pg_proc", "p.oid")}
       ORDER BY n.nspname ${C}, p.proname ${C}, pg_catalog.oidvectortypes(p.proargtypes) ${C}`,
      s.params,
    );
    for (const r of rows) {
      // A migration's dual-write function, until its contract.
      if (hasChantTrailerKey(str(r.comment), [MIGRATION_TRAILER_KEY])) continue;
      const signature = String(r.signature);
      const q = `${qname(String(r.schema), String(r.name))}${signature}`;
      const procedure = r.kind === "p";
      const dependents = (r.dependents as string[] | null) ?? [];
      out.push({
        type: procedure ? POSTGRES_ENTITY_TYPES.procedure : POSTGRES_ENTITY_TYPES.function,
        schema: String(r.schema),
        name: String(r.name),
        oid: String(r.oid),
        signature,
        ...(dependents.length > 0 ? { dependents } : {}),
        ...(str(r.comment) ? { comment: str(r.comment) } : {}),
        ...(r.sqlbody === true ? { unsupported: "its body is SQL-standard (RETURN or BEGIN ATOMIC), which the server prints back rewritten; declare it with a string body (AS $$ ... $$)" } : {}),
        statement: [String(r.def).trim(), ...commentOn(`${procedure ? "PROCEDURE" : "FUNCTION"} ${q}`, r.comment)].join(";\n"),
      });
    }
  }

  // Triggers: the ones written by hand, not a foreign key's or a partition's clone of its parent's.
  {
    const rows = await client.query<Row>(
      `SELECT t.oid::text AS oid, n.nspname AS schema, c.relname AS table_name, t.tgname AS name, pg_catalog.pg_get_triggerdef(t.oid, true) AS def,
              pg_catalog.obj_description(t.oid, 'pg_trigger') AS comment
       FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND t.tgparentid = 0 AND ${s.sql} AND ${notExtensionOwned("pg_class", "c.oid")}
       ORDER BY n.nspname ${C}, c.relname ${C}, t.tgname ${C}`,
      s.params,
    );
    for (const r of rows) {
      // A migration's dual-write trigger, until its contract.
      if (hasChantTrailerKey(str(r.comment), [MIGRATION_TRAILER_KEY])) continue;
      const table = qname(String(r.schema), String(r.table_name));
      out.push({
        type: POSTGRES_ENTITY_TYPES.trigger,
        schema: String(r.schema),
        name: String(r.name),
        oid: String(r.oid),
        signature: ` ON ${table}`,
        ...(str(r.comment) ? { comment: str(r.comment) } : {}),
        ...(FOREIGN_TABLES[String(r.table_name)] ? { foreign: FOREIGN_TABLES[String(r.table_name)] } : {}),
        statement: [String(r.def), ...commentOn(`TRIGGER ${quoteIdent(String(r.name))} ON ${table}`, r.comment)].join(";\n"),
      });
    }
  }

  if (scope.access) {
    // Policies, on the tables in scope.
    const policies = await client.query<Row>(
      `SELECT p.oid::text AS oid, n.nspname AS schema, c.relname AS table_name, p.polname AS name, p.polpermissive AS permissive, p.polcmd AS cmd,
              ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r)) END FROM pg_catalog.unnest(p.polroles) r ORDER BY 1) AS roles,
              pg_catalog.pg_get_expr(p.polqual, p.polrelid, true) AS qual, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, true) AS withcheck,
              pg_catalog.obj_description(p.oid, 'pg_policy') AS comment
       FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE ${s.sql} AND ${notExtensionOwned("pg_class", "c.oid")}
       ORDER BY n.nspname ${C}, c.relname ${C}, p.polname ${C}`,
      s.params,
    );
    const COMMAND: Record<string, string> = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE" };
    for (const r of policies) {
      const table = qname(String(r.schema), String(r.table_name));
      const roles = (r.roles as string[] | null) ?? [];
      const parts = [`CREATE POLICY ${quoteIdent(String(r.name))} ON ${table}`];
      if (r.permissive === false) parts.push("AS RESTRICTIVE");
      if (COMMAND[String(r.cmd)]) parts.push(`FOR ${COMMAND[String(r.cmd)]}`);
      if (!(roles.length === 1 && roles[0] === "PUBLIC")) parts.push(`TO ${roles.join(", ")}`);
      if (str(r.qual)) parts.push(`USING (${r.qual})`);
      if (str(r.withcheck)) parts.push(`WITH CHECK (${r.withcheck})`);
      out.push({
        type: POSTGRES_ENTITY_TYPES.policy,
        schema: String(r.schema),
        name: String(r.name),
        oid: String(r.oid),
        signature: ` ON ${table}`,
        ...(str(r.comment) ? { comment: str(r.comment) } : {}),
        statement: [parts.join(" "), ...commentOn(`POLICY ${quoteIdent(String(r.name))} ON ${table}`, r.comment)].join(";\n"),
      });
    }

    // The declared roles, by name: a role is the cluster's, and the ones the declarations do not name are the environment's.
    if (scope.roles && scope.roles.length > 0) {
      const roles = await client.query<Row>(
        `SELECT r.oid::text AS oid, r.rolname AS name, r.rolsuper AS superuser, r.rolinherit AS inherit, r.rolcreaterole AS createrole, r.rolcreatedb AS createdb,
                r.rolcanlogin AS login, r.rolreplication AS replication, r.rolbypassrls AS bypassrls, r.rolconnlimit AS connlimit,
                pg_catalog.shobj_description(r.oid, 'pg_authid') AS comment
         FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[]) ORDER BY r.rolname ${C}`,
        [[...scope.roles]],
      );
      for (const r of roles) {
        const words: string[] = [];
        for (const [k, dflt] of [["superuser", false], ["createdb", false], ["createrole", false], ["inherit", true], ["login", false], ["replication", false], ["bypassrls", false]] as const) {
          if ((r[k] === true) !== dflt) words.push(r[k] === true ? k.toUpperCase() : `NO${k.toUpperCase()}`);
        }
        if (Number(r.connlimit) !== -1) words.push(`CONNECTION LIMIT ${Number(r.connlimit)}`);
        const name = quoteIdent(String(r.name));
        out.push({
          type: POSTGRES_ENTITY_TYPES.role,
          name: String(r.name),
          oid: String(r.oid),
          ...(str(r.comment) ? { comment: str(r.comment) } : {}),
          statement: [`CREATE ROLE ${name}${words.length > 0 ? ` WITH ${words.join(" ")}` : ""}`, ...commentOn(`ROLE ${name}`, r.comment)].join(";\n"),
        });
      }
    }
  }

  return out;
}

/** The key an object is found by: its type and schema-qualified name, and a routine's parameter types or a trigger's table. */
export const liveKey = (type: string, schema: string | undefined, name: string, signature?: string): string => `${type} ${schema ?? ""}.${name}${signature ?? ""}`;

/**
 * Mark what the managed service owns (#3282) as foreign: its reserved
 * schemas and everything in them, and the extensions it installs itself
 * (`rdsadmin`, Supabase's `auth` and `storage`, ...). They are the
 * provider's, so import leaves them out and observation never reports them
 * as chant's.
 */
export function markProviderOwned(objects: readonly LivePgObject[], provider: PostgresProvider | undefined): LivePgObject[] {
  if (!provider) return [...objects];
  const label = providerData(provider).label;
  return objects.map((o) => {
    if (o.foreign) return o;
    const owned =
      (o.type === POSTGRES_ENTITY_TYPES.schema && isProviderOwned(provider, { kind: "schema", name: o.name })) ||
      (o.type === POSTGRES_ENTITY_TYPES.extension && isProviderOwned(provider, { kind: "extension", name: o.name })) ||
      (o.schema !== undefined && isProviderOwned(provider, { kind: "schema", name: o.schema }));
    return owned ? { ...o, foreign: label } : o;
  });
}
