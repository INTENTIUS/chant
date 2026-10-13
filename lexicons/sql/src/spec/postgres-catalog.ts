/**
 * The Postgres catalog: what generation reads from one pinned server's
 * catalog, in the shape the committed snapshot stores (one snapshot per major).
 *
 * Every section is sorted with an explicit `COLLATE "C"`, and the snapshot is
 * written one entry per line, so a pin move is a line diff a reviewer can
 * read. Nothing here depends on the host: `pg_settings.setting` and
 * `reset_val` reflect the scratch server's configuration and are never read
 * (`boot_val` is the compiled default), the Debian build suffix is stripped
 * from `server_version`, and nothing is timestamped.
 */

import { STORAGE_PARAMETER_SEED } from "../postgres/overlays/storage";

/** Runs a SQL script whose last statement returns one JSON value. A server, or a stub in a test. */
export interface PostgresReader {
  query(sql: string): Promise<unknown>;
}

export interface TypeRow {
  /** `pg_type.typname`: `int4`. */
  name: string;
  /** `format_type()`: `integer`. */
  sqlName: string;
  /** `typtype`: base `b`, domain `d`, enum `e`, multirange `m`, pseudo `p`, range `r`. */
  kind: string;
  category: string;
  len: number;
  byval: boolean;
}

export interface AccessMethodRow {
  name: string;
  /** `i` for an index access method, `t` for a table access method. */
  type: string;
  /** What `pg_indexam_has_property` reports for the method (`can_unique`, `can_include`...); index methods only. */
  properties: string[] | null;
}

export interface OpClassRow {
  am: string;
  name: string;
  inputType: string;
  default: boolean;
  family: string;
}

export interface FunctionRow {
  name: string;
  /** `prokind`s over the overloads, sorted: `f` function, `a` aggregate, `p` procedure, `w` window. */
  kinds: string;
  overloads: number;
  /** `pg_*`, `binary_upgrade*`, `*support`, or only ever an aggregate's support function: not for a user to call. */
  internal: boolean;
}

export interface OperatorRow {
  name: string;
  kinds: string;
  overloads: number;
}

export interface SettingRow {
  name: string;
  /** `bool`, `integer`, `real`, `string` or `enum`. */
  type: string;
  context: string;
  category: string;
  unit: string | null;
  /** The compiled default (`boot_val`). */
  default: string | null;
  min: string | null;
  max: string | null;
  enumvals: string[] | null;
}

export interface KeywordRow {
  word: string;
  /** `U` unreserved, `C` column name, `T` reserved as function or type name, `R` reserved. */
  code: string;
  description: string;
}

export interface ExtensionRow {
  name: string;
  defaultVersion: string;
  description: string | null;
}

/** Storage parameter names the server accepts, by relation kind: `table`, `toast`, `view`, `materialized view`, `index:<method>`. */
export type StorageParameters = Record<string, string[]>;

export interface PostgresCatalog {
  dialect: "postgres";
  /** `server_version` without the build suffix: `18.6`. */
  version: string;
  /** `server_version_num`: `180006`. */
  versionNum: number;
  /** The image reference that server ran. */
  image: string;
  types: TypeRow[];
  accessMethods: AccessMethodRow[];
  opclasses: OpClassRow[];
  functions: FunctionRow[];
  operators: OperatorRow[];
  settings: SettingRow[];
  keywords: KeywordRow[];
  extensions: ExtensionRow[];
  storageParameters: StorageParameters;
}

/** The list sections, in the order the snapshot writes them; `storageParameters` follows. */
export const CATALOG_SECTIONS = [
  "types",
  "accessMethods",
  "opclasses",
  "functions",
  "operators",
  "settings",
  "keywords",
  "extensions",
] as const satisfies readonly (keyof PostgresCatalog)[];

/** The major of a version string: `18.6` is 18. */
export function majorOf(version: string): number {
  return Number.parseInt(version, 10);
}

// ── Reading a server ─────────────────────────────────────────────────

const C = `collate "C"`;
const agg = (select: string, order: string) =>
  `select coalesce(json_agg(t order by ${order}), '[]'::json) from (${select}) t;`;

const AGG_SUPPORT_OIDS = `select unnest(array[aggtransfn::oid, aggfinalfn::oid, aggcombinefn::oid, aggserialfn::oid, aggdeserialfn::oid, aggmtransfn::oid, aggminvtransfn::oid, aggmfinalfn::oid]) as oid from pg_aggregate`;

const QUERIES = {
  version: `select to_json(split_part(current_setting('server_version'), ' ', 1));`,
  versionNum: `select to_json(current_setting('server_version_num')::int);`,
  // Non-array, non-composite types in pg_catalog. format_type() is the SQL
  // spelling, so int4 is integer and bool is boolean.
  types: agg(
    `select t.typname::text as name, format_type(t.oid, null) as "sqlName", t.typtype::text as kind,
            t.typcategory::text as category, t.typlen::int as len, t.typbyval as byval
       from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'pg_catalog' and t.typtype in ('b','d','e','m','p','r')
        and not (t.typcategory = 'A' and t.typname like '\\_%')`,
    `t.name ${C}`,
  ),
  accessMethods: agg(
    `select a.amname::text as name, a.amtype::text as type,
       case when a.amtype = 'i' then (select json_agg(p order by p ${C}) from unnest(array['asc','desc','nulls_first','nulls_last','orderable','distance_orderable','returnable','search_array','search_nulls','clusterable','index_scan','bitmap_scan','backward_scan','can_order','can_unique','can_multi_col','can_exclude','can_include']) p where pg_indexam_has_property(a.oid, p)) end as properties
       from pg_am a`,
    `t.name ${C}`,
  ),
  opclasses: agg(
    `select am.amname::text as am, c.opcname::text as name, format_type(c.opcintype, null) as "inputType",
            c.opcdefault as "default", f.opfname::text as family
       from pg_opclass c join pg_am am on am.oid = c.opcmethod join pg_opfamily f on f.oid = c.opcfamily
       join pg_namespace n on n.oid = c.opcnamespace where n.nspname = 'pg_catalog'`,
    `t.am ${C}, t.name ${C}, t."inputType" ${C}`,
  ),
  // One row per name in pg_catalog. Type I/O functions are not callable in any useful way.
  functions: agg(
    `select p.proname::text as name, string_agg(distinct p.prokind::text, '' order by p.prokind::text) as kinds, count(*)::int as overloads,
            (p.proname like 'pg\\_%' or p.proname like 'binary\\_upgrade%' or p.proname like '%support'
             or coalesce(bool_and(p.oid in (${AGG_SUPPORT_OIDS})), false)) as internal
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'pg_catalog'
        and p.oid not in (select unnest(array[typinput::oid, typoutput::oid, typreceive::oid, typsend::oid, typmodin::oid, typmodout::oid, typanalyze::oid, typsubscript::oid]) from pg_type)
      group by p.proname`,
    `t.name ${C}`,
  ),
  operators: agg(
    `select o.oprname::text as name, string_agg(distinct o.oprkind::text, '' order by o.oprkind::text) as kinds, count(*)::int as overloads
       from pg_operator o join pg_namespace n on n.oid = o.oprnamespace where n.nspname = 'pg_catalog' group by o.oprname`,
    `t.name ${C}`,
  ),
  settings: agg(
    `select name::text, vartype::text as type, context::text, category::text, unit::text, boot_val as "default", min_val as min, max_val as max, enumvals::text[] as enumvals
       from pg_settings where name not like 'server\\_version%'`,
    `t.name ${C}`,
  ),
  keywords: agg(`select word::text, catcode::text as code, catdesc::text as description from pg_get_keywords()`, `t.word ${C}, t.code ${C}`),
  extensions: agg(
    `select name::text, default_version::text as "defaultVersion", comment::text as description from pg_available_extensions`,
    `t.name ${C}`,
  ),
};

/**
 * Storage parameters (reloptions) are compiled into `reloptions.c`; no catalog
 * lists them. Try every candidate on every relation kind and keep the names
 * the server does not reject as unrecognized. Candidates are every
 * `pg_settings` name plus the overlay's seed. An out-of-range value error
 * counts as accepted.
 */
function storageProbe(): string {
  const index = { btree: "a", hash: "a", brin: "a", gin: "arr", gist: "r", spgist: "r" } as const;
  const targets: Array<[string, string]> = [
    ["table", "create table probe.x (a int) with (%C=1)"],
    ["toast", "create table probe.x (a text) with (toast.%C=1)"],
    ["view", "create view probe.x with (%C=1) as select 1 as a"],
    ["materialized view", "create materialized view probe.x with (%C=1) as select 1 as a"],
    ...(Object.entries(index) as Array<[string, string]>).map(
      ([am, col]): [string, string] => [`index:${am}`, `create index x on probe.base using ${am} (${col}) with (%C=1)`],
    ),
  ];
  const cases = targets.map(([t, s]) => `('${t}', $q$${s}$q$)`).join(",\n");
  return `
drop schema if exists probe cascade; create schema probe;
create table probe.base (a int, arr int[], r int4range);
create temp table res (target text, cand text);
do $do$
declare t record; c record; msg text;
begin
  for t in select * from (values ${cases}) v(target, stmt) loop
    for c in select distinct n as cand from (select name::text as n from pg_settings union select unnest(string_to_array($seed$${STORAGE_PARAMETER_SEED.join(",")}$seed$, ','))) s(n) loop
      begin
        execute replace(t.stmt, '%C', quote_ident(c.cand));
        insert into res values (t.target, c.cand);
        execute case when t.target like 'index%' then 'drop index probe.x'
                     when t.target like 'mat%' then 'drop materialized view probe.x'
                     when t.target = 'view' then 'drop view probe.x' else 'drop table probe.x' end;
      exception when others then
        get stacked diagnostics msg = message_text;
        if msg not like 'unrecognized parameter%' and msg not like 'syntax error%' then
          insert into res values (t.target, c.cand);
        end if;
      end;
    end loop;
  end loop;
end $do$;
drop schema probe cascade;
${agg(`select target, cand as name from res`, `t.target ${C}, t.name ${C}`)}`;
}

/** Read the catalog from a server. The caller checks that its version is the pin. */
export async function readCatalog(reader: PostgresReader, image: string): Promise<PostgresCatalog> {
  const q = async <T>(key: keyof typeof QUERIES): Promise<T> => (await reader.query(QUERIES[key])) as T;
  const catalog: PostgresCatalog = {
    dialect: "postgres",
    version: await q<string>("version"),
    versionNum: await q<number>("versionNum"),
    image,
    types: await q<TypeRow[]>("types"),
    accessMethods: await q<AccessMethodRow[]>("accessMethods"),
    opclasses: await q<OpClassRow[]>("opclasses"),
    functions: await q<FunctionRow[]>("functions"),
    operators: await q<OperatorRow[]>("operators"),
    settings: await q<SettingRow[]>("settings"),
    keywords: await q<KeywordRow[]>("keywords"),
    extensions: await q<ExtensionRow[]>("extensions"),
    storageParameters: {},
  };
  const probed = (await reader.query(storageProbe())) as Array<{ target: string; name: string }>;
  for (const r of probed) (catalog.storageParameters[r.target] ??= []).push(r.name);
  return catalog;
}

// ── The snapshot's text form ─────────────────────────────────────────

/** Write the catalog with one array entry per line, so a pin move is one changed line per changed entry. */
export function stringifyCatalog(catalog: PostgresCatalog): string {
  const lines: string[] = ["{"];
  lines.push(`  "dialect": ${JSON.stringify(catalog.dialect)},`);
  lines.push(`  "version": ${JSON.stringify(catalog.version)},`);
  lines.push(`  "versionNum": ${catalog.versionNum},`);
  lines.push(`  "image": ${JSON.stringify(catalog.image)},`);
  for (const section of CATALOG_SECTIONS) {
    const rows = catalog[section] as unknown[];
    if (rows.length === 0) {
      lines.push(`  ${JSON.stringify(section)}: [],`);
      continue;
    }
    lines.push(`  ${JSON.stringify(section)}: [`);
    rows.forEach((row, j) => lines.push(`    ${JSON.stringify(row)}${j === rows.length - 1 ? "" : ","}`));
    lines.push("  ],");
  }
  const targets = Object.keys(catalog.storageParameters);
  lines.push(`  "storageParameters": {`);
  targets.forEach((t, j) =>
    lines.push(`    ${JSON.stringify(t)}: ${JSON.stringify(catalog.storageParameters[t])}${j === targets.length - 1 ? "" : ","}`),
  );
  lines.push("  }", "}");
  return `${lines.join("\n")}\n`;
}

/** Parse and shape-check a snapshot. Throws naming the first section that is missing or not a list. */
export function parseCatalog(text: string): PostgresCatalog {
  const value = JSON.parse(text) as Partial<PostgresCatalog>;
  if (value.dialect !== "postgres") throw new Error(`not a Postgres catalog (dialect ${String(value.dialect)})`);
  if (typeof value.version !== "string") throw new Error("catalog has no version");
  for (const section of CATALOG_SECTIONS) {
    if (!Array.isArray(value[section])) throw new Error(`catalog section ${section} is missing or not a list`);
  }
  if (typeof value.storageParameters !== "object" || value.storageParameters === null) {
    throw new Error("catalog section storageParameters is missing");
  }
  return value as PostgresCatalog;
}
