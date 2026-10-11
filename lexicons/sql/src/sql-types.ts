/**
 * The declarations `chant sql types` writes (#3751): one `sql-types.d.ts`
 * that augments the dialect's `SqlSchema` with every table, view and
 * dictionary the build declares, keyed by qualified name.
 *
 * {@link renderSqlTypes} is pure: the entities of a build in, the file's text
 * out. It reads the objects as the serializer writes them, so a `.sql`
 * file's objects and a composite's members are covered exactly as the build
 * covers them, and it reads each template's slot record (`core/typed.ts`) for
 * the `${}` positions a foreign key or a sort key consumes.
 *
 * Each column is a `Column<sqlType, { ts, nullable, cmp }>`:
 *
 * - `sqlType` is the type as the catalog spells it (`bigint`,
 *   `timestamp(3) with time zone`, `Nullable(String)`);
 * - `ts` is its value in application code (`./postgres/row-types.ts`,
 *   `./clickhouse/row-types.ts`);
 * - `nullable` is whether the value can be NULL. A Postgres view's columns
 *   always can, as the server's own catalog says; a column whose type the
 *   generator cannot tell is `never`, which fits every slot;
 * - `cmp` is how it compares in a key: SQLPG124's type identity in Postgres
 *   (`./lint/post-synth/postgres-names.ts`'s `typeIdentity`), the type
 *   family in ClickHouse; `never` when it cannot be told.
 *
 * A view's column that is one column reference (`${t.columns.c}`, `o.${t.columns.c}`)
 * is that column's type; any other expression is `unknown`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Declarable } from "@intentius/chant/declarable";
import { GENERATED_MARKER } from "@intentius/chant/discovery/files";
import { getProvenance } from "@intentius/chant/provenance";
import type { SerializerResult } from "@intentius/chant/serializer";
import { isPostgresObject } from "./postgres/entities";
import { isClickHouseObject, quoteIdentifier } from "./clickhouse/entities";
import { quoteIdent } from "./postgres/keywords";
import { getTypedSlots, relationKey } from "./core/typed";
import { sqlSerializer } from "./serializer";
import { sqlFileOf } from "./sql-files";
import { filesDialect } from "./files/build-root";
import type { SqlDialect } from "./dialects";
import { POSTGRES_ROW_TYPES } from "./postgres/row-types";
import { clickhouseRowType } from "./clickhouse/row-types";
import { typeFamily } from "./lint/post-synth/clickhouse-helpers";
import { PINNED_MAJOR } from "./lint/post-synth/postgres-helpers";
import { parseType, projectFromObjects, resolveType, typeIdentity, type ParsedType, type PgProject } from "./lint/post-synth/postgres-names";
import type { OutputObject } from "./lint/post-synth/sql-helpers";

/** The file `chant sql types` writes, in the project's source directory. */
export const SQL_TYPES_FILE = "sql-types.d.ts";

/**
 * Where `chant sql types` writes the file by default: the project's
 * `sourceDir`, or the project root when it is unset.
 */
export function sqlTypesPath(projectDir: string, config: Record<string, unknown> | undefined): string {
  const sourceDir = typeof config?.sourceDir === "string" ? config.sourceDir : ".";
  return join(resolve(projectDir, sourceDir), SQL_TYPES_FILE);
}

/** The file on disk against what the build's entities render: `missing`, `stale` or `current`. */
export function sqlTypesState(
  entities: ReadonlyMap<string, Declarable>,
  file: string,
  opts: RenderSqlTypesOptions = {},
): "missing" | "stale" | "current" {
  if (!existsSync(file)) return "missing";
  let onDisk: string;
  try {
    onDisk = readFileSync(file, "utf8");
  } catch {
    return "missing";
  }
  return onDisk === renderSqlTypes(entities, opts) ? "current" : "stale";
}

/** The module each dialect's `SqlSchema` is augmented in. */
export const SQL_TYPES_MODULE: Readonly<Record<SqlDialect, string>> = {
  postgres: "@intentius/chant-lexicon-sql/postgres",
  clickhouse: "@intentius/chant-lexicon-sql/clickhouse",
};

export interface RenderSqlTypesOptions {
  /** The directory each declaration's source file is named relative to. Default: the working directory. */
  projectDir?: string;
  /** The project's config: `sql.postgresMajor` for the catalog, `sql.dialect` when nothing is declared. */
  config?: Record<string, unknown>;
}

interface ColumnEntry {
  name: string;
  sqlType: string;
  ts: string;
  /** `never` when the generator cannot tell. */
  nullable: boolean | "never";
  /** Undefined when it cannot be told; written `never`. */
  cmp?: string;
}

interface RelationEntry {
  key: string;
  origin: string;
  columns: ColumnEntry[];
  /** Per `${}` index, the slot's type; holes are `unknown`. */
  slots: Map<number, { type: string; note: string }>;
}

const UNKNOWN_COLUMN = (name: string): ColumnEntry => ({ name, sqlType: "unknown", ts: "unknown", nullable: "never" });

const posix = (p: string) => p.split(sep).join("/");

/** Where a declaration came from: its file relative to the project, and its export. */
function originOf(entity: Declarable, exportName: string, projectDir: string): string {
  const prov = getProvenance(entity);
  const file = sqlFileOf(entity) ?? (prov?.sourceFile ? relative(projectDir, prov.sourceFile) : undefined);
  const composite = prov?.composite ? ` (${prov.composite})` : "";
  return `${file ? posix(file) : "?"}: ${exportName}${composite}`;
}

/** The names a relation's `.columns` record holds at run time, in order. */
const runtimeColumns = (entity: Declarable | undefined): string[] => Object.keys((entity as { columns?: object } | undefined)?.columns ?? {});

/** Whether `expr` is the column `column` alone, bare or qualified (`o.user_id`). */
function isBareColumn(expr: string, quoted: string): boolean {
  const unqualified = expr.trim().replace(/^(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|[A-Za-z_][\w$]*)\./, "");
  return unqualified === quoted;
}

interface LineageJson {
  output: string;
  expr: string;
  from: Array<string | null>;
}

/** A view's column that passes one column through: that column's export and name. */
function passthrough(o: OutputObject, name: string, quote: (c: string) => string): { export: string; column: string } | undefined {
  const edge = ((o.lineage as LineageJson[] | undefined) ?? []).find((e) => e.output === name);
  const ref = edge?.from.length === 1 ? edge.from[0] : undefined;
  if (!edge || !ref) return undefined;
  const dot = ref.indexOf(".");
  if (dot < 0) return undefined;
  const column = ref.slice(dot + 1);
  return isBareColumn(edge.expr, quote(column)) ? { export: ref.slice(0, dot), column } : undefined;
}

// ── Postgres ────────────────────────────────────────────────────────────

const PG_RELATIONS = new Set(["Postgres::Table", "Postgres::View", "Postgres::MaterializedView"]);

/** A built-in type spelled as `format_type()` spells it, with its modifiers. */
function spell(canonical: string, t: ParsedType): string {
  let s = canonical;
  if (t.fields) s = `${s} ${t.fields.toLowerCase()}`;
  if (t.modifiers && t.modifiers.length > 0) {
    const mods = `(${t.modifiers.join(",")})`;
    const zoned = /^(time|timestamp)( with(?:out)? time zone)$/.exec(s);
    s = zoned ? `${zoned[1]}${mods}${zoned[2]}` : `${s}${mods}`;
  }
  return s;
}

const arrayOf = (ts: string): string => `${/[|&]/.test(ts) && !/^\{.*\}$/s.test(ts) ? `(${ts})` : ts}[]`;

/** A Postgres type's spelling, row type, and whether the type itself forbids NULL (a serial, a NOT NULL domain). */
function pgType(p: PgProject, text: string | undefined, depth = 0): { sqlType: string; ts: string; notNull: boolean } {
  const t = parseType(text);
  if (!t || depth > 5) return { sqlType: text?.trim() || "unknown", ts: "unknown", notNull: false };
  const r = resolveType(p, t, { serial: true });
  const array = (x: { sqlType: string; ts: string; notNull: boolean }) => (t.array ? { sqlType: `${x.sqlType}[]`, ts: arrayOf(x.ts), notNull: x.notNull } : x);
  if (r.kind === "builtin") {
    const ts = (POSTGRES_ROW_TYPES as Readonly<Record<string, string | undefined>>)[r.canonical] ?? "unknown";
    return array({ sqlType: spell(r.canonical, t), ts, notNull: r.serial === true });
  }
  if (r.kind === "declared") {
    const o = r.object;
    const sqlType = String(o.sqlName ?? o.name);
    if (o.type === "Postgres::Enum") {
      const labels = (o.labels as string[] | undefined) ?? [];
      return array({ sqlType, ts: labels.length > 0 ? labels.map((l) => JSON.stringify(l)).join(" | ") : "string", notNull: false });
    }
    if (o.type === "Postgres::Domain") {
      const base = pgType(p, o.dataType as string | undefined, depth + 1);
      return array({ sqlType, ts: base.ts, notNull: o.notNull === true || base.notNull });
    }
    // A row type: the driver hands back its text.
    return array({ sqlType, ts: "string", notNull: false });
  }
  return { sqlType: text!.trim(), ts: "unknown", notNull: false };
}

interface PgTableJson extends OutputObject {
  columns: Array<{ name: string; type?: string; notNull?: boolean; generated?: { kind: string } }>;
  primaryKey?: { columns: string[] };
}

function postgresEntries(objects: OutputObject[], major: number, entities: ReadonlyMap<string, Declarable>, projectDir: string): RelationEntry[] {
  const p = projectFromObjects(objects, major);
  const done = new Map<string, RelationEntry | undefined>();
  const entryOf = (exportName: string): RelationEntry | undefined => {
    if (done.has(exportName)) return done.get(exportName);
    done.set(exportName, undefined);
    const o = p.byExport.get(exportName);
    const entity = entities.get(exportName);
    if (!o || !entity || !PG_RELATIONS.has(o.type)) return undefined;
    const names = runtimeColumns(entity);
    let columns: ColumnEntry[];
    if (o.type === "Postgres::Table") {
      const t = o as PgTableJson;
      const own = new Map(t.columns.map((c) => [c.name, c]));
      // A partition's `col WITH OPTIONS` has no type of its own: its parent's stands.
      const inherited = new Map<string, string | undefined>();
      for (const parent of [...(((t.inherits as unknown[]) ?? []) as unknown[]), ...(t.partitionOf !== undefined ? [t.partitionOf] : [])]) {
        const pt = typeof parent === "string" ? (p.byExport.get(parent) as PgTableJson | undefined) : undefined;
        for (const c of pt?.columns ?? []) if (!inherited.has(c.name)) inherited.set(c.name, c.type);
      }
      const pk = new Set(t.primaryKey?.columns ?? []);
      columns = names.map((name) => {
        const c = own.get(name);
        const text = c?.type ?? inherited.get(name);
        if (text === undefined) return UNKNOWN_COLUMN(name);
        const ty = pgType(p, text);
        const notNull = c?.notNull === true || pk.has(name) || c?.generated?.kind === "identity" || ty.notNull;
        return { name, sqlType: ty.sqlType, ts: ty.ts, nullable: !notNull, cmp: typeIdentity(p, text) };
      });
    } else {
      columns = names.map((name) => {
        const via = passthrough(o, name, quoteIdent);
        const source = via && entryOf(via.export)?.columns.find((c) => c.name === via.column);
        // A view's column is nullable to Postgres whatever it reads.
        return source ? { ...source, name, nullable: source.nullable === "never" ? "never" : true } : UNKNOWN_COLUMN(name);
      });
    }
    const slots = new Map<number, { type: string; note: string }>();
    for (const s of getTypedSlots(entity)) {
      if (s.kind !== "references") continue;
      const cmp = columns.find((c) => c.name === s.column)?.cmp;
      if (cmp !== undefined) slots.set(s.index, { type: `KeyColumn<${JSON.stringify(cmp)}>`, note: `the column ${s.column} references` });
    }
    const entry: RelationEntry = { key: relationKey(o as { schema?: string; name: string }), origin: originOf(entity, exportName, projectDir), columns, slots };
    done.set(exportName, entry);
    return entry;
  };
  return objects.filter((o) => PG_RELATIONS.has(o.type)).map((o) => entryOf(o.export)).filter((e): e is RelationEntry => e !== undefined);
}

// ── ClickHouse ──────────────────────────────────────────────────────────

const CH_RELATIONS = new Set(["ClickHouse::Table", "ClickHouse::View", "ClickHouse::MaterializedView", "ClickHouse::Dictionary"]);

function chColumn(name: string, type: string | undefined, nullableModifier: boolean | undefined): ColumnEntry {
  if (!type) return UNKNOWN_COLUMN(name);
  const sqlType = nullableModifier === true && !/^Nullable\s*\(/i.test(type.trim()) ? `Nullable(${type.trim()})` : type.trim();
  const row = clickhouseRowType(sqlType);
  return { name, sqlType, ts: row.ts, nullable: row.nullable, cmp: typeFamily(sqlType) || undefined };
}

function clickhouseEntries(objects: OutputObject[], entities: ReadonlyMap<string, Declarable>, projectDir: string): RelationEntry[] {
  const byExport = new Map(objects.map((o) => [o.export, o]));
  const done = new Map<string, RelationEntry | undefined>();
  const entryOf = (exportName: string): RelationEntry | undefined => {
    if (done.has(exportName)) return done.get(exportName);
    done.set(exportName, undefined);
    const o = byExport.get(exportName);
    const entity = entities.get(exportName);
    if (!o || !entity || !CH_RELATIONS.has(o.type)) return undefined;
    const declared = new Map(((o.columns as Array<{ name: string; type?: string; nullable?: boolean }> | undefined) ?? []).map((c) => [c.name, c]));
    const columns = runtimeColumns(entity).map((name) => {
      const c = declared.get(name);
      if (c) return chColumn(name, c.type, c.nullable);
      const via = passthrough(o, name, quoteIdentifier);
      const source = via && entryOf(via.export)?.columns.find((x) => x.name === via.column);
      return source ? { ...source, name } : UNKNOWN_COLUMN(name);
    });
    const slots = new Map<number, { type: string; note: string }>();
    for (const s of getTypedSlots(entity)) if (s.kind === "sortKey") slots.set(s.index, { type: "NotNullColumn", note: "a sort key element" });
    const entry: RelationEntry = { key: relationKey(o as { database?: string; name: string }), origin: originOf(entity, exportName, projectDir), columns, slots };
    done.set(exportName, entry);
    return entry;
  };
  return objects.filter((o) => CH_RELATIONS.has(o.type)).map((o) => entryOf(o.export)).filter((e): e is RelationEntry => e !== undefined);
}

// ── Rendering ───────────────────────────────────────────────────────────

const propertyName = (name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

function renderEntry(e: RelationEntry, lines: string[]): void {
  lines.push(`    /** ${e.origin.replace(/\*\//g, "* /")} */`, `    ${JSON.stringify(e.key)}: {`, "      columns: {");
  for (const c of e.columns) {
    const nullable = c.nullable === "never" ? "never" : String(c.nullable);
    const cmp = c.cmp === undefined ? "never" : JSON.stringify(c.cmp);
    lines.push(`        ${propertyName(c.name)}: Column<${JSON.stringify(c.sqlType)}, { ts: ${c.ts}; nullable: ${nullable}; cmp: ${cmp} }>;`);
  }
  lines.push("      };");
  if (e.slots.size > 0) {
    const last = Math.max(...e.slots.keys());
    const types = Array.from({ length: last + 1 }, (_, i) => e.slots.get(i)?.type ?? "unknown");
    const notes = [...e.slots].sort(([a], [b]) => a - b).map(([i, s]) => `\`\${}\` ${i + 1} is ${s.note}`);
    lines.push(`      /** ${notes.join("; ")}. */`, `      slots: [${types.join(", ")}];`);
  }
  lines.push("    };");
}

/** The dialect a build's entities declare, else the config's, else ClickHouse. */
function dialectOf(entities: ReadonlyMap<string, Declarable>, config: Record<string, unknown>): SqlDialect {
  try {
    return filesDialect(entities, config);
  } catch {
    return "clickhouse";
  }
}

/**
 * The `sql-types.d.ts` for a build's entities: one module that augments the
 * dialect's `SqlSchema` with each table, view and dictionary, in key order.
 * Pure, so a check can render it in memory and compare it with the file.
 */
export function renderSqlTypes(entities: ReadonlyMap<string, Declarable>, opts: RenderSqlTypesOptions = {}): string {
  const config = opts.config ?? {};
  const projectDir = opts.projectDir ?? process.cwd();
  const dialect = dialectOf(entities, config);
  const sqlEntities = new Map([...entities].filter(([, e]) => isPostgresObject(e) || isClickHouseObject(e)));
  let entries: RelationEntry[] = [];
  if (sqlEntities.size > 0) {
    const out = sqlSerializer.serialize(new Map(entities), undefined, { config }) as SerializerResult | string;
    const doc = JSON.parse(typeof out === "string" ? out : out.primary) as { objects: OutputObject[]; postgresMajor?: number };
    entries = dialect === "postgres" ? postgresEntries(doc.objects, doc.postgresMajor ?? PINNED_MAJOR, entities, projectDir) : clickhouseEntries(doc.objects, entities, projectDir);
  }
  const byKey = new Map<string, RelationEntry>();
  for (const e of entries) if (!byKey.has(e.key)) byKey.set(e.key, e);
  const sorted = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const brands = new Set<string>();
  if (sorted.length > 0) brands.add("Column");
  for (const e of sorted) for (const s of e.slots.values()) brands.add(s.type.replace(/<.*$/, ""));
  const module = SQL_TYPES_MODULE[dialect];
  const lines = [
    `// ${GENERATED_MARKER}. \`chant sql types\` writes it from the build's entities.`,
    `import type ${brands.size > 0 ? `{ ${[...brands].sort().join(", ")} }` : "{}"} from ${JSON.stringify(module)};`,
    "",
    `declare module ${JSON.stringify(module)} {`,
  ];
  if (sorted.length === 0) lines.push("  interface SqlSchema {}");
  else {
    lines.push("  interface SqlSchema {");
    for (const e of sorted) renderEntry(e, lines);
    lines.push("  }");
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
