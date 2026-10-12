/**
 * The catalog read of the kinds #3911 adds: composite and range types,
 * collations, aggregates, casts and event triggers. Postgres has no printer
 * for any of them (`pg_dump` assembles each from its catalog row), so the
 * statement is assembled here the same way: `format_type()` for every type,
 * `regproc` for every function (bare in `pg_catalog`, qualified elsewhere,
 * since the session's search_path is empty), and an option only where it is
 * not what Postgres would choose by itself, so the printed form is the
 * canonical one a declaration is compared with (`../plan/normalize.ts`).
 *
 * Left out, each for its reason: a table's row type (the table is its
 * declaration), a multirange type (its range type creates it), an object an
 * extension owns, and a cast the server defines (`oid` below 16384, the first
 * normal object id).
 *
 * Each object carries what depends on it (`pg_depend`, a normal dependency),
 * which a DROP refuses over, so a change the plan would make by dropping and
 * creating it is refused instead (SQLPG301).
 */

import type { PostgresClient } from "./client";
import { notExtensionOwned, scopeSql, type LivePgObject, type SchemaScope } from "./catalog";
import { POSTGRES_ENTITY_TYPES } from "../entity-types";
import { quoteIdent } from "../keywords";
import { stripMarker } from "../../core/ownership";

type Row = Record<string, unknown>;

const C = 'COLLATE "C"';
const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const qname = (schema: string, name: string): string => `${quoteIdent(schema)}.${quoteIdent(name)}`;

function commentOn(what: string, comment: unknown): string[] {
  const c = str(comment);
  if (c === undefined) return [];
  const own = stripMarker(c);
  return own === "" ? [] : [`COMMENT ON ${what} IS ${literal(own)}`];
}

const notInternal = (catalog: string, oid: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.${catalog}'::pg_catalog.regclass AND d.objid = ${oid} AND d.deptype = 'i')`;

/** What depends on an object of catalog `catalog` (a normal dependency), as the server describes each. */
const dependentsOf = (catalog: string, oid: string): string =>
  `ARRAY(SELECT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) FROM pg_catalog.pg_depend d
         WHERE d.refclassid = 'pg_catalog.${catalog}'::pg_catalog.regclass AND d.refobjid = ${oid} AND d.deptype = 'n' ORDER BY 1)`;

/** A collation's name as a clause: a `pg_catalog` one bare. */
const collationName = (oid: string): string =>
  `(SELECT CASE WHEN cn.nspname = 'pg_catalog' THEN pg_catalog.quote_ident(co.collname) ELSE pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname) END ` +
  `FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = ${oid})`;

/** A function named by a `regproc` column, or nothing for 0 (which `regproc` prints as `-`). */
const proc = (column: string): string => `NULLIF(${column}::text, '-')`;

const dependents = (r: Row): { dependents?: string[] } => {
  const d = (r.dependents as string[] | null) ?? [];
  return d.length > 0 ? { dependents: d } : {};
};

const withComment = (r: Row): { comment?: string } => (str(r.comment) ? { comment: str(r.comment)! } : {});

/** Composite and range types: read where the enums are, before the domains and tables that may use them. */
export async function readTypeKinds(client: PostgresClient, scope: SchemaScope): Promise<LivePgObject[]> {
  const out: LivePgObject[] = [];
  const s = scopeSql("n.nspname", scope);

  // Composite types: the standalone ones, not a table's or a view's row type.
  const composites = await client.query<Row>(
    `SELECT t.oid::text AS oid, n.nspname AS schema, t.typname AS name, pg_catalog.obj_description(t.oid, 'pg_type') AS comment,
            ARRAY(SELECT pg_catalog.quote_ident(a.attname) || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) ||
                         CASE WHEN a.attcollation <> 0 AND a.attcollation <> at.typcollation THEN ' COLLATE ' || ${collationName("a.attcollation")} ELSE '' END
                  FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_type at ON at.oid = a.atttypid
                  WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum) AS attributes,
            ${dependentsOf("pg_type", "t.oid")} AS dependents
     FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
     WHERE t.typtype = 'c' AND c.relkind = 'c' AND ${s.sql} AND ${notExtensionOwned("pg_type", "t.oid")}
     ORDER BY n.nspname ${C}, t.typname ${C}`,
    s.params,
  );
  for (const r of composites) {
    const q = qname(String(r.schema), String(r.name));
    const attributes = (r.attributes as string[] | null) ?? [];
    out.push({
      type: POSTGRES_ENTITY_TYPES.composite,
      schema: String(r.schema),
      name: String(r.name),
      oid: String(r.oid),
      ...withComment(r),
      ...dependents(r),
      statement: [`CREATE TYPE ${q} AS (${attributes.length > 0 ? `\n    ${attributes.join(",\n    ")}\n` : ""})`, ...commentOn(`TYPE ${q}`, r.comment)].join(";\n"),
    });
  }

  // Range types, each with the options that differ from what CREATE TYPE ... AS RANGE would choose.
  const ranges = await client.query<Row>(
    `SELECT t.oid::text AS oid, n.nspname AS schema, t.typname AS name, pg_catalog.obj_description(t.oid, 'pg_type') AS comment,
            pg_catalog.format_type(r.rngsubtype, NULL) AS subtype,
            CASE WHEN r.rngsubopc <> (SELECT o.oid FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_am am ON am.oid = o.opcmethod
                                      WHERE am.amname = 'btree' AND o.opcintype = r.rngsubtype AND o.opcdefault LIMIT 1)
                 THEN (SELECT CASE WHEN on2.nspname = 'pg_catalog' THEN pg_catalog.quote_ident(o.opcname) ELSE pg_catalog.quote_ident(on2.nspname) || '.' || pg_catalog.quote_ident(o.opcname) END
                       FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace on2 ON on2.oid = o.opcnamespace WHERE o.oid = r.rngsubopc) END AS opclass,
            CASE WHEN r.rngcollation <> 0 AND r.rngcollation <> st.typcollation THEN ${collationName("r.rngcollation")} END AS collation,
            ${proc("r.rngcanonical")} AS canonical, ${proc("r.rngsubdiff")} AS subdiff,
            mn.nspname AS multi_schema, mt.typname AS multi_name,
            ${dependentsOf("pg_type", "t.oid")} AS dependents
     FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace JOIN pg_catalog.pg_range r ON r.rngtypid = t.oid
     JOIN pg_catalog.pg_type st ON st.oid = r.rngsubtype
     JOIN pg_catalog.pg_type mt ON mt.oid = r.rngmultitypid JOIN pg_catalog.pg_namespace mn ON mn.oid = mt.typnamespace
     WHERE t.typtype = 'r' AND ${s.sql} AND ${notExtensionOwned("pg_type", "t.oid")}
     ORDER BY n.nspname ${C}, t.typname ${C}`,
    s.params,
  );
  for (const r of ranges) {
    const schema = String(r.schema);
    const name = String(r.name);
    const q = qname(schema, name);
    const opts = [`SUBTYPE = ${r.subtype}`];
    if (str(r.opclass)) opts.push(`SUBTYPE_OPCLASS = ${r.opclass}`);
    if (str(r.collation)) opts.push(`COLLATION = ${r.collation}`);
    if (str(r.canonical)) opts.push(`CANONICAL = ${r.canonical}`);
    if (str(r.subdiff)) opts.push(`SUBTYPE_DIFF = ${r.subdiff}`);
    // The multirange type's name, when it is not the one Postgres derives in the range's schema.
    const at = name.indexOf("range");
    const derived = at >= 0 ? `${name.slice(0, at)}multi${name.slice(at)}` : `${name}_multirange`;
    if (String(r.multi_schema) !== schema || String(r.multi_name) !== derived) opts.push(`MULTIRANGE_TYPE_NAME = ${qname(String(r.multi_schema), String(r.multi_name))}`);
    out.push({
      type: POSTGRES_ENTITY_TYPES.range,
      schema,
      name,
      oid: String(r.oid),
      ...withComment(r),
      ...dependents(r),
      statement: [`CREATE TYPE ${q} AS RANGE (${opts.join(", ")})`, ...commentOn(`TYPE ${q}`, r.comment)].join(";\n"),
    });
  }
  return out;
}

/** Collations: read first, before the types and tables whose columns use them. */
export async function readCollations(client: PostgresClient, scope: SchemaScope): Promise<LivePgObject[]> {
  const s = scopeSql("n.nspname", scope);
  const rows = await client.query<Row>(
    `SELECT c.oid::text AS oid, n.nspname AS schema, c.collname AS name, pg_catalog.to_jsonb(c) AS def,
            pg_catalog.obj_description(c.oid, 'pg_collation') AS comment, ${dependentsOf("pg_collation", "c.oid")} AS dependents
     FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace
     WHERE ${s.sql} AND ${notExtensionOwned("pg_collation", "c.oid")}
     ORDER BY n.nspname ${C}, c.collname ${C}`,
    s.params,
  );
  const out: LivePgObject[] = [];
  for (const r of rows) {
    // The row as JSON: its columns differ across the majors (`colliculocale` in 15 and 16, `colllocale` from 17, `collicurules` from 16).
    const d = (typeof r.def === "string" ? JSON.parse(r.def) : r.def) as Record<string, unknown>;
    const provider = ({ c: "libc", i: "icu", b: "builtin", d: "default" } as Record<string, string>)[String(d.collprovider)] ?? "libc";
    const locale = str(d.colllocale) ?? str(d.colliculocale);
    const opts: string[] = [];
    if (provider !== "libc") opts.push(`PROVIDER = ${provider}`);
    if (provider === "libc" || locale === undefined) {
      const collate = str(d.collcollate) ?? "";
      const ctype = str(d.collctype) ?? "";
      if (provider !== "libc") opts.push(`LOCALE = ${literal(collate)}`);
      else if (collate === ctype) opts.push(`LOCALE = ${literal(collate)}`);
      else opts.push(`LC_COLLATE = ${literal(collate)}`, `LC_CTYPE = ${literal(ctype)}`);
    } else opts.push(`LOCALE = ${literal(locale)}`);
    if (d.collisdeterministic === false) opts.push("DETERMINISTIC = false");
    if (str(d.collicurules)) opts.push(`RULES = ${literal(String(d.collicurules))}`);
    const q = qname(String(r.schema), String(r.name));
    out.push({
      type: POSTGRES_ENTITY_TYPES.collation,
      schema: String(r.schema),
      name: String(r.name),
      oid: String(r.oid),
      ...withComment(r),
      ...dependents(r),
      statement: [`CREATE COLLATION ${q} (${opts.join(", ")})`, ...commentOn(`COLLATION ${q}`, r.comment)].join(";\n"),
    });
  }
  return out;
}

const MODIFY: Record<string, string> = { r: "READ_ONLY", s: "SHAREABLE", w: "READ_WRITE" };

/** Aggregates, casts and event triggers: read after the functions they call. */
export async function readRoutineKinds(client: PostgresClient, scope: SchemaScope): Promise<LivePgObject[]> {
  const out: LivePgObject[] = [];
  const s = scopeSql("n.nspname", scope);

  const aggregates = await client.query<Row>(
    `SELECT p.oid::text AS oid, n.nspname AS schema, p.proname AS name, pg_catalog.pg_get_function_arguments(p.oid) AS args,
            ARRAY(SELECT pg_catalog.format_type(u.x, NULL) FROM pg_catalog.unnest(p.proargtypes::pg_catalog.oid[]) WITH ORDINALITY AS u(x, i) ORDER BY u.i) AS argtypes,
            a.aggkind AS kind, a.aggnumdirectargs AS ndirect,
            ${proc("a.aggtransfn")} AS sfunc, pg_catalog.format_type(a.aggtranstype, NULL) AS stype, a.aggtransspace AS sspace,
            ${proc("a.aggfinalfn")} AS finalfunc, a.aggfinalextra AS finalextra, a.aggfinalmodify::text AS finalmodify,
            ${proc("a.aggcombinefn")} AS combinefunc, ${proc("a.aggserialfn")} AS serialfunc, ${proc("a.aggdeserialfn")} AS deserialfunc,
            a.agginitval AS initcond,
            ${proc("a.aggmtransfn")} AS msfunc, ${proc("a.aggminvtransfn")} AS minvfunc,
            CASE WHEN a.aggmtranstype <> 0 THEN pg_catalog.format_type(a.aggmtranstype, NULL) END AS mstype, a.aggmtransspace AS msspace,
            ${proc("a.aggmfinalfn")} AS mfinalfunc, a.aggmfinalextra AS mfinalextra, a.aggmfinalmodify::text AS mfinalmodify, a.aggminitval AS minitcond,
            CASE WHEN a.aggsortop <> 0 THEN (SELECT CASE WHEN opn.nspname = 'pg_catalog' THEN o.oprname ELSE 'OPERATOR(' || pg_catalog.quote_ident(opn.nspname) || '.' || o.oprname || ')' END
                                              FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace opn ON opn.oid = o.oprnamespace WHERE o.oid = a.aggsortop) END AS sortop,
            p.proparallel AS parallel, pg_catalog.obj_description(p.oid, 'pg_proc') AS comment,
            ${dependentsOf("pg_proc", "p.oid")} AS dependents
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_aggregate a ON a.aggfnoid = p.oid
     WHERE p.prokind = 'a' AND ${s.sql} AND ${notExtensionOwned("pg_proc", "p.oid")}
     ORDER BY n.nspname ${C}, p.proname ${C}, pg_catalog.oidvectortypes(p.proargtypes) ${C}`,
    s.params,
  );
  for (const r of aggregates) {
    const kind = String(r.kind);
    const types = (r.argtypes as string[] | null) ?? [];
    const ndirect = Number(r.ndirect ?? 0);
    const signature =
      kind === "n"
        ? `(${types.length === 0 ? "*" : types.join(",")})`
        : `(${ndirect > 0 ? `${types.slice(0, ndirect).join(",")} ` : ""}ORDER BY ${types.slice(ndirect).join(",")})`;
    const args = str(r.args) || "*";
    const modifyDefault = kind === "n" ? "r" : "w";
    const opts = [`SFUNC = ${r.sfunc}`, `STYPE = ${r.stype}`];
    if (Number(r.sspace) !== 0) opts.push(`SSPACE = ${Number(r.sspace)}`);
    if (str(r.finalfunc)) opts.push(`FINALFUNC = ${r.finalfunc}`);
    if (r.finalextra === true) opts.push("FINALFUNC_EXTRA");
    if (str(r.finalmodify) && r.finalmodify !== modifyDefault) opts.push(`FINALFUNC_MODIFY = ${MODIFY[String(r.finalmodify)]}`);
    if (str(r.combinefunc)) opts.push(`COMBINEFUNC = ${r.combinefunc}`);
    if (str(r.serialfunc)) opts.push(`SERIALFUNC = ${r.serialfunc}`);
    if (str(r.deserialfunc)) opts.push(`DESERIALFUNC = ${r.deserialfunc}`);
    if (str(r.initcond) !== undefined) opts.push(`INITCOND = ${literal(String(r.initcond))}`);
    if (str(r.msfunc)) {
      opts.push(`MSFUNC = ${r.msfunc}`);
      if (str(r.minvfunc)) opts.push(`MINVFUNC = ${r.minvfunc}`);
      if (str(r.mstype)) opts.push(`MSTYPE = ${r.mstype}`);
      if (Number(r.msspace) !== 0) opts.push(`MSSPACE = ${Number(r.msspace)}`);
      if (str(r.mfinalfunc)) opts.push(`MFINALFUNC = ${r.mfinalfunc}`);
      if (r.mfinalextra === true) opts.push("MFINALFUNC_EXTRA");
      if (str(r.mfinalmodify) && r.mfinalmodify !== modifyDefault) opts.push(`MFINALFUNC_MODIFY = ${MODIFY[String(r.mfinalmodify)]}`);
      if (str(r.minitcond) !== undefined) opts.push(`MINITCOND = ${literal(String(r.minitcond))}`);
    }
    if (str(r.sortop)) opts.push(`SORTOP = ${r.sortop}`);
    if (r.parallel === "s") opts.push("PARALLEL = SAFE");
    else if (r.parallel === "r") opts.push("PARALLEL = RESTRICTED");
    if (kind === "h") opts.push("HYPOTHETICAL");
    const q = qname(String(r.schema), String(r.name));
    out.push({
      type: POSTGRES_ENTITY_TYPES.aggregate,
      schema: String(r.schema),
      name: String(r.name),
      oid: String(r.oid),
      signature,
      ...withComment(r),
      ...dependents(r),
      statement: [`CREATE AGGREGATE ${q}(${args}) (${opts.join(", ")})`, ...commentOn(`AGGREGATE ${q}(${args})`, r.comment)].join(";\n"),
    });
  }

  // Casts the database defines: the server's own have oids below the first normal object id. In scope when a type or the function is.
  const scoped = (column: string) =>
    scope.schemas
      ? `(SELECT xn.nspname FROM pg_catalog.pg_type x JOIN pg_catalog.pg_namespace xn ON xn.oid = x.typnamespace WHERE x.oid = ${column}) = ANY($1::text[])`
      : "true";
  const casts = await client.query<Row>(
    `SELECT c.oid::text AS oid, pg_catalog.format_type(c.castsource, NULL) AS source, pg_catalog.format_type(c.casttarget, NULL) AS target,
            c.castmethod::text AS method, c.castcontext::text AS context,
            CASE WHEN c.castfunc <> 0 THEN c.castfunc::pg_catalog.regprocedure::text END AS func,
            pg_catalog.obj_description(c.oid, 'pg_cast') AS comment, ${dependentsOf("pg_cast", "c.oid")} AS dependents
     FROM pg_catalog.pg_cast c
     WHERE c.oid >= 16384 AND ${notExtensionOwned("pg_cast", "c.oid")} AND ${notInternal("pg_cast", "c.oid")}
       AND (${scoped("c.castsource")} OR ${scoped("c.casttarget")}
            OR ${scope.schemas ? `(SELECT pn.nspname FROM pg_catalog.pg_proc pp JOIN pg_catalog.pg_namespace pn ON pn.oid = pp.pronamespace WHERE pp.oid = c.castfunc) = ANY($1::text[])` : "true"})
     ORDER BY pg_catalog.format_type(c.castsource, NULL) ${C}, pg_catalog.format_type(c.casttarget, NULL) ${C}`,
    scope.schemas ? [[...scope.schemas]] : [],
  );
  for (const r of casts) {
    const name = `(${r.source} AS ${r.target})`;
    const how = r.method === "b" ? "WITHOUT FUNCTION" : r.method === "i" ? "WITH INOUT" : `WITH FUNCTION ${r.func}`;
    const context = r.context === "a" ? " AS ASSIGNMENT" : r.context === "i" ? " AS IMPLICIT" : "";
    out.push({
      type: POSTGRES_ENTITY_TYPES.cast,
      name,
      oid: String(r.oid),
      ...withComment(r),
      ...dependents(r),
      statement: [`CREATE CAST ${name} ${how}${context}`, ...commentOn(`CAST ${name}`, r.comment)].join(";\n"),
    });
  }

  // Event triggers: the database's, in scope when their function is.
  const fs = scopeSql("fn.nspname", scope);
  const events = await client.query<Row>(
    `SELECT e.oid::text AS oid, e.evtname AS name, e.evtevent AS event, ${proc("e.evtfoid::pg_catalog.regproc")} AS func, e.evttags AS tags,
            pg_catalog.obj_description(e.oid, 'pg_event_trigger') AS comment
     FROM pg_catalog.pg_event_trigger e JOIN pg_catalog.pg_proc f ON f.oid = e.evtfoid JOIN pg_catalog.pg_namespace fn ON fn.oid = f.pronamespace
     WHERE ${fs.sql} AND ${notExtensionOwned("pg_event_trigger", "e.oid")}
     ORDER BY e.evtname ${C}`,
    fs.params,
  );
  for (const r of events) {
    const name = quoteIdent(String(r.name));
    const tags = (r.tags as string[] | null) ?? [];
    out.push({
      type: POSTGRES_ENTITY_TYPES.eventTrigger,
      name: String(r.name),
      oid: String(r.oid),
      ...withComment(r),
      statement: [
        `CREATE EVENT TRIGGER ${name} ON ${quoteIdent(String(r.event))}${tags.length > 0 ? ` WHEN TAG IN (${tags.map(literal).join(", ")})` : ""} EXECUTE FUNCTION ${r.func}()`,
        ...commentOn(`EVENT TRIGGER ${name}`, r.comment),
      ].join(";\n"),
    });
  }
  return out;
}
