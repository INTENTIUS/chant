/**
 * The readers for goose, golang-migrate and clickhouse-migrations
 * directories (#4400). Each lists the migrations in the order the tool
 * applies them. None runs the tool or a server: the schema the migrations
 * produce comes from a replay.
 *
 * File layouts, checked against the tools' own docs and source:
 *
 * - goose (pressly/goose 9a201bb): `<version>_<name>.sql` directly in the
 *   directory, the version a positive integer before the first `_`
 *   (`NumericComponent`, migration.go); ordered by that number, so a
 *   sequential `00001` and a timestamp `20240101120000` sort together.
 *   A file holds `-- +goose Up` and, optionally, a later `-- +goose Down`
 *   (internal/sqlparser/parser.go); `-- +goose NO TRANSACTION` runs it
 *   outside a transaction. `.go` migrations are listed in the version order
 *   but are code, so each is a gap.
 * - golang-migrate (golang-migrate/migrate 504568a): `<version>_<name>.up.<ext>`
 *   and `.down.<ext>` directly in the directory, matched by
 *   `^([0-9]+)_(.*)\.(down|up)\.(.*)$` (source/parse.go); ordered by the
 *   version, a 64-bit unsigned integer. The up files are the migrations; a
 *   version with a down file and no up file, or two files for one version
 *   and direction, is a gap.
 * - clickhouse-migrations, the Python tool (zifter/clickhouse-migrations) and
 *   the Node tool (npm clickhouse-migrations): `<version>_<name>.sql` directly
 *   in the migrations directory, the version an integer before the first `_`,
 *   applied in ascending numeric order. The Python tool also reads an
 *   optional `<version>_<name>.down.sql` rollback beside it. The dialect is
 *   always ClickHouse.
 *
 * The member's `migrationsDir` field names the directory under the member's
 * own, and `dialect` names the dialect for goose and golang-migrate, whose
 * tools take it from a driver or URL the directory does not hold.
 */

import type { KindLinkRead, KindReadGap, KindReadMigration, KindReaderInput } from "./kind-link-readers";
import type { FieldValue } from "./kinds";
import { joinPath, type WorkspaceTree } from "./tree";

/** The dialects a migration directory's `dialect` field names. */
export const MIGRATION_DIALECTS = ["postgres", "clickhouse"] as const;

export function fieldString(fields: KindReaderInput["fields"], name: string, fallback: string): string {
  const v = fields?.[name] as FieldValue | null | undefined;
  return typeof v === "string" && v !== "" ? v : fallback;
}

/** The directory a reader lists: the member's `migrationsDir` under its own directory. */
export function migrationsDirOf(input: KindReaderInput): string {
  const sub = fieldString(input.fields, "migrationsDir", ".");
  return joinPath(input.dir, sub.replace(/^\.\/?/, ""));
}

function filesIn(tree: WorkspaceTree, dir: string): string[] {
  return (tree.list(dir) ?? []).filter((e) => e.type === "file").map((e) => e.name).sort();
}

const lineOf = (text: string, pred: (line: string) => boolean): number => {
  const i = text.split(/\r?\n/).findIndex(pred);
  return i < 0 ? 0 : i + 1;
};

/** The goose annotation on `line` (`up`, `down`, `no transaction`, ...), or undefined when it holds none. Mirrors the parser's rule: a comment that contains `+goose`. */
export function gooseAnnotation(line: string): string | undefined {
  const t = line.trim();
  if (!t.startsWith("--") || !t.includes("+goose")) return undefined;
  return t.replace("+goose", "").replace(/^--\s*/, "").trim().toLowerCase();
}

export function readGooseDir(input: KindReaderInput): KindLinkRead {
  const { tree } = input;
  const dir = migrationsDirOf(input);
  const dialect = fieldString(input.fields, "dialect", "postgres");
  const gaps: KindReadGap[] = [];
  const result: KindLinkRead = { reader: "goose-dir", links: [], gaps, migrations: [] };
  const found: { n: number; migration: KindReadMigration | null; file: string }[] = [];
  for (const name of filesIn(tree, dir)) {
    const ext = name.endsWith(".sql") ? ".sql" : name.endsWith(".go") && !name.endsWith("_test.go") ? ".go" : null;
    if (!ext) continue;
    const file = joinPath(dir, name);
    const before = name.split("_")[0] ?? "";
    const n = /^[0-9]+$/.test(before) && name.includes("_") ? Number(before) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) {
      gaps.push({ file, line: 1, message: `${name} has no version goose can read: the name starts with a positive integer, then _, so goose would stop here` });
      continue;
    }
    if (ext === ".go") {
      gaps.push({ file, line: 1, message: `${name} is a Go migration; its code is not SQL, so it is not listed` });
      found.push({ n, migration: null, file });
      continue;
    }
    const text = tree.read(file);
    const up = lineOf(text, (l) => gooseAnnotation(l) === "up");
    if (up === 0) {
      gaps.push({ file, line: 1, message: `${name} has no -- +goose Up annotation, so goose refuses it` });
      continue;
    }
    const down = lineOf(text, (l) => gooseAnnotation(l) === "down");
    if (down !== 0 && down < up) gaps.push({ file, line: down, message: `${name}: -- +goose Down comes before -- +goose Up, which goose refuses` });
    found.push({
      n,
      file,
      migration: {
        position: 0,
        version: String(n),
        name: name.slice(before.length + 1, -ext.length),
        type: "versioned",
        file,
        line: up,
        down: down !== 0,
        dialect,
        transaction: !text.split(/\r?\n/).some((l) => gooseAnnotation(l) === "no transaction"),
      },
    });
  }
  found.sort((a, b) => a.n - b.n || (a.file < b.file ? -1 : 1));
  const seen = new Map<number, string>();
  for (const f of found) {
    const prior = seen.get(f.n);
    if (prior) gaps.push({ file: f.file, line: 1, message: `version ${String(f.n)} is also ${prior}; goose refuses a duplicate version` });
    else seen.set(f.n, f.file);
  }
  for (const f of found) if (f.migration) result.migrations!.push(f.migration);
  result.migrations!.forEach((m, i) => (m.position = i + 1));
  return result;
}

const MIGRATE_NAME = /^([0-9]+)_(.*)\.(down|up)\.(.*)$/;

export function readGolangMigrateDir(input: KindReaderInput): KindLinkRead {
  const { tree } = input;
  const dir = migrationsDirOf(input);
  const dialect = fieldString(input.fields, "dialect", "postgres");
  const gaps: KindReadGap[] = [];
  const result: KindLinkRead = { reader: "golang-migrate-dir", links: [], gaps, migrations: [] };
  const ups = new Map<bigint, { name: string; file: string; version: string }>();
  const downs = new Map<bigint, string>();
  for (const name of filesIn(tree, dir)) {
    const m = MIGRATE_NAME.exec(name);
    if (!m) continue;
    const version = BigInt(m[1]!);
    const file = joinPath(dir, name);
    if (version > 18446744073709551615n) {
      gaps.push({ file, line: 1, message: `${name}: the version does not fit a 64-bit unsigned integer, which golang-migrate requires` });
      continue;
    }
    const table = m[3] === "up" ? ups : downs;
    if (table.has(version)) {
      gaps.push({ file, line: 1, message: `${name}: another ${m[3]!} file already has version ${m[1]!}; golang-migrate refuses a duplicate` });
      continue;
    }
    if (m[3] === "up") ups.set(version, { name: m[2]!, file, version: m[1]! });
    else downs.set(version, file);
  }
  for (const [v, file] of downs) if (!ups.has(v)) gaps.push({ file, line: 1, message: `version ${String(v)} has a down file and no up file` });
  [...ups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .forEach(([v, u], i) => result.migrations!.push({ position: i + 1, version: u.version, name: u.name, type: "versioned", file: u.file, line: 1, down: downs.get(v) ?? false, dialect }));
  return result;
}

const CLICKHOUSE_NAME = /^([0-9]+)_(.+)\.sql$/;

export function readClickHouseMigrationsDir(input: KindReaderInput): KindLinkRead {
  const { tree } = input;
  const dir = migrationsDirOf(input);
  const gaps: KindReadGap[] = [];
  const result: KindLinkRead = { reader: "clickhouse-migrations-dir", links: [], gaps, migrations: [] };
  const names = filesIn(tree, dir).filter((n) => n.endsWith(".sql"));
  const rollbacks = new Map(names.filter((n) => n.endsWith(".down.sql")).map((n) => [n.slice(0, -".down.sql".length), joinPath(dir, n)]));
  const ups: { n: bigint; version: string; name: string; file: string }[] = [];
  for (const name of names) {
    if (name.endsWith(".down.sql")) continue;
    const m = CLICKHOUSE_NAME.exec(name);
    if (!m) {
      gaps.push({ file: joinPath(dir, name), line: 1, message: `${name} has no version before its first _, so clickhouse-migrations reports a bad file name` });
      continue;
    }
    ups.push({ n: BigInt(m[1]!), version: m[1]!, name: m[2]!, file: joinPath(dir, name) });
  }
  ups.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : a.file < b.file ? -1 : 1));
  const seen = new Map<bigint, string>();
  for (const u of ups) {
    const prior = seen.get(u.n);
    if (prior) gaps.push({ file: u.file, line: 1, message: `version ${u.version} is also ${prior}; leading zeros are not significant, so clickhouse-migrations reports a duplicate version` });
    else seen.set(u.n, u.file);
  }
  ups.forEach((u, i) => result.migrations!.push({ position: i + 1, version: u.version, name: u.name, type: "versioned", file: u.file, line: 1, down: rollbacks.get(u.file.split("/").pop()!.slice(0, -".sql".length)) ?? false, dialect: "clickhouse" }));
  return result;
}
