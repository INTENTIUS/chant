/**
 * The objects in a live Postgres database of the kinds no declaration holds
 * (#3911), found so import can refuse them by name instead of leaving them
 * out (`../../core/undeclarable.ts`).
 *
 * One catalog query per kind the coverage table marks refused
 * (`../../coverage/postgres.json`), keyed by the row's `kind`. A kind whose
 * row is flipped to declared is no longer asked about: its objects are then
 * the catalog reader's (`./catalog.ts`) to read.
 *
 * Left out, as the reader leaves them out: the server's own schemas, objects
 * an extension owns (`pg_depend.deptype = 'e'`; the extension is declared),
 * the objects `initdb` makes, whose oids are below 16384
 * (`FirstNormalObjectId`), and an object that is part of another
 * (`deptype = 'i'`: the casts a range type makes for itself). An object in a
 * schema is looked for in the schemas in scope; one that belongs to the whole
 * database (a cast, an event trigger, a publication, a foreign data wrapper)
 * is always looked for.
 */

import type { PostgresClient } from "./client";
import { notExtensionOwned, scopeSql, type SchemaScope } from "./catalog";
import { KIND_COVERAGE } from "../../coverage";
import type { UndeclarableObject } from "../../core/undeclarable";

/** `FirstNormalObjectId`: every oid below it is the server's own. */
const FIRST_USER_OID = 16384;

interface Probe {
  /**
   * A query returning `schema` (NULL for a database-wide object), `name`, and
   * for a database-wide object the role that owns it (so a managed
   * provider's own can be told apart); `scope` is the predicate on `n.nspname`.
   */
  sql(scope: string): string;
}

const C = 'COLLATE "C"';

/** Not part of another object (`pg_depend.deptype = 'i'`): the multirange cast a range type makes for itself is the range type's. */
const notInternal = (catalog: string, oid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.${catalog}'::pg_catalog.regclass AND d.objid = ${oid} AND d.deptype = 'i')`;
const ns = (alias: string, column: string) => `JOIN pg_catalog.pg_namespace ${alias} ON ${alias}.oid = ${column}`;
const args = (oid: string) => `'(' || pg_catalog.replace(pg_catalog.oidvectortypes(${oid}), ', ', ',') || ')'`;

/** A probe for objects of a catalog in a schema, the catalog aliased `x`; `name` is the name expression. */
const inSchema = (catalog: string, nsColumn: string, name: string, where = "TRUE"): Probe => ({
  sql: (scope) =>
    `SELECT n.nspname AS schema, ${name} AS name, NULL::text AS owner FROM pg_catalog.${catalog} x ${ns("n", `x.${nsColumn}`)}
     WHERE ${where} AND ${scope} AND x.oid >= ${FIRST_USER_OID} AND ${notExtensionOwned(catalog, "x.oid")} AND ${notInternal(catalog, "x.oid")}`,
});

/** A probe for objects that belong to the database, not a schema. */
const databaseWide = (catalog: string, name: string, owner?: string): Probe => ({
  sql: () =>
    `SELECT NULL::text AS schema, ${name} AS name, ${owner ? `pg_catalog.pg_get_userbyid(x.${owner})` : "NULL::text"} AS owner FROM pg_catalog.${catalog} x
     WHERE x.oid >= ${FIRST_USER_OID} AND ${notExtensionOwned(catalog, "x.oid")} AND ${notInternal(catalog, "x.oid")}`,
});

/** The pg_type rows of one `typtype`. */
const type = (where: string) => inSchema("pg_type", "typnamespace", "x.typname", where);

export const POSTGRES_PROBES: Readonly<Record<string, Probe>> = {
  "access method": databaseWide("pg_am", "x.amname"),
  aggregate: inSchema("pg_proc", "pronamespace", `x.proname || ${args("x.proargtypes")}`, "x.prokind = 'a'"),
  "routine with a SQL-standard body": inSchema("pg_proc", "pronamespace", `x.proname || ${args("x.proargtypes")}`, "x.prokind IN ('f', 'p', 'w') AND x.prosqlbody IS NOT NULL"),
  cast: databaseWide("pg_cast", "'(' || pg_catalog.format_type(x.castsource, NULL) || ' AS ' || pg_catalog.format_type(x.casttarget, NULL) || ')'"),
  collation: inSchema("pg_collation", "collnamespace", "x.collname"),
  conversion: inSchema("pg_conversion", "connamespace", "x.conname"),
  "event trigger": databaseWide("pg_event_trigger", "x.evtname", "evtowner"),
  "foreign data wrapper": databaseWide("pg_foreign_data_wrapper", "x.fdwname", "fdwowner"),
  "foreign server": databaseWide("pg_foreign_server", "x.srvname", "srvowner"),
  "user mapping": {
    // pg_user_mapping is the superuser's to read; the view shows every mapping without its options.
    sql: () =>
      `SELECT NULL::text AS schema, 'for ' || x.usename || ' on server ' || x.srvname AS name, pg_catalog.pg_get_userbyid(s.srvowner) AS owner FROM pg_catalog.pg_user_mappings x
       JOIN pg_catalog.pg_foreign_server s ON s.oid = x.srvid
       WHERE ${notExtensionOwned("pg_foreign_server", "s.oid")}`,
  },
  "foreign table": inSchema("pg_class", "relnamespace", "x.relname", "x.relkind = 'f'"),
  "procedural language": databaseWide("pg_language", "x.lanname", "lanowner"),
  operator: inSchema("pg_operator", "oprnamespace", "x.oprname || '(' || pg_catalog.format_type(x.oprleft, NULL) || ',' || pg_catalog.format_type(x.oprright, NULL) || ')'"),
  "operator class": inSchema("pg_opclass", "opcnamespace", "x.opcname || ' USING ' || (SELECT a.amname FROM pg_catalog.pg_am a WHERE a.oid = x.opcmethod)"),
  // A family CREATE OPERATOR CLASS made for itself, named as its class, is the class's.
  "operator family": inSchema(
    "pg_opfamily",
    "opfnamespace",
    "x.opfname || ' USING ' || (SELECT a.amname FROM pg_catalog.pg_am a WHERE a.oid = x.opfmethod)",
    "NOT EXISTS (SELECT 1 FROM pg_catalog.pg_opclass c WHERE c.opcfamily = x.oid AND c.opcname = x.opfname AND c.opcnamespace = x.opfnamespace)",
  ),
  publication: databaseWide("pg_publication", "x.pubname", "pubowner"),
  subscription: {
    sql: () =>
      `SELECT NULL::text AS schema, x.subname AS name, pg_catalog.pg_get_userbyid(x.subowner) AS owner FROM pg_catalog.pg_subscription x
       WHERE x.subdbid = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())`,
  },
  rule: {
    sql: (scope) =>
      `SELECT n.nspname AS schema, r.rulename || ' ON ' || c.relname AS name, NULL::text AS owner
       FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class ${ns("n", "c.relnamespace")}
       WHERE r.rulename <> '_RETURN' AND ${scope} AND ${notExtensionOwned("pg_class", "c.oid")}`,
  },
  "extended statistics": inSchema("pg_statistic_ext", "stxnamespace", "x.stxname"),
  "text search configuration": inSchema("pg_ts_config", "cfgnamespace", "x.cfgname"),
  "text search dictionary": inSchema("pg_ts_dict", "dictnamespace", "x.dictname"),
  "text search parser": inSchema("pg_ts_parser", "prsnamespace", "x.prsname"),
  "text search template": inSchema("pg_ts_template", "tmplnamespace", "x.tmplname"),
  transform: databaseWide(
    "pg_transform",
    "'FOR ' || pg_catalog.format_type(x.trftype, NULL) || ' LANGUAGE ' || (SELECT l.lanname FROM pg_catalog.pg_language l WHERE l.oid = x.trflang)",
  ),
  "composite type": type("x.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = x.typrelid AND c.relkind = 'c')"),
  "range type": type("x.typtype = 'r'"),
  // A base type, or a shell; not the array type the server makes beside every type.
  "base type": type("x.typtype IN ('b', 'p') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type e WHERE e.typarray = x.oid)"),
};

/**
 * Every object in scope of a kind the coverage table refuses, kind by kind
 * in the table's order, each by schema then name. A kind the session may not
 * read (a role without the privilege) is a problem in `unread`, not a pass.
 */
export async function readUndeclarable(client: PostgresClient, scope: SchemaScope = {}): Promise<{ objects: UndeclarableObject[]; unread: string[] }> {
  const s = scopeSql("n.nspname", scope);
  const objects: UndeclarableObject[] = [];
  const unread: string[] = [];
  for (const row of KIND_COVERAGE.postgres) {
    if (row.status !== "refused") continue;
    const probe = POSTGRES_PROBES[row.kind];
    if (!probe) throw new Error(`no catalog query finds a Postgres ${row.kind} (src/postgres/live/undeclarable.ts)`);
    // The comment names the kind, in the server's log and to a test's fake client.
    const sql = `/* chant undeclarable: ${row.kind} */ SELECT q.schema, q.name, q.owner FROM (${probe.sql(s.sql)}) q ORDER BY q.schema ${C} NULLS FIRST, q.name ${C}`;
    try {
      const rows = await client.query<{ schema: string | null; name: string; owner: string | null }>(sql, sql.includes("$1") ? s.params : []);
      for (const r of rows) objects.push({ kind: row.kind, ...(r.schema ? { schema: r.schema } : {}), name: r.name, ...(r.owner ? { owner: r.owner } : {}) });
    } catch (err) {
      unread.push(`${row.kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { objects, unread };
}
