/**
 * The Drizzle schema module `chant sql drizzle` writes (#4401): a Postgres
 * build's tables, enums, sequences and views as `drizzle-orm/pg-core`
 * declarations, so an application queries with Drizzle's row types while
 * chant owns the schema, the plan and the apply.
 *
 * {@link renderDrizzle} is pure: the entities of a build in, the module's
 * text and a list of what it left out. It reads the objects as the
 * serializer writes them, as `sql-types.ts` does, so a `.sql` file's objects
 * and a composite's members are covered as the build covers them.
 *
 * The API it writes is drizzle-orm {@link DRIZZLE_ORM_CHECKED}'s `pg-core`
 * (type definitions read from the published package):
 *
 * - `pgTable(name, columns, (t) => [...])`, or `pgSchema(name).table(...)`
 *   for a schema other than `public` (`pgSchema("public")` throws);
 * - column builders, `.notNull()`, `.default()`, `.primaryKey()`,
 *   `.generatedAlwaysAsIdentity()`, `.generatedAlwaysAs()`, `.array()`;
 * - `foreignKey({ name, columns, foreignColumns })` with `.onDelete()` and
 *   `.onUpdate()`, `unique(name).on()`, `check(name, sql)`,
 *   `index(name).on()`, `uniqueIndex(name).on()`;
 * - `pgEnum`, `pgSequence`, and `pgView(name, columns).existing()`;
 * - `customType` for a column type Drizzle has no builder for.
 *
 * Each column key is the column's name in the database, so a row has the
 * keys `RowOf` has. Every constraint and index carries the name Postgres
 * would give it (`./postgres/constraint-names.ts`) when the DDL names none,
 * so `drizzle-kit` compares equal names.
 *
 * Foreign keys use `foreignKey()` and not a column's `.references()`: the
 * latter takes no name, and Drizzle derives `orders_user_id_users_id_fk`
 * where Postgres says `orders_user_id_fkey`.
 *
 * Views are `.existing()`: chant creates them, and `drizzle-kit` must not.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { GENERATED_MARKER } from "@intentius/chant/discovery/files";
import { PINNED_MAJOR } from "./lint/post-synth/postgres-helpers";
import { parseType, projectFromObjects, resolveType, type ParsedType, type PgProject } from "./lint/post-synth/postgres-names";
import type { OutputObject } from "./lint/post-synth/sql-helpers";
import { checkName, chooseName, columnsAddition } from "./postgres/constraint-names";
import { dialectOf, passthrough, pgType, runtimeColumns, serializedObjects } from "./sql-types";
import { quoteIdent } from "./postgres/keywords";
import { isPostgresObject } from "./postgres/entities";

/** The drizzle-orm version whose type definitions the output was written against. */
export const DRIZZLE_ORM_CHECKED = "0.45.4";

export interface RenderDrizzleOptions {
  /** The project's config: `sql.postgresMajor` for the catalog, `sql.dialect` when nothing is declared. */
  config?: Record<string, unknown>;
  /** How a `bigint` column reads: Drizzle's `number` (the default, as `drizzle-kit pull` writes it) or `bigint`. */
  bigintMode?: "number" | "bigint";
}

export interface DrizzleRender {
  text: string;
  /** Objects with no Drizzle declaration, by kind. */
  skipped: Array<{ kind: string; names: string[]; reason: string }>;
  /** Parts of a mapped object that Drizzle cannot say: `app.orders: ...`. */
  approximated: string[];
  counts: { tables: number; views: number; enums: number; sequences: number };
}

/** Thrown for a build that is not Postgres. */
export class DrizzleDialectError extends Error {}

const SKIP_REASONS: Record<string, string> = {
  "Postgres::Index": "an index on something that is not a table in the file",
  "Postgres::CompositeType": "Drizzle has no composite type; a column of one is a customType",
  "Postgres::RangeType": "Drizzle has no range type; a column of one is a customType",
  "Postgres::Domain": "Drizzle has no domain; a column of one is a customType named by the domain",
  "Postgres::Function": "Drizzle has no routines",
  "Postgres::Procedure": "Drizzle has no routines",
  "Postgres::Aggregate": "Drizzle has no routines",
  "Postgres::Trigger": "Drizzle has no triggers",
  "Postgres::EventTrigger": "Drizzle has no triggers",
  "Postgres::Extension": "Drizzle has no extension declaration",
  "Postgres::Collation": "Drizzle has no collation",
  "Postgres::Cast": "Drizzle has no cast",
  "Postgres::Operator": "Drizzle has no operator",
  "Postgres::OperatorClass": "Drizzle has no operator class",
  "Postgres::OperatorFamily": "Drizzle has no operator family",
  "Postgres::ForeignTable": "Drizzle has no foreign table",
  "Postgres::TextSearchConfiguration": "Drizzle has no text search configuration",
  "Postgres::TextSearchDictionary": "Drizzle has no text search dictionary",
  "Postgres::Statistics": "Drizzle has no extended statistics",
  "Postgres::ForeignDataWrapper": "Drizzle has no foreign data wrapper",
  "Postgres::ForeignServer": "Drizzle has no foreign server",
  "Postgres::Publication": "Drizzle has no publication",
  "Postgres::Policy": "Drizzle has pgPolicy, which is left out: chant owns access, and queries do not read policies",
  "Postgres::Role": "Drizzle has pgRole, which is left out: chant owns access, and queries do not read roles",
  "Postgres::Grant": "Drizzle has no grant",
  "Postgres::DefaultPrivileges": "Drizzle has no default privileges",
};

// ── Names ───────────────────────────────────────────────────────────────

const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while",
  "with", "yield", "let", "static", "implements", "interface", "package", "private", "protected", "public", "await", "async", "of", "type", "undefined", "NaN",
  "Infinity", "arguments", "eval",
]);

/** The names the module imports, which no declaration may take. */
const IMPORTABLE = [
  "sql", "bigint", "bigserial", "boolean", "char", "check", "cidr", "customType", "date", "doublePrecision", "foreignKey", "index", "inet", "integer", "interval",
  "json", "jsonb", "line", "macaddr", "macaddr8", "numeric", "pgEnum", "pgSchema", "pgSequence", "pgTable", "pgView", "pgMaterializedView", "point", "primaryKey",
  "real", "serial", "smallint", "smallserial", "text", "time", "timestamp", "unique", "uniqueIndex", "uuid", "varchar", "unknownColumn",
];

const propertyName = (name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
const member = (obj: string, name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? `${obj}.${name}` : `${obj}[${JSON.stringify(name)}]`);
const str = (s: string): string => JSON.stringify(s);

/** A template literal's body for `text`. */
const template = (text: string): string => text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
const sqlText = (c: Context, text: string): string => {
  c.used.add("sql");
  return `sql\`${template(text.trim())}\``;
};
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── Column types ────────────────────────────────────────────────────────

type Data = "number" | "bigint" | "boolean" | "string" | "other";

interface Built {
  /** The builder call, with no modifiers. */
  expr: string;
  data: Data;
  /** `serial`, `bigserial`, `smallserial`: the type itself carries NOT NULL and a default. */
  serial: boolean;
  /** An integer builder, which takes `.generatedAlwaysAsIdentity()`. */
  integer: boolean;
}

interface Context {
  p: PgProject;
  bigintMode: "number" | "bigint";
  /** The enum objects the file declares, by sql name, and the identifier each is bound to. */
  enums: Map<string, string>;
  /** `customType` declarations the file needs, by identifier. */
  customs: Map<string, { dbType: string; ts: string }>;
  /** Every `drizzle-orm/pg-core` name used. */
  used: Set<string>;
  note: (text: string) => void;
}

const use = (c: Context, name: string): string => {
  c.used.add(name);
  return name;
};

const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "type";

function custom(c: Context, dbType: string, ts: string): Built {
  if (/^[^"]+\.[^"]+$/.test(dbType)) c.note(`a column of type ${dbType} is a customType, and drizzle-kit quotes a qualified type name as one identifier`);
  const base = `${slug(dbType)}Type`;
  // Two spellings that slug alike get their own identifier.
  let id = base;
  for (let n = 2; c.customs.has(id) && c.customs.get(id)!.dbType !== dbType; n++) id = `${base}${n}`;
  if (!c.customs.has(id)) c.customs.set(id, { dbType, ts });
  use(c, "customType");
  return { expr: `${id}()`, data: "other", serial: false, integer: false };
}

const precisionArg = (t: ParsedType): number | undefined => {
  const m = t.modifiers?.[0];
  return m !== undefined && /^[0-6]$/.test(m) ? Number(m) : undefined;
};

function objectArg(fields: Array<[string, string | number | boolean | undefined]>): string {
  const parts = fields.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${typeof v === "string" ? str(v) : String(v)}`);
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : "";
}

/** A column's Drizzle builder, from the type as the declaration wrote it. */
function columnType(c: Context, text: string | undefined): Built {
  const t = parseType(text);
  const unknown = (): Built => {
    c.used.add("customType");
    c.used.add("unknownColumn");
    return { expr: "unknownColumn()", data: "other", serial: false, integer: false };
  };
  if (!t) return text === undefined ? unknown() : custom(c, text.trim(), "unknown");
  const r = resolveType(c.p, t, { serial: true });
  let built: Built;
  if (r.kind === "builtin") {
    const call = (fn: string, arg = "", data: Data = "other", integer = false): Built => ({ expr: `${use(c, fn)}(${arg})`, data, serial: false, integer });
    const mods = t.modifiers ?? [];
    switch (r.canonical) {
      case "smallint":
        built = r.serial ? { ...call("smallserial", "", "number"), serial: true } : call("smallint", "", "number", true);
        break;
      case "integer":
        built = r.serial ? { ...call("serial", "", "number"), serial: true } : call("integer", "", "number", true);
        break;
      case "bigint": {
        const mode = c.bigintMode;
        const b = call(r.serial ? "bigserial" : "bigint", `{ mode: ${str(mode)} }`, mode === "number" ? "number" : "bigint", true);
        built = r.serial ? { ...b, serial: true } : b;
        break;
      }
      case "real":
        built = call("real", "", "number");
        break;
      case "double precision":
        built = call("doublePrecision", "", "number");
        break;
      case "numeric": {
        const [prec, scale] = mods;
        built = call("numeric", objectArg([["precision", prec !== undefined ? Number(prec) : undefined], ["scale", scale !== undefined ? Number(scale) : undefined]]));
        break;
      }
      case "boolean":
        built = call("boolean", "", "boolean");
        break;
      case "text":
        built = call("text", "", "string");
        break;
      case "uuid":
        built = call("uuid", "", "string");
        break;
      case "character varying":
        built = call("varchar", objectArg([["length", mods[0] !== undefined ? Number(mods[0]) : undefined]]), "string");
        break;
      case "character":
        built = call("char", objectArg([["length", mods[0] !== undefined ? Number(mods[0]) : undefined]]), "string");
        break;
      case "json":
        built = call("json");
        break;
      case "jsonb":
        built = call("jsonb");
        break;
      case "date":
        built = call("date");
        break;
      case "timestamp without time zone":
      case "timestamp with time zone":
        built = call("timestamp", objectArg([["precision", precisionArg(t)], ["withTimezone", r.canonical.endsWith("with time zone") ? true : undefined]]));
        break;
      case "time without time zone":
      case "time with time zone":
        built = call("time", objectArg([["precision", precisionArg(t)], ["withTimezone", r.canonical.endsWith("with time zone") ? true : undefined]]), "string");
        break;
      case "interval":
        built = call("interval", objectArg([["fields", t.fields?.toLowerCase()], ["precision", precisionArg(t)]]), "string");
        break;
      case "inet":
      case "cidr":
      case "macaddr":
      case "macaddr8":
        built = call(r.canonical, "", "string");
        break;
      case "point":
        built = call("point", `{ mode: "xy" }`);
        break;
      case "line":
        built = call("line", `{ mode: "abc" }`);
        break;
      default: {
        // No builder in pg-core: the type, as format_type spells it, with the row type RowOf gives it.
        const ty = pgType(c.p, text);
        built = custom(c, ty.sqlType.replace(/\[\]$/, ""), ty.ts.replace(/\[\]$/, "") || "unknown");
      }
    }
  } else if (r.kind === "declared" && r.object.type === "Postgres::Enum" && c.enums.has(qualified(r.object.schema as string | undefined, r.object.name))) {
    built = { expr: `${c.enums.get(qualified(r.object.schema as string | undefined, r.object.name))}()`, data: "string", serial: false, integer: false };
  } else if (r.kind !== "declared" && c.enums.has(qualified(t.schema as string | undefined, t.name))) {
    // An enum in the public schema, which the project does not list as a schema of its own.
    built = { expr: `${c.enums.get(qualified(t.schema as string | undefined, t.name))}()`, data: "string", serial: false, integer: false };
  } else {
    const ty = pgType(c.p, text);
    built = custom(c, ty.sqlType.replace(/\[\]$/, ""), ty.ts.replace(/\[\]$/, "") || "unknown");
  }
  return t.array ? { ...built, expr: `${built.expr}.array()`, data: "other", serial: false, integer: false } : built;
}

/** The argument of `.default()` for `expr`, a literal where one fits the column's value type. */
function defaultArg(c: Context, expr: string, data: Data): string {
  const e = expr.trim();
  if (data === "boolean" && /^(true|false)$/i.test(e)) return e.toLowerCase();
  if (data === "number" && /^-?\d+$/.test(e)) return e;
  if (data === "bigint" && /^-?\d+$/.test(e)) return `${e}n`;
  const lit = /^'((?:[^']|'')*)'$/.exec(e);
  if (data === "string" && lit) return str(lit[1]!.replace(/''/g, "'"));
  return sqlText(c, e);
}

// ── Identity and sequence options ───────────────────────────────────────

const OPTION_KEYS: Record<string, string> = { increment: "increment", minvalue: "minValue", maxvalue: "maxValue", start: "startWith", cache: "cache" };

/** `START WITH 100 INCREMENT BY 5 CYCLE` as the options object; undefined when something is not understood. */
function identityOptions(text: string): string | undefined {
  const body = text.trim().replace(/^\(/, "").replace(/\)$/, "");
  const re = /\s*(?:(START)(?:\s+WITH)?|(INCREMENT)(?:\s+BY)?|(MINVALUE)|(MAXVALUE)|(CACHE)|(NO\s+CYCLE|CYCLE)|(NO\s+MINVALUE|NO\s+MAXVALUE))\s*(-?\d+)?/gy;
  const out: string[] = [];
  let at = 0;
  while (at < body.length) {
    re.lastIndex = at;
    const m = re.exec(body);
    if (!m || m.index !== at) return undefined;
    at = re.lastIndex;
    const word = m.slice(1, 8).find((x) => x !== undefined)!.toUpperCase().replace(/\s+/g, " ");
    if (word === "CYCLE") out.push("cycle: true");
    else if (word === "NO CYCLE" || word.startsWith("NO ")) continue;
    else if (m[8] === undefined) return undefined;
    else out.push(`${OPTION_KEYS[word.toLowerCase()]}: ${m[8]}`);
  }
  return out.length > 0 ? `{ ${out.join(", ")} }` : "";
}

// ── The module ──────────────────────────────────────────────────────────

interface TableJson extends OutputObject {
  columns: Array<{ name: string; type?: string; notNull?: boolean; default?: string; generated?: { kind: string; expr?: string; always: boolean; options?: string }; collate?: string }>;
  primaryKey?: { name?: string; columns: string[] };
  uniques: Array<{ name?: string; columns: string[]; nullsNotDistinct?: boolean; include?: string; with?: string }>;
  checks: Array<{ name?: string; expr: string }>;
  foreignKeys: Array<{
    name?: string;
    columns: string[];
    references: string;
    refTable: string;
    refColumns: string[];
    onDelete?: string;
    onUpdate?: string;
    match?: string;
    deferrable?: boolean;
    initiallyDeferred?: boolean;
  }>;
  exclusions: unknown[];
  inherits: unknown[];
  like: unknown[];
}

interface IndexJson extends OutputObject {
  table: string;
  elements: Array<{ expr: string; column?: string }>;
  unique?: boolean;
  method?: string;
  include?: string;
  with?: string;
  tablespace?: string;
  nullsNotDistinct?: boolean;
  where?: string;
}

const ACTIONS: Record<string, string> = { cascade: "cascade", restrict: "restrict", "no action": "no action", "set null": "set null", "set default": "set default" };

function action(text: string | undefined): string | undefined | null {
  if (text === undefined) return undefined;
  return ACTIONS[text.trim().toLowerCase().replace(/\s+/g, " ")] ?? null;
}

/** `schema.name`, with `public` for no schema. */
const qualified = (schema: string | undefined, name: string): string => `${schema ?? "public"}.${name}`;

const isDefaultSchema = (schema: string | undefined): boolean => schema === undefined || schema === "public";

/**
 * The Drizzle schema module for a build's entities. Throws
 * {@link DrizzleDialectError} when the build is not Postgres.
 */
export function renderDrizzle(entities: ReadonlyMap<string, Declarable>, opts: RenderDrizzleOptions = {}): DrizzleRender {
  const config = opts.config ?? {};
  const dialect = dialectOf(entities, config);
  if (dialect !== "postgres") {
    throw new DrizzleDialectError(`the build declares ${dialect} objects, and Drizzle has no ${dialect} dialect; the Drizzle export is for Postgres`);
  }
  const sqlEntities = new Map([...entities].filter(([, e]) => isPostgresObject(e)));
  const doc = sqlEntities.size > 0 ? serializedObjects(entities, config) : { objects: [] as OutputObject[], postgresMajor: PINNED_MAJOR };
  const objects = doc.objects;
  const p = projectFromObjects(objects, doc.postgresMajor ?? PINNED_MAJOR);

  const notes: string[] = [];
  const skipped = new Map<string, { names: string[]; reason: string }>();
  const skip = (kind: string, name: string, reason: string): void => {
    const s = skipped.get(`${kind}\0${reason}`) ?? { names: [], reason };
    s.names.push(name);
    skipped.set(`${kind}\0${reason}`, s);
  };

  // Identifiers: the export name, made safe and unique.
  const used = new Set<string>([...IMPORTABLE, ...RESERVED]);
  const idents = new Map<string, string>();
  const identOf = (o: OutputObject): string => {
    const have = idents.get(o.export);
    if (have) return have;
    let base = o.export.replace(/[^A-Za-z0-9_$]/g, "_");
    if (/^\d/.test(base)) base = `_${base}`;
    let id = base || "_";
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    idents.set(o.export, id);
    return id;
  };

  const c: Context = { p, bigintMode: opts.bigintMode ?? "number", enums: new Map(), customs: new Map(), used: new Set(), note: (t) => notes.push(t) };
  const sqlName = (o: OutputObject): string => String(o.sqlName ?? o.name);
  const label = (o: OutputObject): string => sqlName(o);

  // Schemas: one pgSchema each, except public.
  const schemaIds = new Map<string, string>();
  const schemaIdent = (schema: string): string => {
    const have = schemaIds.get(schema);
    if (have) return have;
    const declared = objects.find((o) => o.type === "Postgres::Schema" && o.name === schema);
    let base = declared ? declared.export.replace(/[^A-Za-z0-9_$]/g, "_") : `${schema.replace(/[^A-Za-z0-9_$]/g, "_")}Schema`;
    if (/^\d/.test(base)) base = `_${base}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    schemaIds.set(schema, id);
    return id;
  };
  const owner = (schema: string | undefined, kind: "table" | "view" | "materializedView" | "enum" | "sequence"): string => {
    if (isDefaultSchema(schema)) {
      return use(c, { table: "pgTable", view: "pgView", materializedView: "pgMaterializedView", enum: "pgEnum", sequence: "pgSequence" }[kind]);
    }
    use(c, "pgSchema");
    return `${schemaIdent(schema!)}.${kind}`;
  };

  // Enums and sequences come before the tables that read them.
  const blocks = { enums: [] as string[], sequences: [] as string[], tables: [] as string[], views: [] as string[] };
  let annotated = false;
  const counts = { tables: 0, views: 0, enums: 0, sequences: 0 };

  const enumObjects = objects.filter((o) => o.type === "Postgres::Enum").sort((a, b) => byName(sqlName(a), sqlName(b)));
  for (const o of enumObjects) {
    const labels = (o.labels as string[] | undefined) ?? [];
    if (labels.length === 0) {
      skip(o.type, label(o), "an enum with no labels, which Drizzle's pgEnum cannot take");
      continue;
    }
    const id = identOf(o);
    c.enums.set(qualified(o.schema as string | undefined, o.name), id);
    const fn = owner(o.schema as string | undefined, "enum");
    blocks.enums.push(`export const ${id} = ${fn}(${str(o.name)}, [${labels.map(str).join(", ")}]);`);
    counts.enums++;
  }

  // Constraint and index names are taken per schema (index-backed) and per table (the rest).
  const relationNames = new Map<string, Set<string>>();
  const relationSet = (schema: string | undefined): Set<string> => {
    const key = schema ?? "public";
    let s = relationNames.get(key);
    if (!s) relationNames.set(key, (s = new Set()));
    return s;
  };
  for (const o of objects) {
    if (["Postgres::Table", "Postgres::View", "Postgres::MaterializedView", "Postgres::Sequence", "Postgres::Index"].includes(o.type)) relationSet(o.schema as string | undefined).add(o.name);
    if (o.type === "Postgres::Table") {
      const t = o as TableJson;
      for (const k of [t.primaryKey, ...t.uniques]) if (k?.name) relationSet(o.schema as string | undefined).add(k.name);
    }
  }

  const sequenceObjects = objects.filter((o) => o.type === "Postgres::Sequence").sort((a, b) => byName(sqlName(a), sqlName(b)));
  for (const o of sequenceObjects) {
    const dataType = (o.dataType as string | undefined)?.trim().toLowerCase();
    if (dataType !== undefined && dataType !== "bigint" && dataType !== "int8") {
      skip(o.type, label(o), `a sequence of type ${dataType}: pgSequence has no data type, and its defaults are bigint's`);
      continue;
    }
    const fields: Array<[string, string]> = [];
    const num = (key: string, v: unknown) => {
      if (typeof v === "string" && /^-?\d+$/.test(v.trim())) fields.push([key, v.trim()]);
    };
    num("increment", o.increment);
    num("minValue", o.minValue);
    num("maxValue", o.maxValue);
    num("startWith", o.start);
    num("cache", o.cache);
    if (o.cycle === true) fields.push(["cycle", "true"]);
    const id = identOf(o);
    const args = fields.length > 0 ? `, { ${fields.map(([k, v]) => `${k}: ${v}`).join(", ")} }` : "";
    blocks.sequences.push(`export const ${id} = ${owner(o.schema as string | undefined, "sequence")}(${str(o.name)}${args});`);
    counts.sequences++;
  }

  // Tables.
  const tables = objects.filter((o): o is TableJson => o.type === "Postgres::Table");
  const tableById = new Map(tables.map((t) => [t.export, t]));
  const tableBySqlName = new Map(tables.map((t) => [qualified(t.schema as string | undefined, t.name), t]));
  const indexesOf = new Map<string, IndexJson[]>();
  for (const o of objects) if (o.type === "Postgres::Index") (indexesOf.get((o as IndexJson).table) ?? indexesOf.set((o as IndexJson).table, []).get((o as IndexJson).table)!).push(o as IndexJson);

  const mappedTable = (t: TableJson): boolean => t.partitionOf === undefined && t.ofType === undefined;
  const builders = new Map<string, Map<string, Built>>();
  for (const t of tables.slice().sort((a, b) => byName(sqlName(a), sqlName(b)))) {
    if (!mappedTable(t)) {
      skip(t.type, label(t), t.partitionOf !== undefined ? "a partition: its parent is the table to query" : "a table of a composite type, whose columns Drizzle cannot read from the type");
      continue;
    }
    const entity = entities.get(t.export);
    const names = runtimeColumns(entity);
    const own = new Map(t.columns.map((col) => [col.name, col]));
    const inherited = new Map<string, string | undefined>();
    for (const parent of t.inherits) {
      const pt = typeof parent === "string" ? tableById.get(parent) : undefined;
      for (const col of pt?.columns ?? []) if (!inherited.has(col.name)) inherited.set(col.name, col.type);
    }
    const pkColumns = t.primaryKey?.columns ?? [];
    const table = t.name;
    const cols: string[] = [];
    const extra: string[] = [];
    // A foreign key to another table: two tables can reference each other, and tsc cannot infer either's type through the other's callback.
    let crossFk = false;
    const built = new Map<string, Built>();
    const tableNotes = (msg: string) => notes.push(`${label(t)}: ${msg}`);
    c.note = tableNotes;
    const schemaNames = relationSet(t.schema as string | undefined);
    const constraintNames = new Set<string>();
    for (const x of [...t.checks, ...t.foreignKeys, ...t.uniques]) if (x.name) constraintNames.add(x.name);

    const singlePk = t.primaryKey && t.primaryKey.columns.length === 1 && (t.primaryKey.name === undefined || t.primaryKey.name === `${table}_pkey`) ? t.primaryKey.columns[0] : undefined;
    for (const name of names) {
      const col = own.get(name);
      const text = col?.type ?? inherited.get(name);
      const b = columnType(c, text);
      built.set(name, b);
      let expr = b.expr;
      const identity = col?.generated?.kind === "identity" ? col.generated : undefined;
      const stored = col?.generated?.kind === "stored" ? col.generated : undefined;
      if (col?.generated?.kind === "virtual") tableNotes(`column ${name} is a virtual generated column, which Drizzle cannot say; it is a plain column`);
      if (identity) {
        if (b.integer) {
          const opts = identity.options !== undefined ? identityOptions(identity.options) : "";
          if (opts === undefined) tableNotes(`column ${name}: identity options "${identity.options}" are not mapped`);
          expr += `.${identity.always ? "generatedAlwaysAsIdentity" : "generatedByDefaultAsIdentity"}(${opts ?? ""})`;
        } else tableNotes(`column ${name} is an identity column on a type Drizzle's identity does not take`);
      } else if (stored?.expr) expr += `.generatedAlwaysAs(${sqlText(c, stored.expr)})`;
      const isPk = singlePk === name;
      const notNull = col?.notNull === true || pkColumns.includes(name) || identity !== undefined || b.serial;
      if (notNull && !isPk) expr += ".notNull()";
      if (col?.default !== undefined && !stored && !identity && !b.serial) expr += `.default(${defaultArg(c, col.default, b.data)})`;
      if (isPk) expr += ".primaryKey()";
      if (col?.collate) tableNotes(`column ${name}: COLLATE ${col.collate} is not mapped`);
      cols.push(`  ${propertyName(name)}: ${expr},`);
    }
    builders.set(t.export, built);
    if (t.like.length > 0) tableNotes("LIKE clauses copy columns that the build does not list; they are not in the table");
    if (t.persistence === "unlogged") tableNotes("UNLOGGED is not mapped");

    // Extra config: primary key, uniques, foreign keys, checks, indexes.
    if (t.primaryKey && singlePk === undefined) {
      const name = t.primaryKey.name ?? chooseName(table, undefined, "pkey", schemaNames);
      extra.push(`${use(c, "primaryKey")}({ name: ${str(name)}, columns: [${t.primaryKey.columns.map((x) => member("t", x)).join(", ")}] }),`);
    }
    for (const u of t.uniques) {
      const name = u.name ?? chooseName(table, columnsAddition(u.columns), "key", schemaNames);
      if (!u.name) schemaNames.add(name);
      if (u.include || u.with) tableNotes(`unique ${name}: INCLUDE and WITH are not mapped`);
      extra.push(`${use(c, "unique")}(${str(name)}).on(${u.columns.map((x) => member("t", x)).join(", ")})${u.nullsNotDistinct ? ".nullsNotDistinct()" : ""},`);
    }
    for (const f of t.foreignKeys) {
      const target = tableById.get(f.references) ?? tableBySqlName.get(f.refTable.includes(".") ? f.refTable : qualified(t.schema as string | undefined, f.refTable));
      if (!target || !mappedTable(target)) {
        skip("Postgres::ForeignKey", `${label(t)} (${f.columns.join(", ")}) -> ${f.refTable}`, "a foreign key to a table that is not in the file");
        continue;
      }
      const refColumns = f.refColumns.length > 0 ? f.refColumns : (target.primaryKey?.columns ?? []);
      if (refColumns.length !== f.columns.length) {
        skip("Postgres::ForeignKey", `${label(t)} (${f.columns.join(", ")}) -> ${f.refTable}`, "a foreign key whose referenced columns could not be read");
        continue;
      }
      const onDelete = action(f.onDelete);
      const onUpdate = action(f.onUpdate);
      const name = f.name ?? chooseName(table, columnsAddition(f.columns), "fkey", constraintNames);
      constraintNames.add(name);
      const targetRef = target.export === t.export ? "t" : identOf(target);
      if (target.export !== t.export) crossFk = true;
      let line = `${use(c, "foreignKey")}({ name: ${str(name)}, columns: [${f.columns.map((x) => member("t", x)).join(", ")}], foreignColumns: [${refColumns.map((x) => member(targetRef, x)).join(", ")}] })`;
      if (onDelete) line += `.onDelete(${str(onDelete)})`;
      else if (onDelete === null) tableNotes(`foreign key ${name}: ON DELETE ${f.onDelete} is not mapped`);
      if (onUpdate) line += `.onUpdate(${str(onUpdate)})`;
      else if (onUpdate === null) tableNotes(`foreign key ${name}: ON UPDATE ${f.onUpdate} is not mapped`);
      if (f.match || f.deferrable || f.initiallyDeferred) tableNotes(`foreign key ${name}: MATCH and DEFERRABLE are not mapped`);
      extra.push(`${line},`);
    }
    for (const k of t.checks) {
      const name = k.name ?? checkName(table, k.expr, names, constraintNames);
      constraintNames.add(name);
      extra.push(`${use(c, "check")}(${str(name)}, ${sqlText(c, k.expr)}),`);
    }
    for (const x of t.exclusions) {
      skip("Postgres::Exclusion", label(t), "an exclusion constraint, which Drizzle has no way to say");
      void x;
    }
    for (const ix of (indexesOf.get(t.export) ?? []).sort((a, b) => byName(a.name, b.name))) {
      const line = indexLine(c, ix, names, skip, label(ix));
      if (line) extra.push(`${line},`);
    }

    const id = identOf(t);
    const fn = owner(t.schema as string | undefined, "table");
    const body = `{\n${cols.join("\n")}\n}`;
    if (crossFk) annotated = true;
    blocks.tables.push(
      extra.length > 0
        ? `export const ${id} = ${fn}(${str(t.name)}, ${body}, (t)${crossFk ? ": PgTableExtraConfigValue[]" : ""} => [\n${extra.map((x) => `  ${x}`).join("\n")}\n]);`
        : `export const ${id} = ${fn}(${str(t.name)}, ${body});`,
    );
    counts.tables++;
  }
  c.note = (text) => notes.push(text);

  // Views and materialized views: .existing(), with the columns whose types can be read.
  const relationsDone = new Map<string, Map<string, Built>>(builders);
  const viewObjects = objects.filter((o) => o.type === "Postgres::View" || o.type === "Postgres::MaterializedView").sort((a, b) => byName(sqlName(a), sqlName(b)));
  const viewBuilders = (o: OutputObject, depth = 0): Map<string, Built> => {
    const have = relationsDone.get(o.export);
    if (have) return have;
    const names = runtimeColumns(entities.get(o.export));
    const map = new Map<string, Built>();
    relationsDone.set(o.export, map);
    for (const name of names) {
      const via = passthrough(o, name, quoteIdent);
      const sourceObject = via ? objects.find((x) => x.export === via.export) : undefined;
      let source: Built | undefined;
      if (via && sourceObject && depth < 8) {
        source = (sourceObject.type === "Postgres::Table" ? relationsDone.get(sourceObject.export) : viewBuilders(sourceObject, depth + 1))?.get(via.column);
      }
      if (source) map.set(name, source);
      else {
        c.used.add("customType");
        c.used.add("unknownColumn");
        map.set(name, { expr: "unknownColumn()", data: "other", serial: false, integer: false });
      }
    }
    return map;
  };
  for (const o of viewObjects) {
    const cols = viewBuilders(o);
    const unreadable = [...cols].filter(([, b]) => b.expr === "unknownColumn()").map(([n]) => n);
    if (unreadable.length > 0) notes.push(`${label(o)}: ${unreadable.join(", ")} ${unreadable.length === 1 ? "is an expression" : "are expressions"}, so ${unreadable.length === 1 ? "its type is" : "their types are"} unknown`);
    const kind = o.type === "Postgres::View" ? "view" : "materializedView";
    const id = identOf(o);
    const body = [...cols].map(([n, b]) => `  ${propertyName(n)}: ${b.expr},`).join("\n");
    blocks.views.push(`export const ${id} = ${owner(o.schema as string | undefined, kind)}(${str(o.name)}, {\n${body}\n}).existing();`);
    counts.views++;
  }

  // Everything else Drizzle has no declaration for.
  for (const o of objects) {
    if (["Postgres::Schema", "Postgres::Table", "Postgres::Index", "Postgres::View", "Postgres::MaterializedView", "Postgres::Sequence", "Postgres::Enum"].includes(o.type)) continue;
    skip(o.type, label(o), SKIP_REASONS[o.type] ?? "Drizzle has no declaration for it");
  }
  // An index on a table that is not mapped.
  for (const [tableExport, list] of indexesOf) {
    const t = tableById.get(tableExport);
    if (!t || !mappedTable(t)) for (const ix of list) skip(ix.type, label(ix), SKIP_REASONS["Postgres::Index"]!);
  }

  // Assemble.
  const lines: string[] = [
    `// ${GENERATED_MARKER}. \`chant sql drizzle\` writes it from the build's entities.`,
    `// It targets drizzle-orm ${DRIZZLE_ORM_CHECKED}'s pg-core. chant owns the schema: query with these tables, and do not run drizzle-kit push or migrate.`,
  ];
  const skippedList = [...skipped].map(([key, v]) => ({ kind: key.split("\0")[0]!, names: v.names, reason: v.reason }));
  skippedList.sort((a, b) => (a.kind + a.reason < b.kind + b.reason ? -1 : 1));
  const uniqueNotes = [...new Set(notes)].sort();
  if (skippedList.length > 0) {
    lines.push("//", "// Not in this file, because Drizzle has no way to say it:");
    for (const s of skippedList) lines.push(`//   ${s.kind}: ${s.names.join(", ")} (${s.reason})`);
  }
  if (uniqueNotes.length > 0) {
    lines.push("//", "// In this file, with a part left out:");
    for (const n of uniqueNotes) lines.push(`//   ${n}`);
  }
  lines.push("");

  const coreNames = [...c.used].filter((n) => n !== "unknownColumn" && n !== "sql").sort();
  const imports: string[] = [];
  if (coreNames.length > 0) imports.push(`import { ${coreNames.join(", ")} } from "drizzle-orm/pg-core";`);
  if (annotated) imports.push(`import type { PgTableExtraConfigValue } from "drizzle-orm/pg-core";`);
  if (c.used.has("sql")) imports.unshift(`import { sql } from "drizzle-orm";`);
  if (imports.length > 0) lines.push(...imports, "");

  const helpers: string[] = [];
  if (c.used.has("unknownColumn")) helpers.push(`const unknownColumn = customType<{ data: unknown }>({ dataType: () => "unknown" });`);
  for (const [id, v] of [...c.customs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    helpers.push(`const ${id} = customType<{ data: ${v.ts} }>({ dataType: () => ${str(v.dbType)} });`);
  }
  if (helpers.length > 0) lines.push("// Column types pg-core has no builder for.", ...helpers, "");

  const schemaDecls = [...schemaIds].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, id]) => `export const ${id} = pgSchema(${str(name)});`);
  const sections = [schemaDecls, blocks.enums, blocks.sequences, blocks.tables, blocks.views].filter((s) => s.length > 0);
  for (const section of sections) lines.push(section.join("\n\n"), "");
  if (sections.length === 0) lines.push("export {};", "");
  return { text: `${lines.join("\n").replace(/\n+$/, "")}\n`, skipped: skippedList, approximated: uniqueNotes, counts };
}

/** One `index(...)` or `uniqueIndex(...)` call, or undefined (with the index skipped) when Drizzle cannot say it. */
function indexLine(
  c: Context,
  ix: IndexJson,
  columns: readonly string[],
  skip: (kind: string, name: string, reason: string) => void,
  name: string,
): string | undefined {
  if (ix.include || ix.with || ix.tablespace || ix.nullsNotDistinct) {
    skip(ix.type, name, "an index with INCLUDE, WITH, TABLESPACE or NULLS NOT DISTINCT, which Drizzle's index builder has no way to say");
    return undefined;
  }
  const args: string[] = [];
  for (const el of ix.elements) {
    const expr = el.expr.trim();
    const nulls = /\s+NULLS\s+(FIRST|LAST)\s*$/i.exec(expr);
    const withoutNulls = expr.replace(/\s+NULLS\s+(?:FIRST|LAST)\s*$/i, "");
    const order = /\s+(ASC|DESC)\s*$/i.exec(withoutNulls);
    const core = withoutNulls.replace(/\s+(?:ASC|DESC)\s*$/i, "").trim();
    if (el.column !== undefined && columns.includes(el.column)) {
      // Anything after the column besides its order (an operator class, COLLATE) is not something Drizzle can say.
      if (core.replace(/^(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)/, "").trim() !== "") {
        skip(ix.type, name, "an index element with an operator class or COLLATE, which Drizzle's index builder has no way to say");
        return undefined;
      }
      let a = member("t", el.column);
      if (order) a += `.${order[1]!.toLowerCase()}()`;
      // Postgres sorts NULLs first in a DESC key and last in an ASC one; drizzle-kit writes NULLS LAST unless told.
      const nullsFirst = nulls ? nulls[1]!.toUpperCase() === "FIRST" : order?.[1]!.toUpperCase() === "DESC";
      if (nulls || nullsFirst) a += nullsFirst ? ".nullsFirst()" : ".nullsLast()";
      args.push(a);
    } else {
      args.push(sqlText(c, core));
    }
  }
  if (args.length === 0) return undefined;
  const fn = use(c, ix.unique ? "uniqueIndex" : "index");
  const method = ix.method && ix.method.toLowerCase() !== "btree" ? ix.method.toLowerCase() : undefined;
  let line = `${fn}(${str(ix.name)}).${method ? `using(${str(method)}, ` : "on("}${args.join(", ")})`;
  if (ix.where) line += `.where(${sqlText(c, ix.where)})`;
  return line;
}
