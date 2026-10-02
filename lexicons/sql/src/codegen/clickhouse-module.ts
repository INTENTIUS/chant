/**
 * Render `src/generated/clickhouse.ts`, the ClickHouse dialect's generated
 * surface: string-literal unions for every named thing in the catalog, the two
 * settings interfaces, and the tables lint and the LSP read (engines with
 * their typed arguments, type families, codecs, skip index types, settings).
 *
 * The overlays are merged here, and checked against the catalog in both
 * directions. An overlay key the pinned server does not have, or a codec at
 * the pin with no overlay entry, is an error: a pin move that changes the
 * grammar has to change the overlay in the same commit.
 */

import type { ClickHouseCatalog, SettingRow } from "../spec/catalog";
import { parseEngineSyntax, type ParsedSyntax } from "../clickhouse/engine-syntax";
import type { ArgumentOverlay } from "../clickhouse/overlays/kinds";
import { ENGINE_ARGUMENTS } from "../clickhouse/overlays/engines";
import { SKIP_INDEX_PARAMETERS } from "../clickhouse/overlays/skip-indexes";
import { CODEC_OVERLAY } from "../clickhouse/overlays/codecs";
import { TYPE_PARAMETERS } from "../clickhouse/overlays/types";
import { TTL_SETTINGS } from "../clickhouse/overlays/ttl";
import { PROJECTION_SETTINGS } from "../clickhouse/overlays/projections";
import type { ArgumentSpec } from "../clickhouse/catalog-types";

/** Setting types with a TypeScript form; every enum-typed setting (no member list in the catalog) is `string`. */
const SETTING_TS_TYPES: Record<string, string> = {
  Bool: "boolean",
  BoolAuto: 'boolean | "auto"',
  UInt64: "number",
  Int64: "number",
  UInt32: "number",
  Int32: "number",
  Float: "number",
  Double: "number",
  Seconds: "number",
  Milliseconds: "number",
  NonZeroUInt64: "number",
  MaxThreads: 'number | "auto"',
  UInt64Auto: 'number | "auto"',
  FloatAuto: 'number | "auto"',
};

export function settingTsType(type: string): string {
  return SETTING_TS_TYPES[type] ?? "string";
}

const lit = (names: readonly string[]): string =>
  names.length > 0 ? names.map((n) => JSON.stringify(n)).join(" | ") : "never";

const key = (name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

/** A JSDoc line cannot contain `*\/`. */
const doc = (text: string): string => text.replace(/\*\//g, "*\\/");

function mergeArguments(
  owner: string,
  parsed: ParsedSyntax | undefined,
  overlay: Record<string, ArgumentOverlay> | undefined,
  errors: string[],
): { args?: ArgumentSpec[]; typed: boolean } {
  if (!parsed) {
    if (overlay) errors.push(`${owner}: the overlay types arguments, but the syntax line is not readable`);
    return { typed: false };
  }
  const names = new Set(parsed.args.map((a) => a.name));
  for (const name of Object.keys(overlay ?? {})) {
    if (!names.has(name)) errors.push(`${owner}: overlay argument "${name}" is not in the syntax line at this pin`);
  }
  const args = parsed.args.map((a): ArgumentSpec => {
    const o = overlay?.[a.name];
    return {
      name: a.name,
      position: a.position,
      optional: o?.optional ?? a.optional,
      repeated: a.repeated,
      named: a.named,
      kind: o?.kind ?? (a.quoted ? "string" : "unknown"),
      ...(o?.values ? { values: o.values } : {}),
      ...(o?.range ? { range: o.range } : {}),
      ...(o?.note ? { note: o.note } : {}),
    };
  });
  return { args, typed: args.every((a) => a.kind !== "unknown") };
}

function settingsInterface(name: string, rows: readonly SettingRow[]): string {
  const lines = [`export interface ${name} {`];
  for (const r of rows) {
    const tags = [doc(r.summary)];
    if (r.obsolete || r.tier === "Obsolete") tags.push("@deprecated obsolete at this pin");
    if (r.tier === "Experimental" || r.tier === "Beta") tags.push(`@tier ${r.tier}`);
    if (r.aliasFor) tags.push(`@alias ${r.aliasFor}`);
    tags.push(`@default ${doc(JSON.stringify(r.default))}`);
    lines.push(`  /** ${tags.filter(Boolean).join(" | ")} */`);
    lines.push(`  ${key(r.name)}?: ${settingTsType(r.type)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function settingsTable(name: string, keyType: string, rows: readonly SettingRow[]): string {
  const lines = [`export const ${name}: Readonly<Record<${keyType}, SettingSpec>> = {`];
  for (const r of rows) {
    lines.push(
      `  ${key(r.name)}: ${JSON.stringify({ type: r.type, default: r.default, tier: r.tier, obsolete: r.obsolete, readonly: r.readonly })},`,
    );
  }
  lines.push("};");
  return lines.join("\n");
}

export interface RenderedModule {
  /** `clickhouse-types.ts`: types only, compiles on its own (also written as the packaged `index.d.ts`). */
  declarations: string;
  /** `clickhouse.ts`: the runtime tables, re-exporting the declarations. */
  tables: string;
  /** Things worth a log line: engines left untyped. */
  notes: string[];
}

export function renderClickHouseModule(catalog: ClickHouseCatalog): RenderedModule {
  const errors: string[] = [];
  const notes: string[] = [];

  // ── Cross-checks of the overlays against the catalog ──────────────
  const engineNames = new Set(catalog.tableEngines.map((e) => e.name));
  for (const name of Object.keys(ENGINE_ARGUMENTS)) {
    if (!engineNames.has(name)) errors.push(`overlays/engines.ts: engine ${name} is not in the catalog at ${catalog.version}`);
  }
  const indexNames = new Set(catalog.skipIndexTypes.map((e) => e.name));
  for (const name of Object.keys(SKIP_INDEX_PARAMETERS)) {
    if (!indexNames.has(name)) errors.push(`overlays/skip-indexes.ts: index type ${name} is not in the catalog`);
  }
  const codecNames = new Set(catalog.codecs.map((c) => c.name));
  for (const name of Object.keys(CODEC_OVERLAY)) {
    if (!codecNames.has(name)) errors.push(`overlays/codecs.ts: codec ${name} is not in the catalog`);
  }
  for (const name of codecNames) {
    if (!CODEC_OVERLAY[name]) errors.push(`overlays/codecs.ts: codec ${name} at ${catalog.version} has no entry`);
  }
  const families = new Set(catalog.typeFamilies.filter((t) => !t.aliasOf).map((t) => t.name));
  for (const name of Object.keys(TYPE_PARAMETERS)) {
    if (!families.has(name)) errors.push(`overlays/types.ts: type family ${name} is not in the catalog`);
  }
  const mtSettings = new Set(catalog.mergeTreeSettings.map((s) => s.name));
  for (const name of [...TTL_SETTINGS, ...PROJECTION_SETTINGS]) {
    if (!mtSettings.has(name)) errors.push(`overlays: MergeTree setting ${name} is not in the catalog`);
  }

  // ── Engines ────────────────────────────────────────────────────────
  const engineLines: string[] = [];
  for (const e of catalog.tableEngines) {
    const parsed = parseEngineSyntax(e.syntax);
    const { args, typed } = mergeArguments(`engine ${e.name}`, parsed, ENGINE_ARGUMENTS[e.name], errors);
    const mergeTree = /MergeTree$/.test(e.name);
    const replicates = /^Replicated.+MergeTree$/.test(e.name) ? e.name.slice("Replicated".length) : undefined;
    if (mergeTree && !typed) notes.push(`engine ${e.name}: arguments not fully typed`);
    const spec = {
      capabilities: e.capabilities,
      syntax: e.syntax,
      ...(args ? { args } : {}),
      typed,
      mergeTree,
      ...(replicates ? { replicates } : {}),
      summary: e.summary,
    };
    engineLines.push(`  ${key(e.name)}: ${JSON.stringify(spec)},`);
  }

  const indexLines: string[] = [];
  for (const t of catalog.skipIndexTypes) {
    const { args } = mergeArguments(`index ${t.name}`, parseEngineSyntax(t.syntax), SKIP_INDEX_PARAMETERS[t.name], errors);
    indexLines.push(`  ${key(t.name)}: ${JSON.stringify({ syntax: t.syntax, ...(args ? { args } : {}), summary: t.summary })},`);
  }

  if (errors.length > 0) {
    throw new Error(
      `The ClickHouse overlays disagree with the catalog at ${catalog.version}:\n  ${errors.join("\n  ")}\n` +
        "Update src/clickhouse/overlays/ for this pin.",
    );
  }

  const canonical = catalog.typeFamilies.filter((t) => !t.aliasOf);
  const aliases = catalog.typeFamilies.filter((t) => t.aliasOf);
  const mergeTreeEngines = catalog.tableEngines.filter((e) => /MergeTree$/.test(e.name));

  const header = (what: string) => [
    `// Generated by \`npm run generate\` from the ClickHouse catalog at ${catalog.version}`,
    `// (src/spec/clickhouse-catalog.snapshot.json) and the overlays in src/clickhouse/overlays/. Do not edit.`,
    `// ${what}`,
    "",
  ];

  const declarations = [
    ...header("The type surface: unions of every named thing in the catalog, and the two settings interfaces."),
    `/** The ClickHouse release these types were read from. */`,
    `export const CLICKHOUSE_VERSION = ${JSON.stringify(catalog.version)};`,
    "",
    `export type TableEngineName = ${lit(catalog.tableEngines.map((e) => e.name))};`,
    `export type MergeTreeEngineName = ${lit(mergeTreeEngines.map((e) => e.name))};`,
    `export type DatabaseEngineName = ${lit(catalog.databaseEngines.map((e) => e.name))};`,
    `export type ColumnTypeFamily = ${lit(canonical.map((t) => t.name))};`,
    `export type ColumnTypeAlias = ${lit(aliases.map((t) => t.name))};`,
    `export type ColumnTypeName = ColumnTypeFamily | ColumnTypeAlias;`,
    `export type CodecName = ${lit(catalog.codecs.map((c) => c.name))};`,
    `export type SkipIndexType = ${lit(catalog.skipIndexTypes.map((c) => c.name))};`,
    `export type AggregateCombinator = ${lit(catalog.aggregateCombinators.filter((c) => !c.internal).map((c) => c.name))};`,
    `export type TableFunctionName = ${lit(catalog.tableFunctions)};`,
    `export type FormatName = ${lit(catalog.formats.map((f) => f.name))};`,
    `export type InputFormatName = ${lit(catalog.formats.filter((f) => f.input).map((f) => f.name))};`,
    `export type OutputFormatName = ${lit(catalog.formats.filter((f) => f.output).map((f) => f.name))};`,
    `export type AggregateFunctionName = ${lit(catalog.functions.filter((f) => f.aggregate).map((f) => f.name))};`,
    `export type ScalarFunctionName = ${lit(catalog.functions.filter((f) => !f.aggregate).map((f) => f.name))};`,
    "",
    settingsInterface("MergeTreeSettings", catalog.mergeTreeSettings),
    "",
    settingsInterface("QuerySettings", catalog.querySettings),
    "",
  ].join("\n");

  const tables = [
    ...header("The tables lint and the LSP read, typed by ./clickhouse-types."),
    `import type { CodecSpec, DatabaseEngineSpec, SettingSpec, SkipIndexSpec, TableEngineSpec, TypeFamilySpec } from "../clickhouse/catalog-types";`,
    `import type { CodecName, ColumnTypeName, DatabaseEngineName, MergeTreeSettings, QuerySettings, SkipIndexType, TableEngineName } from "./clickhouse-types";`,
    "",
    `export * from "./clickhouse-types";`,
    "",
    `export const TABLE_ENGINES: Readonly<Record<TableEngineName, TableEngineSpec>> = {`,
    ...engineLines,
    "};",
    "",
    `export const DATABASE_ENGINES: Readonly<Record<DatabaseEngineName, DatabaseEngineSpec>> = {`,
    ...catalog.databaseEngines.map((e) => `  ${key(e.name)}: ${JSON.stringify({ syntax: e.syntax, summary: e.summary })},`),
    "};",
    "",
    `export const TYPE_FAMILIES: Readonly<Record<ColumnTypeName, TypeFamilySpec>> = {`,
    ...catalog.typeFamilies.map(
      (t) => `  ${key(t.name)}: ${JSON.stringify({ canonical: t.aliasOf ?? t.name, caseInsensitive: t.caseInsensitive })},`,
    ),
    "};",
    "",
    `export const CODECS: Readonly<Record<CodecName, CodecSpec>> = {`,
    ...catalog.codecs.map((c) => {
      const o = CODEC_OVERLAY[c.name]!;
      const spec = {
        compression: c.compression,
        generic: c.generic,
        encryption: c.encryption,
        timeseries: c.timeseries,
        experimental: c.experimental,
        role: o.role,
        parameters: o.parameters,
        summary: c.summary,
      };
      return `  ${key(c.name)}: ${JSON.stringify(spec)},`;
    }),
    "};",
    "",
    `export const SKIP_INDEX_TYPES: Readonly<Record<SkipIndexType, SkipIndexSpec>> = {`,
    ...indexLines,
    "};",
    "",
    settingsTable("MERGE_TREE_SETTINGS", "keyof MergeTreeSettings", catalog.mergeTreeSettings),
    "",
    settingsTable("QUERY_SETTINGS", "keyof QuerySettings", catalog.querySettings),
    "",
  ].join("\n");

  return { declarations, tables, notes };
}
