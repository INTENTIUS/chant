/**
 * The `flyway-dir` reader (#4400): the migrations of a Flyway project, in the
 * order `flyway migrate` applies them. It reads the layout with
 * `./flyway-layout.ts`, the reading `yodel check` shares, and never runs
 * Flyway or substitutes placeholders (a replay does that).
 *
 * File names follow Flyway's migration naming
 * (https://documentation.red-gate.com/fd/migrations-271585107.html):
 *
 * - versioned `V<version>__<description>.sql`, the version digits joined by
 *   `.` or `_`;
 * - repeatable `R__<description>.sql`, run after every versioned migration,
 *   in the order of their descriptions;
 * - baseline `B<version>__<description>.sql`, listed with the versioned ones;
 * - undo `U<version>__<description>.sql`, which is the `down` file of the
 *   versioned migration with that version and is not listed on its own.
 *
 * The prefixes, the separator and the suffixes come from the configuration.
 * Versions compare part by part as numbers, so `V2` comes before `V10` and
 * `V1.1` before `V1.2`. Callbacks are not migrations, and a Java or Kotlin
 * migration is a gap: its code is not SQL.
 */

import type { KindLinkRead, KindReadGap, KindReadMigration, KindReaderInput } from "./kind-link-readers";
import { codeMigrations, findFlywayConfig, isCallback, readFlywayConfig, walk, type FlywayConfig } from "./flyway-layout";
import { fieldString } from "./migration-dirs";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compare dotted versions part by part as numbers; a missing part is 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[._]/).map(BigInt);
  const pb = b.split(/[._]/).map(BigInt);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0n;
    const y = pb[i] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface FlywayFile {
  type: KindReadMigration["type"];
  /** The version written with `.` between its parts; empty for a repeatable migration. */
  version: string;
  description: string;
  file: string;
}

/** The file's migration role under `config`'s naming, or undefined when its name is not a migration's. */
export function classifyFlywayFile(file: string, config: FlywayConfig): FlywayFile | undefined {
  const name = file.split("/").pop() ?? file;
  if (isCallback(name)) return undefined;
  const suffix = config.sqlMigrationSuffixes.find((s) => name.endsWith(s));
  if (!suffix) return undefined;
  const stem = name.slice(0, -suffix.length);
  const sep = escape(config.sqlMigrationSeparator);
  const repeatable = new RegExp(`^${escape(config.repeatableSqlMigrationPrefix)}${sep}(.+)$`).exec(stem);
  if (repeatable) return { type: "repeatable", version: "", description: repeatable[1]!.replace(/_/g, " "), file };
  const roles: [KindReadMigration["type"], string][] = [
    ["versioned", config.sqlMigrationPrefix],
    ["baseline", config.baselineMigrationPrefix],
    ["undo", config.undoSqlMigrationPrefix],
  ];
  for (const [type, prefix] of roles) {
    if (!prefix) continue;
    const m = new RegExp(`^${escape(prefix)}([0-9]+(?:[._][0-9]+)*)${sep}(.+)$`).exec(stem);
    if (m) return { type, version: m[1]!.replace(/_/g, "."), description: m[2]!.replace(/_/g, " "), file };
  }
  return undefined;
}

export function readFlywayDir(input: KindReaderInput): KindLinkRead {
  const { tree, dir } = input;
  const gaps: KindReadGap[] = [];
  const result: KindLinkRead = { reader: "flyway-dir", links: [], gaps, migrations: [] };
  const configFile = findFlywayConfig(tree, dir);
  let config: FlywayConfig;
  try {
    config = readFlywayConfig(tree, configFile, dir);
  } catch (err) {
    gaps.push({ file: configFile ?? dir, line: 1, message: `the Flyway configuration could not be read (${(err as Error).message}), so no migration was listed` });
    return result;
  }
  const dialect = fieldString(input.fields, "dialect", config.dialect ?? "postgres");
  for (const l of config.outside) gaps.push({ file: configFile ?? dir, line: 1, message: `the location ${l} lies outside the workspace, so its migrations were not listed` });

  const files = [...new Set(config.locations.flatMap((d) => walk(tree, d)))];
  const classified = files.map((f) => classifyFlywayFile(f, config)).filter((f): f is FlywayFile => f !== undefined);
  for (const code of codeMigrations(tree, config)) gaps.push({ file: code, line: 1, message: `${code.split("/").pop()!} is a code migration; its code is not SQL, so it is not listed` });

  const undo = new Map(classified.filter((f) => f.type === "undo").map((f) => [f.version, f.file]));
  const ordered = classified.filter((f) => f.type === "versioned" || f.type === "baseline").sort((a, b) => compareVersions(a.version, b.version) || (a.type === "baseline" ? -1 : 1) || (a.file < b.file ? -1 : 1));
  const repeatable = classified.filter((f) => f.type === "repeatable").sort((a, b) => (a.description < b.description ? -1 : a.description > b.description ? 1 : a.file < b.file ? -1 : 1));
  const seen = new Map<string, string>();
  for (const f of ordered.filter((x) => x.type === "versioned")) {
    const prior = [...seen.keys()].find((v) => compareVersions(v, f.version) === 0);
    if (prior !== undefined) gaps.push({ file: f.file, line: 1, message: `version ${f.version} is also ${seen.get(prior)!}; Flyway refuses two migrations with one version` });
    else seen.set(f.version, f.file);
  }
  [...ordered, ...repeatable].forEach((f, i) =>
    result.migrations!.push({ position: i + 1, version: f.version, name: f.description, type: f.type, file: f.file, line: 1, down: f.type === "versioned" ? (undo.get(f.version) ?? false) : false, dialect }),
  );
  return result;
}
