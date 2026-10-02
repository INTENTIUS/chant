/**
 * The ClickHouse catalog: what generation reads from a pinned server's
 * `system.*` tables, in the shape the committed snapshot stores.
 *
 * Every section is sorted by name, and the snapshot is written one entry per
 * line, so a pin move is a line diff a reviewer can read. Nothing here depends
 * on the host: the columns that reflect server config (`value`, `changed`) are
 * never read, every query orders its rows, and `auto(<cores>)` defaults are
 * written as `auto`.
 */

import { clickhouseQuery, type ClickHouseEndpoint } from "../clickhouse/http";

export interface EngineCapabilities {
  settings: boolean;
  skippingIndices: boolean;
  projections: boolean;
  sortOrder: boolean;
  ttl: boolean;
  replication: boolean;
  deduplication: boolean;
  parallelInsert: boolean;
}

export interface TableEngineRow {
  name: string;
  /** The server's one-line usage, e.g. `ENGINE = ReplacingMergeTree([ver [, is_deleted]]) ORDER BY expr`. */
  syntax: string;
  summary: string;
  capabilities: EngineCapabilities;
}

export interface DatabaseEngineRow {
  name: string;
  syntax: string;
  summary: string;
}

export interface TypeFamilyRow {
  name: string;
  caseInsensitive: boolean;
  /** Set when the name is an alias (`BIGINT` for `Int64`). */
  aliasOf?: string;
}

export interface CodecRow {
  name: string;
  compression: boolean;
  generic: boolean;
  encryption: boolean;
  timeseries: boolean;
  experimental: boolean;
  summary: string;
}

export interface SkipIndexTypeRow {
  name: string;
  syntax: string;
  summary: string;
}

export interface CombinatorRow {
  name: string;
  internal: boolean;
}

export interface FormatRow {
  name: string;
  input: boolean;
  output: boolean;
}

export interface FunctionRow {
  name: string;
  aggregate: boolean;
  caseInsensitive: boolean;
  aliasOf?: string;
}

export interface SettingRow {
  name: string;
  /** The server's setting type, e.g. `UInt64`, `Bool`, `MergeSelectorAlgorithm`. */
  type: string;
  default: string;
  min?: string;
  max?: string;
  /** `Production`, `Beta`, `Experimental` or `Obsolete`. */
  tier: string;
  obsolete: boolean;
  readonly: boolean;
  aliasFor?: string;
  summary: string;
}

export interface ClickHouseCatalog {
  dialect: "clickhouse";
  /** `SELECT version()` on the server it was read from. */
  version: string;
  /** The image reference that server ran. */
  image: string;
  tableEngines: TableEngineRow[];
  databaseEngines: DatabaseEngineRow[];
  typeFamilies: TypeFamilyRow[];
  codecs: CodecRow[];
  skipIndexTypes: SkipIndexTypeRow[];
  aggregateCombinators: CombinatorRow[];
  tableFunctions: string[];
  formats: FormatRow[];
  functions: FunctionRow[];
  keywords: string[];
  mergeTreeSettings: SettingRow[];
  querySettings: SettingRow[];
}

/** The section names, in the order the snapshot writes them. */
export const CATALOG_SECTIONS = [
  "tableEngines",
  "databaseEngines",
  "typeFamilies",
  "codecs",
  "skipIndexTypes",
  "aggregateCombinators",
  "tableFunctions",
  "formats",
  "functions",
  "keywords",
  "mergeTreeSettings",
  "querySettings",
] as const satisfies readonly (keyof ClickHouseCatalog)[];

// ── Normalization ────────────────────────────────────────────────────

/** `max_threads` and a few others default to `auto(<cores>)`; the core count is the host's, not the pin's. */
export function normalizeDefault(value: unknown): string {
  return String(value ?? "").replace(/auto\(\d+\)/g, "auto");
}

/**
 * The first prose line of a markdown description, at most 200 characters.
 * Descriptions are multi-line markdown with headings and fenced examples; a
 * summary is what a hover or a JSDoc line can carry.
 */
export function summaryOf(description: unknown): string {
  let fenced = false;
  let line: string | undefined;
  for (const raw of String(description ?? "").split("\n")) {
    const l = raw.trim();
    if (l.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || l.length === 0 || l.startsWith("#") || l.startsWith("|")) continue;
    line = l;
    break;
  }
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

const optional = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const s = String(value);
  return s === "" ? undefined : s;
};

const flag = (value: unknown): boolean => value === 1 || value === true || value === "1";

// ── Reading a server ─────────────────────────────────────────────────

/**
 * Read the catalog from a running server. Every query has an explicit
 * `ORDER BY`: system tables have no stable row order.
 */
export async function readCatalog(endpoint: ClickHouseEndpoint, image: string): Promise<ClickHouseCatalog> {
  const q = (sql: string) => clickhouseQuery(endpoint, sql);
  const [{ v: version }] = (await q("SELECT version() AS v")) as Array<{ v: string }>;

  const engines = await q(
    "SELECT name, supports_settings, supports_skipping_indices, supports_projections, supports_sort_order, " +
      "supports_ttl, supports_replication, supports_deduplication, supports_parallel_insert, syntax, description " +
      "FROM system.table_engines ORDER BY name",
  );
  const dbEngines = await q("SELECT name, syntax, description FROM system.database_engines ORDER BY name");
  const types = await q("SELECT name, case_insensitive, alias_to FROM system.data_type_families ORDER BY name");
  const codecs = await q(
    "SELECT name, is_compression, is_generic_compression, is_encryption, is_timeseries_codec, is_experimental, description " +
      "FROM system.codecs ORDER BY name",
  );
  const indexTypes = await q("SELECT name, syntax, description FROM system.data_skipping_index_types ORDER BY name");
  const combinators = await q("SELECT name, is_internal FROM system.aggregate_function_combinators ORDER BY name");
  const tableFunctions = await q("SELECT name FROM system.table_functions ORDER BY name");
  const formats = await q("SELECT name, is_input, is_output FROM system.formats ORDER BY name");
  const functions = await q(
    "SELECT name, is_aggregate, case_insensitive, alias_to FROM system.functions WHERE origin = 'System' ORDER BY name",
  );
  const keywords = await q("SELECT keyword FROM system.keywords ORDER BY keyword");
  const mtSettings = await q(
    "SELECT name, type, default, min, max, readonly, is_obsolete, tier, description FROM system.merge_tree_settings ORDER BY name",
  );
  const settings = await q(
    "SELECT name, type, default, min, max, readonly, is_obsolete, tier, alias_for, description FROM system.settings ORDER BY name",
  );

  const setting = (r: Record<string, unknown>): SettingRow => ({
    name: String(r.name),
    type: String(r.type),
    default: normalizeDefault(r.default),
    ...(optional(r.min) !== undefined ? { min: optional(r.min) } : {}),
    ...(optional(r.max) !== undefined ? { max: optional(r.max) } : {}),
    tier: String(r.tier),
    obsolete: flag(r.is_obsolete),
    readonly: flag(r.readonly),
    ...(optional(r.alias_for) !== undefined ? { aliasFor: optional(r.alias_for) } : {}),
    summary: summaryOf(r.description),
  });

  return {
    dialect: "clickhouse",
    version,
    image,
    tableEngines: engines.map((e) => ({
      name: String(e.name),
      syntax: String(e.syntax ?? ""),
      summary: summaryOf(e.description),
      capabilities: {
        settings: flag(e.supports_settings),
        skippingIndices: flag(e.supports_skipping_indices),
        projections: flag(e.supports_projections),
        sortOrder: flag(e.supports_sort_order),
        ttl: flag(e.supports_ttl),
        replication: flag(e.supports_replication),
        deduplication: flag(e.supports_deduplication),
        parallelInsert: flag(e.supports_parallel_insert),
      },
    })),
    databaseEngines: dbEngines.map((e) => ({
      name: String(e.name),
      syntax: String(e.syntax ?? ""),
      summary: summaryOf(e.description),
    })),
    typeFamilies: types.map((t) => ({
      name: String(t.name),
      caseInsensitive: flag(t.case_insensitive),
      ...(optional(t.alias_to) !== undefined ? { aliasOf: optional(t.alias_to) } : {}),
    })),
    codecs: codecs.map((c) => ({
      name: String(c.name),
      compression: flag(c.is_compression),
      generic: flag(c.is_generic_compression),
      encryption: flag(c.is_encryption),
      timeseries: flag(c.is_timeseries_codec),
      experimental: flag(c.is_experimental),
      summary: summaryOf(c.description),
    })),
    skipIndexTypes: indexTypes.map((c) => ({
      name: String(c.name),
      syntax: String(c.syntax ?? ""),
      summary: summaryOf(c.description),
    })),
    aggregateCombinators: combinators.map((c) => ({ name: String(c.name), internal: flag(c.is_internal) })),
    tableFunctions: tableFunctions.map((f) => String(f.name)),
    formats: formats.map((f) => ({ name: String(f.name), input: flag(f.is_input), output: flag(f.is_output) })),
    functions: functions.map((f) => ({
      name: String(f.name),
      aggregate: flag(f.is_aggregate),
      caseInsensitive: flag(f.case_insensitive),
      ...(optional(f.alias_to) !== undefined ? { aliasOf: optional(f.alias_to) } : {}),
    })),
    keywords: keywords.map((k) => String(k.keyword)),
    mergeTreeSettings: mtSettings.map(setting),
    querySettings: settings.map(setting),
  };
}

// ── The snapshot's text form ─────────────────────────────────────────

/**
 * Write the catalog with one array entry per line. A pretty-printed tree would
 * spread one engine over a dozen lines; this keeps a pin move to one changed
 * line per changed entry.
 */
export function stringifyCatalog(catalog: ClickHouseCatalog): string {
  const lines: string[] = ["{"];
  lines.push(`  "dialect": ${JSON.stringify(catalog.dialect)},`);
  lines.push(`  "version": ${JSON.stringify(catalog.version)},`);
  lines.push(`  "image": ${JSON.stringify(catalog.image)},`);
  CATALOG_SECTIONS.forEach((section, i) => {
    const rows = catalog[section] as unknown[];
    const last = i === CATALOG_SECTIONS.length - 1;
    if (rows.length === 0) {
      lines.push(`  ${JSON.stringify(section)}: []${last ? "" : ","}`);
      return;
    }
    lines.push(`  ${JSON.stringify(section)}: [`);
    rows.forEach((row, j) => lines.push(`    ${JSON.stringify(row)}${j === rows.length - 1 ? "" : ","}`));
    lines.push(`  ]${last ? "" : ","}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/** Parse and shape-check a snapshot. Throws naming the first section that is missing or not a list. */
export function parseCatalog(text: string): ClickHouseCatalog {
  const value = JSON.parse(text) as Partial<ClickHouseCatalog>;
  if (value.dialect !== "clickhouse") throw new Error(`not a ClickHouse catalog (dialect ${String(value.dialect)})`);
  if (typeof value.version !== "string") throw new Error("catalog has no version");
  for (const section of CATALOG_SECTIONS) {
    if (!Array.isArray(value[section])) throw new Error(`catalog section ${section} is missing or not a list`);
  }
  return value as ClickHouseCatalog;
}
