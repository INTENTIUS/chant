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
import { isSecretOption } from "../secret-options";

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
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dep_ WHERE dep_.classid = 'pg_catalog.${catalog}'::pg_catalog.regclass AND dep_.objid = ${oid} AND dep_.deptype = 'i')`;

/** What depends on an object of catalog `catalog` (a normal dependency), as the server describes each. */
const dependentsOf = (catalog: string, oid: string): string =>
  // `dep_`, not `d`: a caller's own alias (the text search dictionary query's `d`) would otherwise shadow it.
  `ARRAY(SELECT pg_catalog.pg_describe_object(dep_.classid, dep_.objid, dep_.objsubid) FROM pg_catalog.pg_depend dep_
         WHERE dep_.refclassid = 'pg_catalog.${catalog}'::pg_catalog.regclass AND dep_.refobjid = ${oid} AND dep_.deptype = 'n' ORDER BY 1)`;

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

/** An operator named by another's COMMUTATOR or NEGATOR, as `OPERATOR(schema.symbol)`. */
const operatorRef = (column: string): string =>
  `(SELECT 'OPERATOR(' || pg_catalog.quote_ident(rn.nspname) || '.' || r.oprname || ')' FROM pg_catalog.pg_operator r JOIN pg_catalog.pg_namespace rn ON rn.oid = r.oprnamespace WHERE r.oid = ${column})`;

/**
 * Operators: the ones a schema defines, not the server's own (oids below the
 * first normal object id) or an extension's. Identified by name and operand
 * types, `NONE` for a missing side (`DROP OPERATOR`'s spelling).
 */
export async function readOperators(client: PostgresClient, scope: SchemaScope): Promise<LivePgObject[]> {
  const s = scopeSql("n.nspname", scope);
  const rows = await client.query<Row>(
    `SELECT o.oid::text AS oid, n.nspname AS schema, o.oprname AS name,
            CASE WHEN o.oprleft <> 0 THEN pg_catalog.format_type(o.oprleft, NULL) END AS leftarg,
            CASE WHEN o.oprright <> 0 THEN pg_catalog.format_type(o.oprright, NULL) END AS rightarg,
            ${proc("o.oprcode::pg_catalog.regproc")} AS func, ${operatorRef("o.oprcom")} AS commutator, ${operatorRef("o.oprnegate")} AS negator,
            ${proc("o.oprrest::pg_catalog.regproc")} AS restrict, ${proc("o.oprjoin::pg_catalog.regproc")} AS join_func,
            o.oprcanhash AS hashes, o.oprcanmerge AS merges,
            pg_catalog.obj_description(o.oid, 'pg_operator') AS comment, ${dependentsOf("pg_operator", "o.oid")} AS dependents
     FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace
     WHERE ${s.sql} AND o.oid >= 16384 AND ${notExtensionOwned("pg_operator", "o.oid")}
     ORDER BY n.nspname ${C}, o.oprname ${C}, pg_catalog.format_type(o.oprleft, NULL) ${C} NULLS FIRST, pg_catalog.format_type(o.oprright, NULL) ${C} NULLS FIRST`,
    s.params,
  );
  return rows.map((r) => {
    const left = str(r.leftarg);
    const right = str(r.rightarg);
    const signature = `(${left ?? "NONE"},${right ?? "NONE"})`;
    const name = `${quoteIdent(String(r.schema))}.${r.name}`;
    const opts = [`FUNCTION = ${r.func}`];
    if (left) opts.push(`LEFTARG = ${left}`);
    if (right) opts.push(`RIGHTARG = ${right}`);
    if (str(r.commutator)) opts.push(`COMMUTATOR = ${r.commutator}`);
    if (str(r.negator)) opts.push(`NEGATOR = ${r.negator}`);
    if (str(r.restrict)) opts.push(`RESTRICT = ${r.restrict}`);
    if (str(r.join_func)) opts.push(`JOIN = ${r.join_func}`);
    if (r.hashes === true) opts.push("HASHES");
    if (r.merges === true) opts.push("MERGES");
    return {
      type: POSTGRES_ENTITY_TYPES.operator,
      schema: String(r.schema),
      name: String(r.name),
      oid: String(r.oid),
      signature,
      ...withComment(r),
      ...dependents(r),
      statement: [`CREATE OPERATOR ${name} (${opts.join(", ")})`, ...commentOn(`OPERATOR ${name}${signature}`, r.comment)].join(";\n"),
    };
  });
}

/** An `OPTIONS (...)` clause from a catalog `text[]` of `name=value`, and the names left out because they hold a credential. */
function optionsOf(raw: unknown): { clause: string; omitted: string[] } {
  const kept: string[] = [];
  const omitted: string[] = [];
  for (const entry of (raw as string[] | null) ?? []) {
    const at = entry.indexOf("=");
    const name = at < 0 ? entry : entry.slice(0, at);
    if (isSecretOption(name)) omitted.push(name);
    else kept.push(`${quoteIdent(name)} ${literal(at < 0 ? "" : entry.slice(at + 1))}`);
  }
  return { clause: kept.length > 0 ? ` OPTIONS (${kept.join(", ")})` : "", omitted };
}

const omittedWarning = (omitted: readonly string[]): { warnings?: string[] } =>
  omitted.length > 0 ? { warnings: [`the option${omitted.length === 1 ? "" : "s"} ${omitted.join(", ")} hold${omitted.length === 1 ? "s" : ""} a credential and ${omitted.length === 1 ? "is" : "are"} left out; the environment supplies it`] } : {};

/**
 * The kinds of object #3911 adds that belong to the database or hang off a
 * table: extended statistics (printed by the server), foreign data wrappers
 * and servers, and publications, each assembled from its catalog rows. A
 * wrapper, server or publication is the database's, so the schema scope does
 * not narrow it. A credential in an option is left out and said so.
 */
export async function readDatabaseKinds(client: PostgresClient, scope: SchemaScope): Promise<LivePgObject[]> {
  const out: LivePgObject[] = [...(await readOperators(client, scope))];

  const s = scopeSql("n.nspname", scope);
  const stats = await client.query<Row>(
    `SELECT e.oid::text AS oid, n.nspname AS schema, e.stxname AS name, pg_catalog.pg_get_statisticsobjdef(e.oid) AS def,
            pg_catalog.obj_description(e.oid, 'pg_statistic_ext') AS comment
     FROM pg_catalog.pg_statistic_ext e JOIN pg_catalog.pg_namespace n ON n.oid = e.stxnamespace
     WHERE ${s.sql} AND ${notExtensionOwned("pg_statistic_ext", "e.oid")}
     ORDER BY n.nspname ${C}, e.stxname ${C}`,
    s.params,
  );
  for (const r of stats) {
    const q = qname(String(r.schema), String(r.name));
    out.push({
      type: POSTGRES_ENTITY_TYPES.statistics,
      schema: String(r.schema),
      name: String(r.name),
      oid: String(r.oid),
      ...withComment(r),
      statement: [String(r.def), ...commentOn(`STATISTICS ${q}`, r.comment)].join(";\n"),
    });
  }

  const wrappers = await client.query<Row>(
    `SELECT w.oid::text AS oid, w.fdwname AS name, ${proc("w.fdwhandler::pg_catalog.regproc")} AS handler, ${proc("w.fdwvalidator::pg_catalog.regproc")} AS validator,
            w.fdwoptions AS options, pg_catalog.obj_description(w.oid, 'pg_foreign_data_wrapper') AS comment, ${dependentsOf("pg_foreign_data_wrapper", "w.oid")} AS dependents
     FROM pg_catalog.pg_foreign_data_wrapper w
     WHERE ${notExtensionOwned("pg_foreign_data_wrapper", "w.oid")}
     ORDER BY w.fdwname ${C}`,
  );
  for (const r of wrappers) {
    const name = quoteIdent(String(r.name));
    const { clause, omitted } = optionsOf(r.options);
    out.push({
      type: POSTGRES_ENTITY_TYPES.foreignDataWrapper,
      name: String(r.name),
      oid: String(r.oid),
      ...withComment(r),
      ...dependents(r),
      ...omittedWarning(omitted),
      statement: [
        `CREATE FOREIGN DATA WRAPPER ${name}${str(r.handler) ? ` HANDLER ${r.handler}` : ""}${str(r.validator) ? ` VALIDATOR ${r.validator}` : ""}${clause}`,
        ...commentOn(`FOREIGN DATA WRAPPER ${name}`, r.comment),
      ].join(";\n"),
    });
  }

  const servers = await client.query<Row>(
    `SELECT v.oid::text AS oid, v.srvname AS name, v.srvtype AS type, v.srvversion AS version, w.fdwname AS wrapper, v.srvoptions AS options,
            pg_catalog.obj_description(v.oid, 'pg_foreign_server') AS comment, ${dependentsOf("pg_foreign_server", "v.oid")} AS dependents
     FROM pg_catalog.pg_foreign_server v JOIN pg_catalog.pg_foreign_data_wrapper w ON w.oid = v.srvfdw
     WHERE ${notExtensionOwned("pg_foreign_server", "v.oid")}
     ORDER BY v.srvname ${C}`,
  );
  for (const r of servers) {
    const name = quoteIdent(String(r.name));
    const { clause, omitted } = optionsOf(r.options);
    out.push({
      type: POSTGRES_ENTITY_TYPES.foreignServer,
      name: String(r.name),
      oid: String(r.oid),
      ...withComment(r),
      ...dependents(r),
      ...omittedWarning(omitted),
      statement: [
        `CREATE SERVER ${name}${str(r.type) ? ` TYPE ${literal(String(r.type))}` : ""}${str(r.version) ? ` VERSION ${literal(String(r.version))}` : ""} FOREIGN DATA WRAPPER ${quoteIdent(String(r.wrapper))}${clause}`,
        ...commentOn(`SERVER ${name}`, r.comment),
      ].join(";\n"),
    });
  }

  out.push(...(await readPublications(client)));
  out.push(...(await readOperatorClasses(client, scope)), ...(await readTextSearch(client, scope)), ...(await readForeignTables(client, scope)));
  return out;
}

/** Publications. Column lists, row filters and schema members are 15's; they are read where the catalog has them. */
async function readPublications(client: PostgresClient): Promise<LivePgObject[]> {
  const has = async (catalog: string, column?: string): Promise<boolean> => {
    const rows = await client.query<Row>(
      column
        ? `SELECT 1 AS x FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('pg_catalog.${catalog}') AND attname = '${column}' AND NOT attisdropped`
        : `SELECT 1 AS x WHERE to_regclass('pg_catalog.${catalog}') IS NOT NULL`,
    );
    return rows.length > 0;
  };
  const columnLists = await has("pg_publication_rel", "prattrs");
  const schemaMembers = await has("pg_publication_namespace");

  const pubs = await client.query<Row>(
    `SELECT p.oid::text AS oid, p.pubname AS name, p.puballtables AS alltables, p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate,
            pg_catalog.to_jsonb(p) AS def, pg_catalog.obj_description(p.oid, 'pg_publication') AS comment
     FROM pg_catalog.pg_publication p
     WHERE ${notExtensionOwned("pg_publication", "p.oid")}
     ORDER BY p.pubname ${C}`,
  );
  const out: LivePgObject[] = [];
  for (const r of pubs) {
    const name = quoteIdent(String(r.name));
    const d = (typeof r.def === "string" ? JSON.parse(r.def) : r.def) as Record<string, unknown>;
    const tables = r.alltables
      ? []
      : await client.query<Row>(
          `SELECT n.nspname AS schema, c.relname AS name,
                  ${columnLists ? "ARRAY(SELECT pg_catalog.quote_ident(a.attname) FROM pg_catalog.pg_attribute a WHERE a.attrelid = r.prrelid AND a.attnum = ANY(r.prattrs::pg_catalog.int2[]) ORDER BY a.attnum)" : "NULL::text[]"} AS columns,
                  ${columnLists ? "pg_catalog.pg_get_expr(r.prqual, r.prrelid)" : "NULL::text"} AS filter
           FROM pg_catalog.pg_publication_rel r JOIN pg_catalog.pg_class c ON c.oid = r.prrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE r.prpubid = $1::oid ORDER BY n.nspname ${C}, c.relname ${C}`,
          [String(r.oid)],
        );
    const schemas =
      schemaMembers && !r.alltables
        ? await client.query<Row>(
            `SELECT n.nspname AS name FROM pg_catalog.pg_publication_namespace pn JOIN pg_catalog.pg_namespace n ON n.oid = pn.pnnspid WHERE pn.pnpubid = $1::oid ORDER BY n.nspname ${C}`,
            [String(r.oid)],
          )
        : [];
    const members = [
      ...tables.map((t) => {
        const columns = (t.columns as string[] | null) ?? [];
        return `${qname(String(t.schema), String(t.name))}${columns.length > 0 ? ` (${columns.join(", ")})` : ""}${str(t.filter) ? ` WHERE (${t.filter})` : ""}`;
      }),
    ];
    const clauses: string[] = [];
    if (r.alltables) clauses.push("FOR ALL TABLES");
    else if (members.length > 0 || schemas.length > 0) {
      const parts: string[] = [];
      if (members.length > 0) parts.push(`TABLE ${members.join(", ")}`);
      if (schemas.length > 0) parts.push(`TABLES IN SCHEMA ${schemas.map((x) => quoteIdent(String(x.name))).join(", ")}`);
      clauses.push(`FOR ${parts.join(", ")}`);
    }
    const publish = [r.pubinsert && "insert", r.pubupdate && "update", r.pubdelete && "delete", r.pubtruncate && "truncate"].filter(Boolean);
    const options: string[] = [];
    if (publish.length !== 4) options.push(`publish = ${literal(publish.join(", "))}`);
    if (d.pubviaroot === true) options.push("publish_via_partition_root = true");
    if (d.pubgencols !== undefined && d.pubgencols !== "n") options.push("publish_generated_columns = stored");
    if (options.length > 0) clauses.push(`WITH (${options.join(", ")})`);
    out.push({
      type: POSTGRES_ENTITY_TYPES.publication,
      name: String(r.name),
      oid: String(r.oid),
      ...withComment(r),
      statement: [`CREATE PUBLICATION ${name}${clauses.length > 0 ? ` ${clauses.join(" ")}` : ""}`, ...commentOn(`PUBLICATION ${name}`, r.comment)].join(";\n"),
    });
  }
  return out;
}

// ── Operator classes and families, text search, foreign tables (#4406) ──

/** An object named by `schema`.`name` columns, as a clause: a `pg_catalog` one bare. */
const refName = (schema: string, name: string): string =>
  `CASE WHEN ${schema} = 'pg_catalog' THEN pg_catalog.quote_ident(${name}) ELSE pg_catalog.quote_ident(${schema}) || '.' || pg_catalog.quote_ident(${name}) END`;

/** An operand type, `NONE` for the missing side of a prefix operator. */
const operand = (column: string): string => `CASE WHEN ${column} = 0 THEN 'NONE' ELSE pg_catalog.format_type(${column}, NULL) END`;

/**
 * Operator classes and families. A class carries its members: the operators
 * and support functions that depend on it (`pg_depend`, a member made by
 * CREATE OPERATOR CLASS depends on the class; one added by ALTER OPERATOR
 * FAMILY ... ADD depends on the family and is "loose"). A family named as its
 * class, in the same schema, is the one CREATE OPERATOR CLASS made for it and
 * is the class's; every other family is read, with a warning when it holds
 * loose members, which a declaration cannot carry.
 */
async function readOperatorClasses(client: PostgresClient, scope: SchemaScope): Promise<LivePgObject[]> {
  const out: LivePgObject[] = [];
  const s = scopeSql("n.nspname", scope);
  const member = (catalog: string, alias: string) =>
    `JOIN pg_catalog.pg_depend dep ON dep.classid = '${catalog}'::pg_catalog.regclass AND dep.objid = ${alias}.oid AND dep.refclassid = 'pg_catalog.pg_opclass'::pg_catalog.regclass AND dep.refobjid = c.oid`;
  const classes = await client.query<Row>(
    `SELECT c.oid::text AS oid, n.nspname AS schema, c.opcname AS name, am.amname AS method, c.opcdefault AS isdefault,
            pg_catalog.format_type(c.opcintype, NULL) AS type,
            CASE WHEN c.opckeytype <> 0 THEN pg_catalog.format_type(c.opckeytype, NULL) END AS storage,
            CASE WHEN f.opfname = c.opcname AND f.opfnamespace = c.opcnamespace THEN NULL ELSE ${refName("fn.nspname", "f.opfname")} END AS family,
            ARRAY(SELECT 'OPERATOR ' || o.amopstrategy || ' ' || pg_catalog.quote_ident(opn.nspname) || '.' || op.oprname ||
                         ' (' || ${operand("o.amoplefttype")} || ', ' || ${operand("o.amoprighttype")} || ')' ||
                         CASE WHEN o.amoppurpose = 'o' THEN ' FOR ORDER BY ' || (SELECT pg_catalog.quote_ident(sn.nspname) || '.' || pg_catalog.quote_ident(sf.opfname)
                              FROM pg_catalog.pg_opfamily sf JOIN pg_catalog.pg_namespace sn ON sn.oid = sf.opfnamespace WHERE sf.oid = o.amopsortfamily) ELSE '' END
                  FROM pg_catalog.pg_amop o ${member("pg_catalog.pg_amop", "o")}
                  JOIN pg_catalog.pg_operator op ON op.oid = o.amopopr JOIN pg_catalog.pg_namespace opn ON opn.oid = op.oprnamespace
                  ORDER BY o.amopstrategy, o.amoplefttype, o.amoprighttype) AS operators,
            ARRAY(SELECT 'FUNCTION ' || p.amprocnum || ' (' || ${operand("p.amproclefttype")} || ', ' || ${operand("p.amprocrighttype")} || ') ' || p.amproc::pg_catalog.regprocedure::pg_catalog.text
                  FROM pg_catalog.pg_amproc p ${member("pg_catalog.pg_amproc", "p")}
                  ORDER BY p.amprocnum, p.amproclefttype, p.amprocrighttype) AS functions,
            pg_catalog.obj_description(c.oid, 'pg_opclass') AS comment, ${dependentsOf("pg_opclass", "c.oid")} AS dependents
     FROM pg_catalog.pg_opclass c JOIN pg_catalog.pg_namespace n ON n.oid = c.opcnamespace JOIN pg_catalog.pg_am am ON am.oid = c.opcmethod
     JOIN pg_catalog.pg_opfamily f ON f.oid = c.opcfamily JOIN pg_catalog.pg_namespace fn ON fn.oid = f.opfnamespace
     WHERE ${s.sql} AND c.oid >= 16384 AND ${notExtensionOwned("pg_opclass", "c.oid")}
     ORDER BY n.nspname ${C}, c.opcname ${C}, am.amname ${C}`,
    s.params,
  );
  for (const r of classes) {
    const q = qname(String(r.schema), String(r.name));
    const method = String(r.method);
    const items = [...((r.operators as string[] | null) ?? []), ...((r.functions as string[] | null) ?? []), ...(str(r.storage) ? [`STORAGE ${r.storage}`] : [])];
    out.push({
      type: POSTGRES_ENTITY_TYPES.operatorClass,
      schema: String(r.schema),
      name: String(r.name),
      oid: String(r.oid),
      signature: ` USING ${method}`,
      ...withComment(r),
      ...dependents(r),
      ...(items.length === 0 ? { unsupported: "no operator, support function or storage type of it could be read; a CREATE OPERATOR CLASS needs at least one" } : {}),
      statement: [
        `CREATE OPERATOR CLASS ${q}${r.isdefault === true ? " DEFAULT" : ""} FOR TYPE ${r.type} USING ${method}${str(r.family) ? ` FAMILY ${r.family}` : ""} AS\n    ${items.join(",\n    ")}`,
        ...commentOn(`OPERATOR CLASS ${q} USING ${method}`, r.comment),
      ].join(";\n"),
    });
  }

  const families = await client.query<Row>(
    `SELECT f.oid::text AS oid, n.nspname AS schema, f.opfname AS name, am.amname AS method,
            (SELECT count(*) FROM (SELECT o.oid FROM pg_catalog.pg_amop o WHERE o.amopfamily = f.oid UNION ALL SELECT p.oid FROM pg_catalog.pg_amproc p WHERE p.amprocfamily = f.oid) m
              WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dep WHERE dep.classid IN ('pg_catalog.pg_amop'::pg_catalog.regclass, 'pg_catalog.pg_amproc'::pg_catalog.regclass)
                                AND dep.objid = m.oid AND dep.refclassid = 'pg_catalog.pg_opclass'::pg_catalog.regclass)) AS loose,
            pg_catalog.obj_description(f.oid, 'pg_opfamily') AS comment, ${dependentsOf("pg_opfamily", "f.oid")} AS dependents
     FROM pg_catalog.pg_opfamily f JOIN pg_catalog.pg_namespace n ON n.oid = f.opfnamespace JOIN pg_catalog.pg_am am ON am.oid = f.opfmethod
     WHERE ${s.sql} AND f.oid >= 16384 AND ${notExtensionOwned("pg_opfamily", "f.oid")}
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_opclass c WHERE c.opcfamily = f.oid AND c.opcname = f.opfname AND c.opcnamespace = f.opfnamespace)
     ORDER BY n.nspname ${C}, f.opfname ${C}, am.amname ${C}`,
    s.params,
  );
  for (const r of families) {
    const q = qname(String(r.schema), String(r.name));
    const method = String(r.method);
    const loose = Number(r.loose ?? 0);
    out.push({
      type: POSTGRES_ENTITY_TYPES.operatorFamily,
      schema: String(r.schema),
      name: String(r.name),
      oid: String(r.oid),
      signature: ` USING ${method}`,
      ...withComment(r),
      ...dependents(r),
      ...(loose > 0 ? { warnings: [`${loose} loose member${loose === 1 ? "" : "s"} added with ALTER OPERATOR FAMILY ... ADD ${loose === 1 ? "is" : "are"} left out; a declaration holds the family and its classes' members`] } : {}),
      statement: [`CREATE OPERATOR FAMILY ${q} USING ${method}`, ...commentOn(`OPERATOR FAMILY ${q} USING ${method}`, r.comment)].join(";\n"),
    });
  }
  return out;
}

/**
 * A dictionary's `dictinitoption`, which the server prints as
 * `name = 'value', ...` (a quote and a backslash doubled in the value), as a
 * list of name and value; undefined when the text is not that form.
 */
export function parseDictionaryOptions(init: string | undefined): Array<[string, string]> | undefined {
  if (init === undefined || init.trim() === "") return [];
  const out: Array<[string, string]> = [];
  const item = /\s*("(?:[^"]|"")+"|[^\s=,]+)\s*=\s*'((?:[^']|'')*)'\s*(?:,|$)/y;
  let at = 0;
  while (at < init.length) {
    item.lastIndex = at;
    const m = item.exec(init);
    if (!m) return undefined;
    const name = m[1]!.startsWith('"') ? m[1]!.slice(1, -1).replace(/""/g, '"') : m[1]!;
    out.push([name, m[2]!.replace(/''/g, "'").replace(/\\\\/g, "\\")]);
    at = item.lastIndex;
  }
  return out;
}

/** Text search dictionaries and configurations; a configuration's mappings are the ALTER ... ADD MAPPING statements after its CREATE. */
async function readTextSearch(client: PostgresClient, scope: SchemaScope): Promise<LivePgObject[]> {
  const out: LivePgObject[] = [];
  const s = scopeSql("n.nspname", scope);
  const dictionaries = await client.query<Row>(
    `SELECT d.oid::text AS oid, n.nspname AS schema, d.dictname AS name, d.dictinitoption AS init,
            (SELECT ${refName("tn.nspname", "t.tmplname")} FROM pg_catalog.pg_ts_template t JOIN pg_catalog.pg_namespace tn ON tn.oid = t.tmplnamespace WHERE t.oid = d.dicttemplate) AS template,
            pg_catalog.obj_description(d.oid, 'pg_ts_dict') AS comment, ${dependentsOf("pg_ts_dict", "d.oid")} AS dependents
     FROM pg_catalog.pg_ts_dict d JOIN pg_catalog.pg_namespace n ON n.oid = d.dictnamespace
     WHERE ${s.sql} AND d.oid >= 16384 AND ${notExtensionOwned("pg_ts_dict", "d.oid")}
     ORDER BY n.nspname ${C}, d.dictname ${C}`,
    s.params,
  );
  for (const r of dictionaries) {
    const q = qname(String(r.schema), String(r.name));
    const options = parseDictionaryOptions(str(r.init));
    out.push({
      type: POSTGRES_ENTITY_TYPES.textSearchDictionary,
      schema: String(r.schema),
      name: String(r.name),
      oid: String(r.oid),
      ...withComment(r),
      ...dependents(r),
      ...(options === undefined ? { unsupported: `its options (${str(r.init)}) are not in the form the server writes them` } : {}),
      statement: [
        `CREATE TEXT SEARCH DICTIONARY ${q} (${["TEMPLATE = " + r.template, ...(options ?? []).map(([k, v]) => `${quoteIdent(k)} = ${literal(v)}`)].join(", ")})`,
        ...commentOn(`TEXT SEARCH DICTIONARY ${q}`, r.comment),
      ].join(";\n"),
    });
  }

  const configurations = await client.query<Row>(
    `SELECT c.oid::text AS oid, n.nspname AS schema, c.cfgname AS name,
            (SELECT ${refName("pn.nspname", "p.prsname")} FROM pg_catalog.pg_ts_parser p JOIN pg_catalog.pg_namespace pn ON pn.oid = p.prsnamespace WHERE p.oid = c.cfgparser) AS parser,
            ARRAY(SELECT tt.alias || E'\\t' || pg_catalog.string_agg((SELECT ${refName("dn.nspname", "d.dictname")} FROM pg_catalog.pg_ts_dict d JOIN pg_catalog.pg_namespace dn ON dn.oid = d.dictnamespace WHERE d.oid = m.mapdict), ', ' ORDER BY m.mapseqno)
                  FROM pg_catalog.pg_ts_config_map m, pg_catalog.ts_token_type(c.cfgparser) tt WHERE m.mapcfg = c.oid AND tt.tokid = m.maptokentype
                  GROUP BY tt.tokid, tt.alias ORDER BY tt.tokid) AS mappings,
            pg_catalog.obj_description(c.oid, 'pg_ts_config') AS comment, ${dependentsOf("pg_ts_config", "c.oid")} AS dependents
     FROM pg_catalog.pg_ts_config c JOIN pg_catalog.pg_namespace n ON n.oid = c.cfgnamespace
     WHERE ${s.sql} AND c.oid >= 16384 AND ${notExtensionOwned("pg_ts_config", "c.oid")}
     ORDER BY n.nspname ${C}, c.cfgname ${C}`,
    s.params,
  );
  for (const r of configurations) {
    const q = qname(String(r.schema), String(r.name));
    // Token types that share their dictionaries share an ADD MAPPING, in the parser's token order.
    const groups = new Map<string, string[]>();
    for (const line of (r.mappings as string[] | null) ?? []) {
      const [token, dictionaries] = line.split("\t") as [string, string];
      groups.set(dictionaries, [...(groups.get(dictionaries) ?? []), quoteIdent(token)]);
    }
    out.push({
      type: POSTGRES_ENTITY_TYPES.textSearchConfiguration,
      schema: String(r.schema),
      name: String(r.name),
      oid: String(r.oid),
      ...withComment(r),
      ...dependents(r),
      statement: [
        `CREATE TEXT SEARCH CONFIGURATION ${q} (PARSER = ${r.parser})`,
        ...[...groups].map(([dicts, tokens]) => `ALTER TEXT SEARCH CONFIGURATION ${q} ADD MAPPING FOR ${tokens.join(", ")} WITH ${dicts}`),
        ...commentOn(`TEXT SEARCH CONFIGURATION ${q}`, r.comment),
      ].join(";\n"),
    });
  }
  return out;
}

/**
 * Foreign tables: their columns (type, collation, default, NOT NULL and
 * OPTIONS), CHECK constraints, server and OPTIONS. One that is a partition,
 * inherits or has a generated column is read as unsupported, since a
 * declaration does not hold those. An option that holds a credential is left
 * out and said so.
 */
async function readForeignTables(client: PostgresClient, scope: SchemaScope): Promise<LivePgObject[]> {
  const s = scopeSql("n.nspname", scope);
  const tables = await client.query<Row>(
    `SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, c.relispartition AS ispartition,
            EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid) AS inherits,
            fs.srvname AS server, ft.ftoptions AS options,
            pg_catalog.obj_description(c.oid, 'pg_class') AS comment, ${dependentsOf("pg_class", "c.oid")} AS dependents
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_foreign_table ft ON ft.ftrelid = c.oid JOIN pg_catalog.pg_foreign_server fs ON fs.oid = ft.ftserver
     WHERE c.relkind = 'f' AND ${s.sql} AND ${notExtensionOwned("pg_class", "c.oid")}
     ORDER BY n.nspname ${C}, c.relname ${C}`,
    s.params,
  );
  if (tables.length === 0) return [];
  const oids = tables.map((t) => String(t.oid));
  const columns = await client.query<Row>(
    `SELECT a.attrelid::text AS rel, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
            a.attgenerated::text AS generated, pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) AS dflt,
            CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN ${collationName("a.attcollation")} END AS collation,
            a.attfdwoptions AS options, pg_catalog.col_description(a.attrelid, a.attnum) AS comment
     FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attrelid, a.attnum`,
    [oids],
  );
  const checks = await client.query<Row>(
    `SELECT k.conrelid::text AS rel, k.conname AS name, pg_catalog.pg_get_constraintdef(k.oid, true) AS def, pg_catalog.obj_description(k.oid, 'pg_constraint') AS comment
     FROM pg_catalog.pg_constraint k
     WHERE k.conrelid = ANY($1::oid[]) AND k.contype = 'c' AND k.conislocal
     ORDER BY k.conrelid, k.conname ${C}`,
    [oids],
  );
  return tables.map((t): LivePgObject => {
    const rel = String(t.oid);
    const q = qname(String(t.schema), String(t.name));
    const omitted: string[] = [];
    const lines: string[] = [];
    const commentLines: string[] = [];
    let generated = false;
    for (const c of columns.filter((x) => String(x.rel) === rel)) {
      const parts = [quoteIdent(String(c.name)), String(c.type)];
      const opts = optionsOf(c.options);
      omitted.push(...opts.omitted);
      if (opts.clause) parts.push(opts.clause.trim());
      if (str(c.collation)) parts.push(`COLLATE ${c.collation}`);
      if (str(c.generated)) generated = true;
      else if (str(c.dflt)) parts.push(`DEFAULT ${c.dflt}`);
      if (c.notnull === true) parts.push("NOT NULL");
      lines.push(parts.join(" "));
      commentLines.push(...commentOn(`COLUMN ${q}.${quoteIdent(String(c.name))}`, c.comment));
    }
    for (const k of checks.filter((x) => String(x.rel) === rel)) {
      lines.push(`CONSTRAINT ${quoteIdent(String(k.name))} ${k.def}`);
      commentLines.push(...commentOn(`CONSTRAINT ${quoteIdent(String(k.name))} ON ${q}`, k.comment));
    }
    const { clause, omitted: tableOmitted } = optionsOf(t.options);
    omitted.push(...tableOmitted);
    const unsupported =
      t.ispartition === true ? "it is a partition of another table (CREATE FOREIGN TABLE ... PARTITION OF is not declared)" : t.inherits === true ? "it inherits from another table (INHERITS is not declared on a foreign table)" : generated ? "it has a generated column (not declared on a foreign table)" : undefined;
    return {
      type: POSTGRES_ENTITY_TYPES.foreignTable,
      schema: String(t.schema),
      name: String(t.name),
      oid: rel,
      ...withComment(t),
      ...dependents(t),
      ...omittedWarning(omitted),
      ...(unsupported ? { unsupported } : {}),
      statement: [
        `CREATE FOREIGN TABLE ${q} (${lines.length > 0 ? `\n    ${lines.join(",\n    ")}\n` : ""}) SERVER ${quoteIdent(String(t.server))}${clause}`,
        ...commentOn(`FOREIGN TABLE ${q}`, t.comment),
        ...commentLines,
      ].join(";\n"),
    };
  });
}
