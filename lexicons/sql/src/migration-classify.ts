/**
 * Classify the migration files a pull request adds (#4407), the lexicon's
 * answer to core's `classifyMigrations` hook. The "check" adoption level:
 * each new file's up statements are read and given the class the schema-diff
 * classifier gives the same change, and nothing else happens. No server is
 * contacted, no migration tool runs and nothing is applied, so it needs no
 * environment binding (compare `chant sql replay`, which does).
 *
 * The up statements are the ones replay would run: goose's `-- +goose Up`
 * section, the whole file for golang-migrate and clickhouse-migrations, and a
 * Flyway file after placeholder substitution with the configuration's values.
 */

import type { MigrationFileClassification } from "@intentius/chant/pr-migrations";
import { findFlywayConfig, readFlywayConfig, substitute } from "@intentius/chant/workspace/flyway-layout";
import type { WorkspaceTree } from "@intentius/chant/workspace/tree";
import { classifyClickHouseStatements } from "./clickhouse/plan/statements";
import { gooseUpStatements, splitStatements } from "./migration-replay";
import { classifyPgStatements } from "./postgres/plan/statements";

export const MIGRATION_DIALECTS = ["postgres", "clickhouse"] as const;

/** The reader names whose files this lexicon reads. */
const READERS = new Set(["goose-dir", "golang-migrate-dir", "clickhouse-migrations-dir", "flyway-dir"]);

export function classifyMigrationFiles(options: { reader: string; dialect: string; tree: WorkspaceTree; dir: string; files: string[] }): MigrationFileClassification[] {
  const { reader, dialect, tree, dir, files } = options;
  if (!READERS.has(reader) || !(MIGRATION_DIALECTS as readonly string[]).includes(dialect)) return [];
  const classify = dialect === "postgres" ? classifyPgStatements : classifyClickHouseStatements;
  let flyway: ReturnType<typeof readFlywayConfig> | undefined;
  return files.map((file) => {
    try {
      const text = tree.read(file);
      let statements: string[];
      if (reader === "goose-dir") statements = gooseUpStatements(text);
      else if (reader === "flyway-dir") {
        flyway ??= readFlywayConfig(tree, findFlywayConfig(tree, dir), dir);
        statements = splitStatements(substitute(text, file, flyway));
      } else statements = splitStatements(text);
      return { file, statements: classify(statements) };
    } catch (err) {
      return { file, statements: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
}
