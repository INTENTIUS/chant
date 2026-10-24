/**
 * Coverage, two ways.
 *
 * Which kinds of object each dialect declares (#3911): every `CREATE` command
 * a pinned server has (`./coverage/<dialect>-commands.json`, written by
 * `scripts/sql-create-commands.ts` from the server's own sources) has a row
 * in `./coverage/<dialect>.json` marking it declared, referenced, refused
 * with a reason, or out of scope. A referenced kind (a ClickHouse named
 * collection, #4395) is never declared: a declaration names one, a plan
 * checks it exists, and import lists the server's as prerequisites. A command with several forms that differ in what chant can
 * hold (`CREATE TYPE ... AS ENUM` and `CREATE TYPE ... AS RANGE`) has a row
 * per form. Import refuses an object of a refused kind by that row's `kind`
 * (`./core/undeclarable.ts`), and the docs page is rendered from the rows
 * (`./codegen/coverage-page.ts`). To declare a kind, flip its row to
 * `declared` with the `entity` that holds it, and drop the reason.
 *
 * How much of the pinned ClickHouse catalog the dialect types beyond its name.
 *
 * Every engine, type family, codec, skip index type and setting at the pin is
 * generated as a name, so name coverage is total by construction. What varies
 * is how far the overlays go: an engine whose arguments have kinds can be
 * checked, one whose arguments are `unknown` can only be named. This reports
 * that, per section, from the generated tables.
 */

import { CODECS, SKIP_INDEX_TYPES, TABLE_ENGINES, CLICKHOUSE_VERSION } from "./generated/clickhouse";
import { POSTGRES_PINS } from "./spec/postgres-pin";
import type { SqlDialect } from "./dialects";
import postgresKinds from "./coverage/postgres.json" with { type: "json" };
import clickhouseKinds from "./coverage/clickhouse.json" with { type: "json" };
import postgresCommands from "./coverage/postgres-commands.json" with { type: "json" };
import clickhouseCommands from "./coverage/clickhouse-commands.json" with { type: "json" };

// ── Object kinds ───────────────────────────────────────────────────────

/**
 * `declared`: a tag holds it. `referenced`: the environment's, never declared
 * and its values never read; a declaration names it, a plan checks it exists,
 * and import lists the server's as prerequisites (#4395). `refused`: import
 * names it and stops. `out-of-scope`: the environment's, never imported.
 */
export type KindStatus = "declared" | "referenced" | "refused" | "out-of-scope";

/** Every status a coverage row may have. */
export const KIND_STATUSES: readonly KindStatus[] = ["declared", "referenced", "refused", "out-of-scope"];

/** One row of a dialect's coverage table: a `CREATE` command, or one form of it. */
export interface KindRow {
  /** The command as the server's reference names it: `CREATE TYPE`. */
  command: string;
  /** The form of the command the row is about, when the command has forms chant treats apart: `AS RANGE`. */
  form?: string;
  /**
   * How a statement of the command is told to be this form: a regular
   * expression, case-insensitive, over the statement with its comments and
   * string literals taken out. The command's row without one is the rest.
   */
  match?: string;
  /** The object kind, unique in the dialect, as messages name it: `range type`. */
  kind: string;
  status: KindStatus;
  /** The entity type that declares it, when declared. */
  entity?: string;
  /** Why it is referenced, refused or out of scope. */
  reason?: string;
  /** Anything else a reader should know. */
  note?: string;
}

/** Each dialect's coverage table. */
export const KIND_COVERAGE: Record<SqlDialect, readonly KindRow[]> = {
  postgres: postgresKinds.kinds as KindRow[],
  clickhouse: clickhouseKinds.kinds as KindRow[],
};

/** The `CREATE` commands each pinned server has: per Postgres major, and the pinned ClickHouse release. */
export const PINNED_COMMANDS: Record<SqlDialect, ReadonlyArray<{ version: string; commands: readonly string[] }>> = {
  postgres: Object.values(postgresCommands.majors),
  clickhouse: [{ version: clickhouseCommands.version, commands: clickhouseCommands.commands }],
};

/** A dialect's row for `kind`; throws for a kind the table does not have, so a probe cannot name one that is not there. */
export function kindRow(dialect: SqlDialect, kind: string): KindRow {
  const row = KIND_COVERAGE[dialect].find((r) => r.kind === kind);
  if (!row) throw new Error(`no ${dialect} coverage row for the kind "${kind}" (src/coverage/${dialect}.json)`);
  return row;
}

/**
 * What is wrong with a dialect's coverage table, against its pinned servers'
 * commands: a command a pinned server has and no row covers, a row for a
 * command no pinned server has, a kind named twice, a declared row with no
 * entity, a referenced, refused or out-of-scope row with no reason. Empty
 * when complete.
 */
export function kindCoverageProblems(dialect: SqlDialect, opts: { pins?: ReadonlyArray<{ version: string; commands: readonly string[] }>; rows?: readonly KindRow[] } = {}): string[] {
  const rows = opts.rows ?? KIND_COVERAGE[dialect];
  const pins = opts.pins ?? PINNED_COMMANDS[dialect];
  const problems: string[] = [];
  const covered = new Set(rows.map((r) => r.command));
  const listed = new Set(pins.flatMap((p) => p.commands));
  for (const p of pins) {
    for (const c of p.commands) if (!covered.has(c)) problems.push(`${dialect} ${p.version} has ${c}, and no row in src/coverage/${dialect}.json covers it`);
  }
  for (const c of covered) if (!listed.has(c)) problems.push(`src/coverage/${dialect}.json has a row for ${c}, which no pinned ${dialect} server has`);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.kind)) problems.push(`the kind "${r.kind}" has two rows`);
    seen.add(r.kind);
    if (!KIND_STATUSES.includes(r.status)) problems.push(`${r.kind}: status "${r.status}" is not ${KIND_STATUSES.slice(0, -1).join(", ")} or ${KIND_STATUSES.at(-1)}`);
    if (r.status === "declared" && !r.entity) problems.push(`${r.kind} is declared, and names no entity type`);
    if (r.status !== "declared" && !r.reason) problems.push(`${r.kind} is ${r.status}, and gives no reason`);
  }
  return problems;
}

/** A statement's words, upper case, with comments and string literals (quoted and dollar-quoted) taken out. */
function bareStatement(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, " '' ")
    .replace(/'(?:[^'\\]|''|\\.)*'/g, " '' ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Words a `CREATE` can carry before the command's own: `CREATE OR REPLACE TRUSTED PROCEDURAL LANGUAGE`, `CREATE DEFAULT CONVERSION`. */
const MODIFIERS = new Set(["OR", "REPLACE", "TRUSTED", "PROCEDURAL", "DEFAULT", "UNIQUE", "UNLOGGED", "RECURSIVE", "CONSTRAINT", "GLOBAL", "LOCAL", "TEMP", "TEMPORARY"]);

/**
 * The coverage row a `CREATE` statement is of, by its command (the longest
 * that its words start with) and, among the command's forms, the first whose
 * `match` it matches; undefined for a statement no row covers.
 */
export function statementKind(dialect: SqlDialect, sql: string): KindRow | undefined {
  const bare = bareStatement(sql);
  const words = bare.split(/[\s(]+/);
  if (words[0] !== "CREATE") return undefined;
  const rest = words.slice(1).filter((w, i, all) => !MODIFIERS.has(w) || all.slice(0, i).some((x) => !MODIFIERS.has(x)));
  const rows = KIND_COVERAGE[dialect];
  let command: string | undefined;
  for (const r of rows) {
    const cmd = r.command.split(" ").slice(1);
    if (cmd.every((w, i) => rest[i] === w) && (!command || cmd.length > command.split(" ").length - 1)) command = r.command;
  }
  if (!command) return undefined;
  const forms = rows.filter((r) => r.command === command);
  return forms.find((r) => r.match !== undefined && new RegExp(r.match, "i").test(bare)) ?? forms.find((r) => r.match === undefined);
}

/** Whether the commands file was written for the pinned servers: a list for each pinned version, and for no other. */
export function pinnedCommandsCurrent(dialect: SqlDialect): string[] {
  const have = PINNED_COMMANDS[dialect].map((p) => p.version);
  const want = dialect === "postgres" ? POSTGRES_PINS.map((p) => p.version) : [CLICKHOUSE_VERSION];
  const run = `run npx tsx scripts/sql-create-commands.ts ${dialect}`;
  return [
    ...want.filter((v) => !have.includes(v)).map((v) => `${dialect} ${v} is pinned, and src/coverage/${dialect}-commands.json has no command list for it: ${run}`),
    ...have.filter((v) => !want.includes(v)).map((v) => `src/coverage/${dialect}-commands.json lists ${dialect} ${v}, which is no longer pinned: ${run}`),
  ];
}

// ── ClickHouse argument typing ─────────────────────────────────────────

export interface CoverageSection {
  section: string;
  total: number;
  typed: number;
  untyped: string[];
}

export interface CoverageReport {
  version: string;
  sections: CoverageSection[];
}

export function analyze(): CoverageReport {
  const engines = Object.entries(TABLE_ENGINES).filter(([, e]) => e.args !== undefined);
  const mergeTree = engines.filter(([, e]) => e.mergeTree);
  const codecs = Object.entries(CODECS).filter(([, c]) => c.role !== "internal");
  const indexes = Object.entries(SKIP_INDEX_TYPES);

  const section = (name: string, rows: Array<[string, boolean]>): CoverageSection => ({
    section: name,
    total: rows.length,
    typed: rows.filter(([, ok]) => ok).length,
    untyped: rows.filter(([, ok]) => !ok).map(([n]) => n),
  });

  return {
    version: CLICKHOUSE_VERSION,
    sections: [
      section("MergeTree engine arguments", mergeTree.map(([n, e]) => [n, e.typed])),
      section("all engine arguments", engines.map(([n, e]) => [n, e.typed])),
      section("codec parameters", codecs.map(([n, c]) => [n, c.parameters !== "unknown"])),
      section(
        "skip index parameters",
        indexes.map(([n, i]) => [n, (i.args ?? []).every((a) => a.kind !== "unknown")]),
      ),
    ],
  };
}

export function printCoverage(report: CoverageReport, opts: { verbose?: boolean; minOverall?: number } = {}): void {
  console.error(`ClickHouse ${report.version}`);
  for (const s of report.sections) {
    const pct = s.total === 0 ? 100 : Math.round((s.typed / s.total) * 100);
    console.error(`  ${s.section}: ${s.typed}/${s.total} typed (${pct}%)`);
    if (opts.verbose && s.untyped.length > 0) console.error(`    untyped: ${s.untyped.join(", ")}`);
  }
  if (opts.minOverall !== undefined) {
    const mergeTree = report.sections[0]!;
    const pct = mergeTree.total === 0 ? 100 : (mergeTree.typed / mergeTree.total) * 100;
    if (pct < opts.minOverall) throw new Error(`MergeTree argument coverage ${pct.toFixed(0)}% is below ${opts.minOverall}%`);
  }
}
