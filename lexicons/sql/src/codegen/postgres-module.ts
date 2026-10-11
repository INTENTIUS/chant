/**
 * Render the Postgres dialect's generated surface from the catalogs of every
 * supported major:
 *
 * - `src/generated/postgres-types.ts`: string-literal unions of every named
 *   thing in any major's catalog, the `Settings` and `StorageParams_*`
 *   interfaces, and the `VERSION_RANGES` table saying which entries are not in
 *   all majors.
 * - `src/generated/postgres.ts`: the tables lint and the LSP read (settings,
 *   storage parameters, column types), with the overlays merged in.
 *
 * The overlays are checked against the catalogs in both directions. An overlay
 * key no major has, or a storage parameter the probe found with no overlay
 * entry, is an error: a pin move that changes the grammar has to change the
 * overlay in the same commit.
 *
 * Output depends only on the catalogs and the overlays: every map is walked
 * in sorted order (by code unit, not locale), so two runs are byte-identical.
 */

import type {
  AccessMethodRow,
  ExtensionRow,
  FunctionRow,
  KeywordRow,
  OpClassRow,
  PostgresCatalog,
  SettingRow,
  TypeRow,
} from "../spec/postgres-catalog";
import { COLUMN_TYPE_PARAMETERS, SERIAL_TYPES, TYPE_SPELLINGS } from "../postgres/overlays/types";
import { STORAGE_PARAMETER_TYPES, type StorageParameterType } from "../postgres/overlays/storage";
import { CONSTRAINTS } from "../postgres/overlays/constraints";
import { COLUMN_CLAUSES } from "../postgres/overlays/columns";
import { PARTITIONING } from "../postgres/overlays/partitioning";
import { INDEX_CLAUSES } from "../postgres/overlays/indexes";
import { RELATION_CLAUSES, SEQUENCE_CLAUSES, VIEW_CLAUSES } from "../postgres/overlays/relations";
import { TYPE_DDL } from "../postgres/overlays/type-ddl";
import type { Clause } from "../postgres/overlays/kinds";
import type { VersionRange } from "../postgres/catalog-types";

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(compare);
const lit = (names: readonly string[]): string =>
  names.length > 0 ? names.map((n) => JSON.stringify(n)).join(" | ") : "never";
const key = (name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
const doc = (text: string): string => text.replace(/\*\//g, "*\\/");
const identifier = (name: string): string => name.replace(/[^A-Za-z0-9]+/g, "_");

/** One name across the majors: the row at the newest major that has it, and the majors that have it. */
interface Entry<T> {
  name: string;
  latest: T;
  /** Every row, oldest major first. */
  rows: T[];
  range: VersionRange;
}

/**
 * Merge `pick(catalog)` across the majors by `keyOf`. `since` and `until` are
 * set when the name is missing from the oldest or the newest major. A name
 * with a gap (in 14, gone in 15, back in 16) is an error: a range cannot say it.
 */
function union<T>(
  what: string,
  catalogs: readonly PostgresCatalog[],
  pick: (c: PostgresCatalog) => readonly T[],
  keyOf: (row: T) => string,
  errors: string[],
): Entry<T>[] {
  const byName = new Map<string, Array<{ index: number; row: T }>>();
  catalogs.forEach((c, index) => {
    for (const row of pick(c)) {
      const k = keyOf(row);
      const list = byName.get(k);
      if (list) list.push({ index, row });
      else byName.set(k, [{ index, row }]);
    }
  });
  const last = catalogs.length - 1;
  const out: Entry<T>[] = [];
  for (const name of sorted(byName.keys())) {
    const present = byName.get(name)!;
    const first = present[0]!.index;
    const end = present[present.length - 1]!.index;
    if (end - first + 1 !== present.length) {
      errors.push(`${what} ${name} is present in non-adjacent majors (${present.map((p) => majorOfIndex(catalogs, p.index)).join(", ")})`);
    }
    out.push({
      name,
      latest: present[present.length - 1]!.row,
      rows: present.map((p) => p.row),
      range: {
        ...(first > 0 ? { since: majorOfIndex(catalogs, first) } : {}),
        ...(end < last ? { until: majorOfIndex(catalogs, end) } : {}),
      },
    });
  }
  return out;
}

const majorOfIndex = (catalogs: readonly PostgresCatalog[], i: number): number => Number.parseInt(catalogs[i]!.version, 10);

const bounded = (r: VersionRange): boolean => r.since !== undefined || r.until !== undefined;

/** ` | @since 15 | @until 17` */
function rangeTags(r: VersionRange): string[] {
  return [...(r.since !== undefined ? [`@since ${r.since}`] : []), ...(r.until !== undefined ? [`@until ${r.until}`] : [])];
}

function settingTsType(rows: readonly SettingRow[]): string {
  const parts = new Set<string>();
  for (const s of rows) {
    if (s.enumvals) for (const v of s.enumvals) parts.add(JSON.stringify(v));
    else parts.add({ bool: "boolean", integer: "number", real: "number", string: "string" }[s.type] ?? "string");
  }
  // `string` absorbs literals; a union of the two is the same type and noisier.
  return parts.has("string") ? "string" : [...parts].sort(compare).join(" | ");
}

function storageTsType(t: StorageParameterType): string {
  if (t.kind === "boolean") return "boolean";
  if (t.kind === "enum") return lit(t.values);
  return "number";
}

function checkClauses(file: string, table: Record<string, Clause>, majors: readonly number[], errors: string[]): void {
  const lo = majors[0]!;
  const hi = majors[majors.length - 1]!;
  for (const [name, clause] of Object.entries(table)) {
    for (const bound of [clause.since, clause.until]) {
      if (bound !== undefined && (bound < lo || bound > hi)) {
        errors.push(`overlays/${file}: ${name} has a bound ${bound} outside the supported majors ${lo}..${hi}`);
      }
    }
  }
}

export interface RenderedPostgresModule {
  /** `postgres-types.ts`: types, and the range table; compiles on its own. */
  declarations: string;
  /** `postgres.ts`: the runtime tables, re-exporting the declarations. */
  tables: string;
  /** Things worth a log line. */
  notes: string[];
}

export function renderPostgresModule(catalogs: readonly PostgresCatalog[]): RenderedPostgresModule {
  if (catalogs.length === 0) throw new Error("no Postgres catalog was read");
  const errors: string[] = [];
  const notes: string[] = [];
  const majors = catalogs.map((c) => Number.parseInt(c.version, 10));

  // ── Union of every section ─────────────────────────────────────────
  const types = union<TypeRow>("type", catalogs, (c) => c.types.filter((t) => t.kind !== "p"), (t) => t.name, errors);
  const accessMethods = union<AccessMethodRow>("access method", catalogs, (c) => c.accessMethods, (a) => a.name, errors);
  const opclasses = union<OpClassRow>("operator class", catalogs, (c) => c.opclasses, (o) => `${o.am}.${o.name}`, errors);
  const functions = union<FunctionRow>("function", catalogs, (c) => c.functions.filter((f) => !f.internal), (f) => f.name, errors);
  const settings = union<SettingRow>("setting", catalogs, (c) => c.settings, (s) => s.name, errors);
  const keywords = union<KeywordRow>("keyword", catalogs, (c) => c.keywords, (k) => `${k.code}:${k.word}`, errors);
  const extensions = union<ExtensionRow>("extension", catalogs, (c) => c.extensions, (e) => e.name, errors);
  const storage = union<{ target: string; name: string }>(
    "storage parameter",
    catalogs,
    (c) => Object.entries(c.storageParameters).flatMap(([target, names]) => names.map((name) => ({ target, name }))),
    (p) => `${p.target}.${p.name}`,
    errors,
  );

  // ── Cross-checks of the overlays against the catalogs ──────────────
  const sqlNames = new Set(types.map((t) => t.latest.sqlName));
  for (const name of Object.keys(COLUMN_TYPE_PARAMETERS)) {
    if (!sqlNames.has(name)) errors.push(`overlays/types.ts: type ${name} is not in any catalog`);
  }
  for (const [spelling, canonical] of [...Object.entries(TYPE_SPELLINGS), ...Object.entries(SERIAL_TYPES)]) {
    if (!sqlNames.has(canonical)) errors.push(`overlays/types.ts: ${spelling} stands for ${canonical}, which is not in any catalog`);
  }
  const probed = new Set(storage.map((p) => p.latest.name));
  for (const name of Object.keys(STORAGE_PARAMETER_TYPES)) {
    if (!probed.has(name)) errors.push(`overlays/storage.ts: storage parameter ${name} was not accepted by any server`);
  }
  for (const name of probed) {
    if (!STORAGE_PARAMETER_TYPES[name]) errors.push(`overlays/storage.ts: storage parameter ${name} has no entry`);
  }
  const indexMethods = new Set(accessMethods.filter((a) => a.latest.type === "i").map((a) => a.name));
  for (const v of CONSTRAINTS.exclude!.args.find((a) => a.name === "using")?.values ?? []) {
    if (!indexMethods.has(v)) errors.push(`overlays/constraints.ts: exclusion method ${v} is not an index access method`);
  }
  for (const [file, table] of [
    ["constraints.ts", CONSTRAINTS],
    ["columns.ts", COLUMN_CLAUSES],
    ["partitioning.ts", PARTITIONING],
    ["indexes.ts", INDEX_CLAUSES],
    ["relations.ts", { ...RELATION_CLAUSES, ...VIEW_CLAUSES, ...SEQUENCE_CLAUSES }],
    ["type-ddl.ts", TYPE_DDL],
  ] as const) {
    checkClauses(file, table, majors, errors);
  }

  if (errors.length > 0) {
    throw new Error(
      `The Postgres overlays disagree with the catalogs at ${catalogs.map((c) => c.version).join(", ")}:\n  ${errors.join("\n  ")}\n` +
        "Update src/postgres/overlays/ for these pins.",
    );
  }

  // ── Ranges ─────────────────────────────────────────────────────────
  const ranges: Record<string, Record<string, VersionRange>> = {};
  const addRanges = (section: string, entries: ReadonlyArray<{ name: string; range: VersionRange }>) => {
    const out: Record<string, VersionRange> = {};
    for (const e of entries) if (bounded(e.range)) out[e.name] = e.range;
    ranges[section] = out;
  };
  addRanges("types", types);
  addRanges("accessMethods", accessMethods);
  addRanges("opclasses", opclasses);
  addRanges("functions", functions);
  addRanges("settings", settings);
  addRanges("extensions", extensions);
  addRanges("storageParameters", storage);
  for (const code of ["R", "T", "C", "U"]) {
    addRanges(`keywords${code}`, keywords.filter((k) => k.latest.code === code).map((k) => ({ name: k.latest.word, range: k.range })));
  }

  // Enum members that are not in every major a setting is in: `wal_compression` gains `lz4` in 15.
  const settingValues: Record<string, Record<string, VersionRange>> = {};
  for (const s of settings) {
    const members = union<string>(
      `setting ${s.name} value`,
      catalogs,
      (c) => c.settings.find((x) => x.name === s.name)?.enumvals ?? [],
      (v) => v,
      errors,
    );
    const own: Record<string, VersionRange> = {};
    for (const m of members) {
      // Relative to the majors that have the setting at all, not to all majors.
      const since = m.range.since !== undefined && m.range.since > (s.range.since ?? majors[0]!) ? m.range.since : undefined;
      const lastOfSetting = s.range.until ?? majors[majors.length - 1]!;
      const until = m.range.until !== undefined && m.range.until < lastOfSetting ? m.range.until : undefined;
      if (since !== undefined || until !== undefined) {
        own[m.name] = { ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) };
      }
    }
    if (Object.keys(own).length > 0) settingValues[s.name] = own;
  }
  if (errors.length > 0) throw new Error(`Postgres setting values: ${errors.join("; ")}`);

  const rangeLiteral = (r: VersionRange): string =>
    `{ ${[...(r.since !== undefined ? [`since: ${r.since}`] : []), ...(r.until !== undefined ? [`until: ${r.until}`] : [])].join(", ")} }`;
  const rangesTable = [
    `export const VERSION_RANGES = {`,
    ...Object.entries(ranges).flatMap(([section, entries]) =>
      Object.keys(entries).length === 0
        ? [`  ${section}: {},`]
        : [
            `  ${section}: {`,
            ...Object.entries(entries).map(([name, r]) => `    ${JSON.stringify(name)}: ${rangeLiteral(r)},`),
            `  },`,
          ],
    ),
    `  settingValues: {`,
    ...Object.entries(settingValues).flatMap(([name, members]) => [
      `    ${JSON.stringify(name)}: {`,
      ...Object.entries(members).map(([m, r]) => `      ${JSON.stringify(m)}: ${rangeLiteral(r)},`),
      `    },`,
    ]),
    `  },`,
    `} as const satisfies Record<string, Record<string, VersionRange | Record<string, VersionRange>>>;`,
  ];

  // ── Declarations ───────────────────────────────────────────────────
  const aliases = types.filter((t) => t.latest.sqlName !== t.latest.name).map((t) => [t.latest.name, t.latest.sqlName] as const);
  const keywordNames = (code: string) => keywords.filter((k) => k.latest.code === code).map((k) => k.latest.word);
  const byAm = new Map<string, string[]>();
  for (const o of opclasses) {
    const list = byAm.get(o.latest.am);
    if (list) list.push(o.latest.name);
    else byAm.set(o.latest.am, [o.latest.name]);
  }

  const settingLines: string[] = [];
  for (const s of settings) {
    const tags = [doc(s.latest.category), `@context ${s.latest.context}`];
    if (s.latest.unit) tags.push(`@unit ${s.latest.unit}`);
    if (s.latest.default !== null) tags.push(`@default ${doc(JSON.stringify(s.latest.default))}`);
    tags.push(...rangeTags(s.range));
    settingLines.push(`  /** ${tags.join(" | ")} */`, `  ${key(s.name)}?: ${settingTsType(s.rows)};`);
  }

  const storageTargets = sorted(storage.map((p) => p.latest.target));
  const storageInterfaces = storageTargets.flatMap((target) => [
    `export interface StorageParams_${identifier(target)} {`,
    ...storage
      .filter((p) => p.latest.target === target)
      .flatMap((p) => {
        const tags = rangeTags(p.range);
        return [
          ...(tags.length > 0 ? [`  /** ${tags.join(" | ")} */`] : []),
          `  ${key(p.latest.name)}?: ${storageTsType(STORAGE_PARAMETER_TYPES[p.latest.name]!)};`,
        ];
      }),
    "}",
    "",
  ]);

  const header = (what: string) => [
    `// Generated by \`npm run generate\` from the Postgres catalogs at ${catalogs.map((c) => c.version).join(", ")}`,
    `// (src/spec/postgres-catalog-<major>.snapshot.json) and the overlays in src/postgres/overlays/. Do not edit.`,
    `// ${what}`,
    "",
  ];

  const declarations = [
    ...header("The type surface: the union of every supported major, with a range on each name that is not in all of them."),
    `import type { VersionRange } from "../postgres/catalog-types";`,
    "",
    `/** The supported majors, oldest first. */`,
    `export const POSTGRES_MAJORS = ${JSON.stringify(majors)} as const;`,
    `export type PostgresMajor = (typeof POSTGRES_MAJORS)[number];`,
    `/** The exact release each major's catalog was read from. */`,
    `export const POSTGRES_VERSIONS = ${JSON.stringify(Object.fromEntries(catalogs.map((c, i) => [majors[i], c.version])))} as const;`,
    "",
    `export type TypeName = ${lit(types.map((t) => t.name))};`,
    `export type TypeSqlName = ${lit(sorted(types.map((t) => t.latest.sqlName)))};`,
    `export const TYPE_ALIASES = ${JSON.stringify(Object.fromEntries(aliases))} as const;`,
    "",
    `export type IndexAccessMethod = ${lit(accessMethods.filter((a) => a.latest.type === "i").map((a) => a.name))};`,
    `export type TableAccessMethod = ${lit(accessMethods.filter((a) => a.latest.type === "t").map((a) => a.name))};`,
    ...[...byAm].map(([am, names]) => `export type OpClass_${identifier(am)} = ${lit(names)};`),
    "",
    `export type ReservedKeyword = ${lit(keywordNames("R"))};`,
    `export type ReservedAsFunctionKeyword = ${lit(keywordNames("T"))};`,
    `export type ColumnNameKeyword = ${lit(keywordNames("C"))};`,
    `export type UnreservedKeyword = ${lit(keywordNames("U"))};`,
    "",
    `export type AggregateFunctionName = ${lit(functions.filter((f) => f.latest.kinds.includes("a")).map((f) => f.name))};`,
    `export type ScalarFunctionName = ${lit(functions.filter((f) => f.latest.kinds.includes("f")).map((f) => f.name))};`,
    `export type ExtensionName = ${lit(extensions.map((e) => e.name))};`,
    "",
    `/** Server settings, \`SET\` and \`postgresql.conf\` names, from \`pg_settings\`. */`,
    `export interface Settings {`,
    ...settingLines,
    `}`,
    "",
    ...storageInterfaces,
    `/** The names that are not in every supported major, with the major they arrived in and the last that has them. */`,
    ...rangesTable,
    "",
  ].join("\n");

  const settingTable = [
    `export const SETTINGS: Readonly<Record<keyof Settings, SettingSpec>> = {`,
    ...settings.map((s) => {
      const r = s.latest;
      const spec = {
        type: r.type,
        context: r.context,
        category: r.category,
        ...(r.unit ? { unit: r.unit } : {}),
        ...(r.default !== null ? { default: r.default } : {}),
        ...(r.min !== null ? { min: r.min } : {}),
        ...(r.max !== null ? { max: r.max } : {}),
      };
      return `  ${key(s.name)}: ${JSON.stringify(spec)},`;
    }),
    "};",
  ];

  const storageNames = sorted(storage.map((p) => p.latest.name));
  const storageTable = [
    `export const STORAGE_PARAMETERS: Readonly<Record<string, StorageParameterSpec>> = {`,
    ...storageNames.map((name) => {
      const targets = sorted(storage.filter((p) => p.latest.name === name).map((p) => p.latest.target));
      return `  ${key(name)}: ${JSON.stringify({ type: STORAGE_PARAMETER_TYPES[name], targets })},`;
    }),
    "};",
  ];

  const spellingsOf = new Map<string, string[]>();
  const spell = (canonical: string, alias: string) => spellingsOf.set(canonical, [...(spellingsOf.get(canonical) ?? []), alias]);
  for (const [a, canonical] of Object.entries(TYPE_SPELLINGS)) spell(canonical, a);
  for (const t of types) if (t.latest.sqlName !== t.latest.name) spell(t.latest.sqlName, t.latest.name);
  const canonicalTypes = new Map<string, TypeRow>();
  for (const t of types) canonicalTypes.set(t.latest.sqlName, t.latest);
  const typeTable = [
    `export const COLUMN_TYPES: Readonly<Record<TypeSqlName, ColumnTypeSpec>> = {`,
    ...[...canonicalTypes.keys()].sort(compare).map((name) => {
      const t = canonicalTypes.get(name)!;
      const spec = {
        ...(t.name !== name ? { catalogName: t.name } : {}),
        category: t.category,
        aliases: sorted(spellingsOf.get(name) ?? []),
        parameters: COLUMN_TYPE_PARAMETERS[name] ?? [],
      };
      return `  ${key(name)}: ${JSON.stringify(spec)},`;
    }),
    "};",
  ];

  // The parser's ColId rule and identifier quoting read the latest major's key words (#3279).
  const keywordTable = [
    `/** Every key word at the latest pinned major, by its \`pg_get_keywords()\` category: U unreserved, C column name, T type or function name, R reserved. */`,
    `export const KEYWORDS: Readonly<Record<string, "U" | "C" | "T" | "R">> = {`,
    ...keywords
      .filter((k) => k.range.until === undefined)
      .map((k) => k.latest)
      .sort((a, b) => compare(a.word, b.word))
      .map((k) => `  ${key(k.word)}: ${JSON.stringify(k.code)},`),
    "};",
  ];

  // Names lint checks a declaration against, each with the majors that have it
  // (`true`: every supported major). Read straight off the catalogs, internal
  // functions included: a column default may call `pg_current_xact_id()`.
  const presence = (lists: ReadonlyArray<readonly string[]>): Map<string, number[]> => {
    const out = new Map<string, number[]>();
    lists.forEach((names, i) => {
      for (const n of new Set(names)) out.set(n, [...(out.get(n) ?? []), majors[i]!]);
    });
    return out;
  };
  const majorsLiteral = (ms: readonly number[]): string => (ms.length === majors.length ? "true" : JSON.stringify(ms));
  const presenceTable = (m: Map<string, number[]>, indent: string): string[] =>
    sorted(m.keys()).map((n) => `${indent}${JSON.stringify(n)}: ${majorsLiteral(m.get(n)!)},`);
  const functionTable = [
    `/** Every function, aggregate and procedure name in \`pg_proc\`, to the majors that have it (\`true\`: all of them). */`,
    `export const FUNCTIONS: Readonly<Record<string, true | readonly number[]>> = {`,
    ...presenceTable(presence(catalogs.map((c) => c.functions.map((f) => f.name))), "  "),
    "};",
  ];
  const methodTable = [
    `/** The index access methods, to the majors that have each (\`true\`: all of them). */`,
    `export const INDEX_ACCESS_METHODS: Readonly<Record<string, true | readonly number[]>> = {`,
    ...presenceTable(presence(catalogs.map((c) => c.accessMethods.filter((a) => a.type === "i").map((a) => a.name))), "  "),
    "};",
  ];
  const opclassAms = sorted(catalogs.flatMap((c) => c.opclasses.map((o) => o.am)));
  const opclassTable = [
    `/** The operator classes of each index access method, to the majors that have each (\`true\`: all of them). */`,
    `export const OPERATOR_CLASSES: Readonly<Record<string, Readonly<Record<string, true | readonly number[]>>>> = {`,
    ...opclassAms.flatMap((am) => [
      `  ${key(am)}: {`,
      ...presenceTable(presence(catalogs.map((c) => c.opclasses.filter((o) => o.am === am).map((o) => o.name))), "    "),
      "  },",
    ]),
    "};",
  ];

  const tables = [
    ...header("The tables lint and the LSP read, typed by ./postgres-types."),
    `import type { ColumnTypeSpec, SettingSpec, StorageParameterSpec } from "../postgres/catalog-types";`,
    `import type { Settings, TypeSqlName } from "./postgres-types";`,
    "",
    `export * from "./postgres-types";`,
    "",
    ...settingTable,
    "",
    ...storageTable,
    "",
    ...typeTable,
    "",
    ...keywordTable,
    "",
    ...functionTable,
    "",
    ...methodTable,
    "",
    ...opclassTable,
    "",
  ].join("\n");

  notes.push(
    `postgres: ${types.length} types, ${functions.length} functions, ${settings.length} settings, ${storage.length} storage parameters across ${catalogs.length} majors`,
  );
  return { declarations, tables, notes };
}
