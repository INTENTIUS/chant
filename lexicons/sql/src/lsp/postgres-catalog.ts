/**
 * The Postgres catalogs the editor and the MCP tools read: the committed
 * snapshots of the pinned servers (one per supported major), parsed once.
 * No server is needed; the snapshots are what generation reads too.
 *
 * A name's availability is read straight off the snapshots: it is in a major
 * when that major's snapshot lists it, so `since` and `until` here agree with
 * the generated types' `@since` / `@until`.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { parseCatalog, type PostgresCatalog } from "../spec/postgres-catalog";
import { POSTGRES_LATEST_MAJOR, POSTGRES_MAJORS } from "../spec/postgres-pin";
import { STORAGE_PARAMETER_TYPES } from "../postgres/overlays/storage";

const SPEC = join(dirname(fileURLToPath(import.meta.url)), "..", "spec");

let cached: Map<number, PostgresCatalog> | null = null;

/** Every supported major's catalog, or undefined when a snapshot cannot be read. */
export function postgresCatalogs(): Map<number, PostgresCatalog> | undefined {
  if (cached) return cached;
  try {
    const map = new Map<number, PostgresCatalog>();
    for (const major of POSTGRES_MAJORS) map.set(major, parseCatalog(readFileSync(join(SPEC, `postgres-catalog-${major}.snapshot.json`), "utf-8")));
    cached = map;
    return map;
  } catch {
    return undefined;
  }
}

/** Where a name is available: the first major with it when that is not the oldest, the last when that is not the newest. */
export interface Availability {
  since?: number;
  until?: number;
}

export interface Entry<Row> {
  name: string;
  /** The row from the newest major that has the name. */
  row: Row;
  majors: number[];
  range: Availability;
  detail?: string;
}

export const SECTIONS = ["types", "accessMethods", "functions", "keywords", "settings", "extensions", "storageParameters"] as const;
export type Section = (typeof SECTIONS)[number];

export interface TypeRow {
  /** The SQL spelling. */
  sqlName: string;
  catalogName: string;
  kind: string;
  category: string;
  aliasOf?: string;
}
export interface MethodRow {
  name: string;
  type: "index" | "table";
  properties: string[];
}
export interface FunctionRow {
  name: string;
  kinds: string;
  overloads: number;
}
export interface KeywordRow {
  word: string;
  code: string;
  description: string;
}
export interface SettingRow {
  name: string;
  type: string;
  context: string;
  category: string;
  unit: string | null;
  default: string | null;
  min: string | null;
  max: string | null;
}
export interface ExtensionRow {
  name: string;
  defaultVersion: string;
  description: string | null;
}
export interface StorageRow {
  name: string;
  targets: string[];
  type?: unknown;
}

/** SQL spellings with no `pg_type` row of their own. */
const SPELLINGS: Record<string, string> = {
  int: "integer",
  dec: "numeric",
  decimal: "numeric",
  float: "double precision",
  serial: "integer",
  bigserial: "bigint",
  smallserial: "smallint",
  serial4: "integer",
  serial8: "bigint",
  serial2: "smallint",
};

const unquote = (s: string): string => (s.startsWith('"') ? s.slice(1, -1) : s);

function rowsOf(section: Section, catalog: PostgresCatalog): Array<{ key: string; row: unknown; detail?: string }> {
  switch (section) {
    case "types": {
      const out: Array<{ key: string; row: TypeRow; detail?: string }> = [];
      const have = new Set<string>();
      for (const t of catalog.types) {
        if (t.kind === "p" || t.name.startsWith("_")) continue;
        const sqlName = unquote(t.sqlName);
        have.add(sqlName);
        out.push({ key: sqlName, row: { sqlName, catalogName: t.name, kind: t.kind, category: t.category } });
        if (t.name !== sqlName) {
          have.add(t.name);
          out.push({ key: t.name, row: { sqlName, catalogName: t.name, kind: t.kind, category: t.category, aliasOf: sqlName }, detail: `alias of ${sqlName}` });
        }
      }
      for (const [alias, target] of Object.entries(SPELLINGS)) {
        const base = out.find((o) => o.key === target)?.row as TypeRow | undefined;
        if (base && !have.has(alias)) out.push({ key: alias, row: { ...base, aliasOf: target }, detail: `alias of ${target}` });
      }
      return out;
    }
    case "accessMethods":
      return catalog.accessMethods.map((a) => ({
        key: a.name,
        row: { name: a.name, type: a.type === "i" ? "index" : "table", properties: a.properties ?? [] } satisfies MethodRow,
      }));
    case "functions":
      return catalog.functions.filter((f) => !f.internal).map((f) => ({ key: f.name, row: { name: f.name, kinds: f.kinds, overloads: f.overloads } satisfies FunctionRow }));
    case "keywords":
      return catalog.keywords.map((k) => ({ key: k.word, row: k }));
    case "settings":
      return catalog.settings.map((s) => ({ key: s.name, row: s }));
    case "extensions":
      return catalog.extensions.map((e) => ({ key: e.name, row: e }));
    case "storageParameters": {
      const by = new Map<string, string[]>();
      for (const [target, names] of Object.entries(catalog.storageParameters)) for (const n of names) by.set(n, [...(by.get(n) ?? []), target]);
      return [...by].map(([name, targets]) => ({ key: name, row: { name, targets, type: STORAGE_PARAMETER_TYPES[name] } satisfies StorageRow }));
    }
  }
}

const oldest = POSTGRES_MAJORS[0]!;

/** `since`/`until` for the majors a name is in. */
export function rangeOf(majors: readonly number[]): Availability {
  const first = Math.min(...majors);
  const last = Math.max(...majors);
  return { ...(first > oldest ? { since: first } : {}), ...(last < POSTGRES_LATEST_MAJOR ? { until: last } : {}) };
}

/** "14 to 17", "16 and later" or "" when in every major. */
export function describeRange(r: Availability): string {
  if (r.since !== undefined && r.until !== undefined) return `Postgres ${r.since} to ${r.until}`;
  if (r.since !== undefined) return `Postgres ${r.since} and later`;
  if (r.until !== undefined) return `up to Postgres ${r.until}`;
  return "";
}

const sections = new Map<Section, Map<string, Entry<unknown>>>();

/** A section across every major, one entry per name. */
export function section<Row>(name: Section): Map<string, Entry<Row>> | undefined {
  const hit = sections.get(name);
  if (hit) return hit as Map<string, Entry<Row>>;
  const catalogs = postgresCatalogs();
  if (!catalogs) return undefined;
  const map = new Map<string, Entry<unknown>>();
  for (const major of POSTGRES_MAJORS) {
    for (const { key, row, detail } of rowsOf(name, catalogs.get(major)!)) {
      const e = map.get(key);
      if (e) {
        e.row = row;
        e.majors.push(major);
        if (detail) e.detail = detail;
      } else map.set(key, { name: key, row, majors: [major], range: {}, ...(detail ? { detail } : {}) });
    }
  }
  for (const e of map.values()) e.range = rangeOf(e.majors);
  sections.set(name, map);
  return map as Map<string, Entry<Row>>;
}

/** The entries of a section that exist at `major`. */
export function entriesAt<Row>(name: Section, major: number): Entry<Row>[] {
  const s = section<Row>(name);
  return s ? [...s.values()].filter((e) => e.majors.includes(major)) : [];
}

/** The entry for `name` at `major`, matching case-insensitively for names Postgres folds. */
export function entryAt<Row>(name: Section, key: string, major: number): Entry<Row> | undefined {
  const s = section<Row>(name);
  const e = s?.get(key) ?? s?.get(key.toLowerCase());
  return e && e.majors.includes(major) ? e : undefined;
}

/** `postgresMajor` in the nearest `chant.config.*` above a file, when it names a supported one. */
export function configuredMajor(fileName: string): number | undefined {
  let dir = dirname(resolve(fileName));
  for (let i = 0; i < 12; i++) {
    for (const name of ["chant.config.ts", "chant.config.json", "chant.config.mts", "chant.config.js", "chant.config.mjs"]) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      try {
        const m = /["']?postgresMajor["']?\s*:\s*(\d+)/.exec(readFileSync(file, "utf-8"));
        const major = m ? Number(m[1]) : undefined;
        return major !== undefined && POSTGRES_MAJORS.includes(major) ? major : undefined;
      } catch {
        return undefined;
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** The major a file is written for: the project's configured one, else the newest. */
export function majorFor(fileName: string): number {
  return configuredMajor(fileName) ?? POSTGRES_LATEST_MAJOR;
}
