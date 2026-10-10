/**
 * The Postgres side of the sql MCP tools and resources (chant #3283). Rows
 * come from the committed catalogs of the pinned servers, one per major; a
 * name present in only some majors carries `since` and `until`, as the
 * generated types' `@since` / `@until` do.
 */

import type { McpResourceContribution } from "@intentius/chant/mcp/types";
import { POSTGRES_LATEST_MAJOR, POSTGRES_MAJORS, POSTGRES_PINS, postgresImage } from "../spec/postgres-pin";
import { section, type Section } from "../lsp/postgres-catalog";
import * as pg from "../postgres/entities";
import { SqlSyntaxError } from "../postgres/tokens";

export const POSTGRES_KINDS = ["type", "index-method", "table-method", "storage-parameter", "setting", "function", "keyword", "extension"] as const;
export type PostgresKind = (typeof POSTGRES_KINDS)[number];

type Row = { name: string; summary?: string; since?: number; until?: number };

const SECTION: Record<PostgresKind, Section> = {
  type: "types",
  "index-method": "accessMethods",
  "table-method": "accessMethods",
  "storage-parameter": "storageParameters",
  setting: "settings",
  function: "functions",
  keyword: "keywords",
  extension: "extensions",
};

export function asPostgresKind(value: unknown): PostgresKind {
  if (!POSTGRES_KINDS.includes(value as PostgresKind)) throw new Error(`kind must be one of: ${POSTGRES_KINDS.join(", ")}`);
  return value as PostgresKind;
}

/** The major a tool call is about: `major` when given, else every major (undefined). */
export function asMajor(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!POSTGRES_MAJORS.includes(n)) throw new Error(`major must be one of: ${POSTGRES_MAJORS.join(", ")}`);
  return n;
}

/** The rows of a kind, each with its range; only those at `major` when one is given. */
export function postgresRows(kind: PostgresKind, major?: number): Row[] {
  const s = section<Record<string, unknown> & { type?: string; description?: string }>(SECTION[kind]);
  if (!s) throw new Error("the Postgres catalog snapshots could not be read");
  const wantType = kind === "index-method" ? "index" : kind === "table-method" ? "table" : undefined;
  const out: Row[] = [];
  for (const e of s.values()) {
    if (major !== undefined && !e.majors.includes(major)) continue;
    if (wantType && e.row.type !== wantType) continue;
    const summary = typeof e.row.description === "string" ? e.row.description : e.detail;
    out.push({ ...(e.row as object), name: e.name, ...(summary ? { summary } : {}), ...e.range } as Row);
  }
  return out;
}

export function postgresLookup(params: Record<string, unknown>): unknown {
  const kind = asPostgresKind(params.kind);
  const major = asMajor(params.major);
  const name = String(params.name ?? "");
  const all = postgresRows(kind, major);
  const exact = all.filter((r) => r.name === name);
  const found = exact.length ? exact : all.filter((r) => r.name.toLowerCase() === name.toLowerCase());
  const base = { dialect: "postgres", kind, majors: major !== undefined ? [major] : POSTGRES_MAJORS };
  if (found.length) return { ...base, matches: found };
  const near = all.filter((r) => r.name.toLowerCase().includes(name.toLowerCase())).slice(0, 10).map((r) => r.name);
  return { ...base, matches: [], closest: near };
}

export function postgresSearch(params: Record<string, unknown>): unknown {
  const kind = asPostgresKind(params.kind);
  const query = String(params.query ?? "").toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(params.limit ?? 25)));
  const hits = postgresRows(kind, asMajor(params.major)).filter((r) => r.name.toLowerCase().includes(query));
  return {
    dialect: "postgres",
    kind,
    total: hits.length,
    results: hits.slice(0, limit).map((r) => ({ name: r.name, ...(r.summary ? { summary: r.summary } : {}), ...(r.since ? { since: r.since } : {}), ...(r.until ? { until: r.until } : {}) })),
  };
}

const TAGS = { schema: pg.schema, table: pg.table, index: pg.index, view: pg.view, sequence: pg.sequence, type: pg.type, domain: pg.domain, extension: pg.extension, func: pg.func, procedure: pg.procedure, trigger: pg.trigger, policy: pg.policy, role: pg.role, grant: pg.grant } as const;
export const POSTGRES_TAGS = Object.keys(TAGS);

/** Parse one statement with the Postgres tag; an error comes back as SQLPG001 with its line and column. */
export function postgresParse(tag: string, ddl: string, position: (text: string, offset: number) => { line: number; column: number }): unknown {
  const build = (TAGS as Record<string, (s: TemplateStringsArray) => pg.PostgresObject>)[tag];
  if (!build) throw new Error(`tag must be one of: ${POSTGRES_TAGS.join(", ")}`);
  const strings = Object.assign([ddl], { raw: [ddl] }) as unknown as TemplateStringsArray;
  try {
    const entity = build(strings);
    return { ok: true, dialect: "postgres", entityType: entity.entityType, name: entity.sqlName, props: JSON.parse(JSON.stringify((entity as unknown as { props: unknown }).props)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const offset = (err as { offset?: number }).offset;
    const where = typeof offset === "number" ? position(ddl, offset) : undefined;
    const syntax = err instanceof SqlSyntaxError || (err as Error).name === "SqlTemplateError";
    return { ok: false, dialect: "postgres", rule: syntax ? "SQLPG001" : undefined, message, ...(where ?? {}) };
  }
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function resource(uri: string, name: string, description: string, read: () => unknown): McpResourceContribution {
  return { uri, name, description, mimeType: "application/json", async handler() { return json(read()); } };
}

/** The Postgres resources: every supported major's names in one list, each with `since` / `until` when not in all. */
export function postgresMcpResources(): McpResourceContribution[] {
  const all = (...kinds: PostgresKind[]) => Object.fromEntries(kinds.map((k) => [k, postgresRows(k)]));
  return [
    resource("postgres-pin", "Postgres Pins", "The pinned server for each supported major the catalogs were read from", () => ({
      latest: POSTGRES_LATEST_MAJOR,
      pins: POSTGRES_PINS.map((p) => ({ ...p, image: postgresImage(p.major) })),
    })),
    resource("postgres-types", "Postgres Types", "Column types and their aliases, with since/until majors", () => postgresRows("type")),
    resource("postgres-access-methods", "Postgres Access Methods", "Index access methods (btree, gin...) and table access methods", () => all("index-method", "table-method")),
    resource("postgres-storage-parameters", "Postgres Storage Parameters", "WITH (...) parameters, the relation kinds that accept each, and their types", () => postgresRows("storage-parameter")),
    resource("postgres-functions", "Postgres Functions", "Built-in function names with since/until majors", () => postgresRows("function")),
    resource("postgres-keywords", "Postgres Keywords", "Key words and their categories", () => postgresRows("keyword")),
    resource("postgres-settings", "Postgres Settings", "Server settings with type, default and range", () => postgresRows("setting")),
  ];
}
