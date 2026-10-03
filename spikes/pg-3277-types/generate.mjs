// Throwaway spike for chant #3277: generate Postgres dialect types from a pinned
// `postgres` container's catalog. No dependencies; talks to the server with
// `docker exec <c> psql -At`.
//
//   node generate.mjs <tag> <digest> <outdir> [--cpus=N]
//
// Writes <outdir>/postgres-catalog.json (one entry per line, sorted) and
// <outdir>/postgres-types.ts. The container is always removed.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const [tag, digest, outdir, ...flags] = process.argv.slice(2);
if (!tag || !digest || !outdir) throw new Error("usage: generate.mjs <tag> <digest> <outdir> [--cpus=N]");
const image = `postgres:${tag}@${digest}`;
const name = `pg3277-${randomBytes(4).toString("hex")}`;
const cpus = flags.find((f) => f.startsWith("--cpus="));

function docker(args, input) {
  const r = spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
/** Run a SQL script whose last statement returns one JSON value. */
function q(sql) {
  const out = docker(["exec", "-i", name, "psql", "-U", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"], sql);
  return JSON.parse(out.trim());
}
const agg = (select, order) => `select coalesce(json_agg(t order by ${order}), '[]'::json) from (${select}) t;`;

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    const text = (logs.stdout ?? "") + (logs.stderr ?? "");
    const ready = (text.match(/database system is ready to accept connections/g) ?? []).length;
    if (ready >= 2) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("server never became ready");
}

const C = `collate "C"`;

const QUERIES = {
  version: () => q(`select to_json(split_part(current_setting('server_version'), ' ', 1));`),
  versionNum: () => q(`select to_json(current_setting('server_version_num')::int);`),
  // Non-array, non-composite types in pg_catalog. format_type() is the SQL
  // spelling, so int4 -> integer and bool -> boolean fall out of the catalog.
  types: () => q(agg(`
    select t.typname::text as name, format_type(t.oid, null) as "sqlName", t.typtype::text as kind,
           t.typcategory::text as category, t.typlen as len, t.typbyval as byval
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'pg_catalog' and t.typtype in ('b','d','e','m','p','r')
       and not (t.typcategory = 'A' and t.typname like '\\_%')`, `t.name ${C}`)),
  arrayTypeCount: () => q(`select to_json(count(*)) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='pg_catalog' and t.typcategory='A' and t.typname like '\\_%';`),
  compositeTypeCount: () => q(`select to_json(count(*)) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='pg_catalog' and t.typtype='c';`),
  accessMethods: () => q(agg(`
    select a.amname::text as name, a.amtype::text as type,
      case when a.amtype = 'i' then (select json_agg(p order by p) from unnest(array['asc','desc','nulls_first','nulls_last','orderable','distance_orderable','returnable','search_array','search_nulls','clusterable','index_scan','bitmap_scan','backward_scan','can_order','can_unique','can_multi_col','can_exclude','can_include']) p where pg_indexam_has_property(a.oid, p)) end as properties
      from pg_am a`, `t.name ${C}`)),
  opclasses: () => q(agg(`
    select am.amname::text as am, c.opcname::text as name, format_type(c.opcintype, null) as "inputType",
           c.opcdefault as "default", f.opfname::text as family
      from pg_opclass c join pg_am am on am.oid = c.opcmethod join pg_opfamily f on f.oid = c.opcfamily
      join pg_namespace n on n.oid = c.opcnamespace where n.nspname = 'pg_catalog'`, `t.am ${C}, t.name ${C}, t."inputType" ${C}`)),
  // Callable functions in pg_catalog, one row per name. Type I/O functions
  // (typinput, typoutput, ...) are not callable by users in any useful way.
  functions: () => q(agg(`
    select p.proname::text as name, string_agg(distinct p.prokind::text, '' order by p.prokind::text) as kinds, count(*)::int as overloads
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'pg_catalog'
       and p.oid not in (select unnest(array[typinput::oid, typoutput::oid, typreceive::oid, typsend::oid, typmodin::oid, typmodout::oid, typanalyze::oid, typsubscript::oid]) from pg_type)
     group by p.proname`, `t.name ${C}`)),
  functionRowCount: () => q(`select to_json(count(*)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pg_catalog';`),
  operators: () => q(agg(`
    select o.oprname::text as name, string_agg(distinct o.oprkind::text, '' order by o.oprkind::text) as kinds, count(*)::int as overloads
      from pg_operator o join pg_namespace n on n.oid = o.oprnamespace where n.nspname = 'pg_catalog' group by o.oprname`, `t.name ${C}`)),
  // boot_val is the compiled default; setting/reset_val reflect this server's config.
  settings: () => q(agg(`
    select name::text, vartype::text as type, context::text, category::text, unit::text, boot_val as "default", min_val as min, max_val as max, enumvals::text[] as enumvals
      from pg_settings`, `t.name ${C}`)),
  keywords: () => q(agg(`select word::text, catcode::text as code, catdesc::text as description from pg_get_keywords()`, `t.word ${C}`)),
  extensions: () => q(agg(`select name::text, default_version::text as "defaultVersion", comment::text as description from pg_available_extensions`, `t.name ${C}`)),
  collationProviders: () => q(`select coalesce(json_agg(distinct collprovider::text order by collprovider::text), '[]'::json) from pg_collation;`),
  encodings: () => q(`select to_json(count(distinct conforencoding)) from pg_conversion;`),
};

// Storage parameters (reloptions) are compiled into reloptions.c; no catalog
// lists them. Probe the server: try every candidate on every relation kind and
// keep the ones the server does not reject as "unrecognized parameter".
// Candidates = every pg_settings name plus SEED (reloptions that are not GUCs).
const SEED = [
  "fillfactor", "toast_tuple_target", "parallel_workers", "user_catalog_table", "autovacuum_enabled",
  "vacuum_index_cleanup", "vacuum_truncate", "autovacuum_vacuum_threshold", "autovacuum_vacuum_scale_factor",
  "autovacuum_vacuum_max_threshold", "autovacuum_vacuum_insert_threshold", "autovacuum_vacuum_insert_scale_factor",
  "autovacuum_analyze_threshold", "autovacuum_analyze_scale_factor", "autovacuum_vacuum_cost_delay",
  "autovacuum_vacuum_cost_limit", "autovacuum_freeze_min_age", "autovacuum_freeze_max_age",
  "autovacuum_freeze_table_age", "autovacuum_multixact_freeze_min_age", "autovacuum_multixact_freeze_max_age",
  "autovacuum_multixact_freeze_table_age", "log_autovacuum_min_duration", "deduplicate_items", "buffering",
  "fastupdate", "gin_pending_list_limit", "pages_per_range", "autosummarize", "security_barrier",
  "security_invoker", "check_option", "vacuum_cleanup_index_scale_factor",
];
function probeStorage() {
  const targets = [
    ["table", "create table probe.x (a int) with (%C=1)"],
    ["toast", "create table probe.x (a text) with (toast.%C=1)"],
    ["view", "create view probe.x with (%C=1) as select 1 as a"],
    ["materialized view", "create materialized view probe.x with (%C=1) as select 1 as a"],
    ...["btree", "hash", "gin", "gist", "spgist", "brin"].map((am) => [
      `index:${am}`,
      `create index x on probe.base using ${am} (${{ btree: "a", hash: "a", brin: "a", gin: "arr", gist: "r", spgist: "r" }[am]}) with (%C=1)`,
    ]),
  ];
  const cases = targets.map(([t, s]) => `('${t}', $q$${s}$q$)`).join(",\n");
  const sql = `
drop schema if exists probe cascade; create schema probe;
create table probe.base (a int, arr int[], r int4range);
create temp table res (target text, cand text);
do $do$
declare t record; c record; msg text;
begin
  for t in select * from (values ${cases}) v(target, stmt) loop
    for c in select distinct n as cand from (select name::text as n from pg_settings union select unnest(string_to_array($seed$${SEED.join(",")}$seed$, ','))) s(n) loop
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
          raise notice '% % -> %', t.target, c.cand, msg;
        end if;
      end;
    end loop;
  end loop;
end $do$;
drop schema probe cascade;
${agg(`select target, cand as name from res`, `t.target ${C}, t.name ${C}`)}`;
  return q(sql);
}

const started = Date.now();
try {
  docker(["run", "-d", "--name", name, ...(cpus ? [cpus] : []), "-e", "POSTGRES_PASSWORD=spike", image]);
  await waitReady();
  const out = {};
  for (const [k, fn] of Object.entries(QUERIES)) out[k] = fn();
  // Index-only probe candidates that are accepted by the server.
  const storage = probeStorage();
  const by = {};
  for (const r of storage) (by[r.target] ??= []).push(r.name);
  out.storageParameters = by;

  mkdirSync(outdir, { recursive: true });
  // One entry per line so a pin move is a line diff.
  const lines = ['{'];
  const keys = Object.keys(out);
  keys.forEach((k, i) => {
    const v = out[k];
    const tail = i === keys.length - 1 ? "" : ",";
    if (Array.isArray(v)) {
      lines.push(`  ${JSON.stringify(k)}: [`);
      v.forEach((e, j) => lines.push(`    ${JSON.stringify(e)}${j === v.length - 1 ? "" : ","}`));
      lines.push(`  ]${tail}`);
    } else if (v && typeof v === "object") {
      lines.push(`  ${JSON.stringify(k)}: {`);
      const ks = Object.keys(v);
      ks.forEach((kk, j) => lines.push(`    ${JSON.stringify(kk)}: ${JSON.stringify(v[kk])}${j === ks.length - 1 ? "" : ","}`));
      lines.push(`  }${tail}`);
    } else lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}${tail}`);
  });
  lines.push("}");
  writeFileSync(`${outdir}/postgres-catalog.json`, lines.join("\n") + "\n");
  writeFileSync(`${outdir}/postgres-types.ts`, renderTypes(out, tag));
  console.error(`${tag}: ${((Date.now() - started) / 1000).toFixed(0)}s`);
} finally {
  spawnSync("docker", ["rm", "-f", "-v", name]);
}

function union(names) {
  return names.length ? names.map((n) => JSON.stringify(n)).join(" | ") : "never";
}
function renderTypes(c, tag) {
  const L = [];
  L.push(`// Generated by spikes/pg-3277-types/generate.mjs from postgres:${tag}. Do not edit.`);
  L.push(`export const POSTGRES_VERSION = ${JSON.stringify(c.version)};`, "");
  const baseTypes = c.types.filter((t) => t.kind !== "p");
  L.push(`export type TypeName = ${union(baseTypes.map((t) => t.name))};`);
  L.push(`export type TypeSqlName = ${union([...new Set(baseTypes.map((t) => t.sqlName))].sort())};`);
  const aliases = baseTypes.filter((t) => t.sqlName !== t.name).map((t) => [t.name, t.sqlName]);
  L.push(`export const TYPE_ALIASES = ${JSON.stringify(Object.fromEntries(aliases))} as const;`, "");
  L.push(`export type IndexAccessMethod = ${union(c.accessMethods.filter((a) => a.type === "i").map((a) => a.name))};`);
  L.push(`export type TableAccessMethod = ${union(c.accessMethods.filter((a) => a.type === "t").map((a) => a.name))};`);
  L.push(`export const INDEX_METHOD_PROPERTIES = ${JSON.stringify(Object.fromEntries(c.accessMethods.filter((a) => a.type === "i").map((a) => [a.name, a.properties])))} as const;`);
  const byAm = {};
  for (const o of c.opclasses) (byAm[o.am] ??= []).push(o.name);
  for (const [am, names] of Object.entries(byAm)) L.push(`export type OpClass_${am} = ${union(names)};`);
  L.push("");
  const reserved = (code) => c.keywords.filter((k) => k.code === code).map((k) => k.word);
  L.push(`export type ReservedKeyword = ${union(reserved("R"))};`);
  L.push(`export type ReservedAsFunctionKeyword = ${union(reserved("T"))};`);
  L.push(`export type ColumnNameKeyword = ${union(reserved("C"))};`);
  L.push(`export type UnreservedKeyword = ${union(reserved("U"))};`, "");
  L.push(`export type AggregateFunctionName = ${union(c.functions.filter((f) => f.kinds.includes("a")).map((f) => f.name))};`);
  L.push(`export type ScalarFunctionName = ${union(c.functions.filter((f) => f.kinds.includes("f")).map((f) => f.name))};`);
  L.push(`export type ExtensionName = ${union(c.extensions.map((e) => e.name))};`, "");
  const tsType = (s) => {
    if (s.enumvals) return s.enumvals.map((v) => JSON.stringify(v)).join(" | ");
    return { bool: "boolean", integer: "number", real: "number", string: "string" }[s.type] ?? "string";
  };
  L.push("export interface Settings {");
  for (const s of c.settings) {
    L.push(`  /** ${s.category} | @context ${s.context}${s.unit ? ` | @unit ${s.unit}` : ""}${s.default != null ? ` | @default ${JSON.stringify(s.default)}` : ""} */`);
    L.push(`  ${JSON.stringify(s.name)}?: ${tsType(s)};`);
  }
  L.push("}", "");
  const tsOpt = (n) => `  ${JSON.stringify(n)}?: string | number | boolean;`;
  for (const [target, names] of Object.entries(c.storageParameters)) {
    const iface = "StorageParams_" + target.replace(/[^a-z]+/gi, "_");
    L.push(`export interface ${iface} {`, ...names.map(tsOpt), "}", "");
  }
  return L.join("\n");
}
