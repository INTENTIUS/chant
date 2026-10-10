/**
 * The `.sql` files in a project's source directory, read into declarations
 * at build time (the plugin's `buildRoots` hook): each file's objects join
 * the tagged templates' as if an import had written them, with the
 * references between the two as interpolations (`../sql-files.ts`).
 *
 * The files are found by the walk source discovery uses, so `dist`,
 * git-ignored paths, child projects and the project's `exclude` globs are
 * left out. A file whose first lines carry `-- chant-discovery-skip` (or the
 * `/* chant-discovery-skip *\/` form) is not read, for SQL that is not schema:
 * seed data, a migration, a query.
 *
 * The dialect is the declarations': a project whose templates are Postgres
 * reads its files as Postgres. With no templates it is `sql.dialect`, and
 * ClickHouse when that is unset, as for the rest of the lexicon.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Declarable } from "@intentius/chant/declarable";
import type { BuildRootContext, BuildRootContribution } from "@intentius/chant/lexicon";
import { findSourceFiles, hasDiscoveryMarkerSync } from "@intentius/chant/discovery/files";
import { readHead } from "@intentius/chant/discovery/walk";
import { SQL_DIALECTS, type SqlDialect } from "../dialects";
import { isPostgresObject } from "../postgres/entities";
import { isClickHouseObject } from "../clickhouse/entities";
import { sqlFileEntities } from "../sql-files";

/** `-- chant-discovery-skip` on a line of its own, near the top. */
const SQL_SKIP_MARKER = /^[ \t]*--[ \t]*chant-discovery-skip(?![\w-])/m;

/** Whether a file is a `.sql` file to read: the name, and no skip or generated marker. */
export function isSqlSourceFile(name: string, full: string): boolean {
  if (!name.endsWith(".sql")) return false;
  if (hasDiscoveryMarkerSync(full)) return false;
  return !SQL_SKIP_MARKER.test(readHead(full, 1024));
}

/** The dialect the project's `.sql` files are read as. */
export function filesDialect(entities: ReadonlyMap<string, Declarable> | undefined, config: Record<string, unknown>): SqlDialect {
  for (const e of entities?.values() ?? []) {
    if (isPostgresObject(e)) return "postgres";
    if (isClickHouseObject(e)) return "clickhouse";
  }
  const dialect = (config.sql as { dialect?: unknown } | undefined)?.dialect;
  if (typeof dialect === "string" && (SQL_DIALECTS as readonly string[]).includes(dialect)) return dialect as SqlDialect;
  if (Array.isArray(dialect)) {
    if (dialect.length === 1 && (SQL_DIALECTS as readonly string[]).includes(String(dialect[0]))) return dialect[0] as SqlDialect;
    throw new Error(`sql: the project's .sql files hold no declaration that says their dialect, and sql.dialect lists ${dialect.join(", ")}; set sql.dialect to one, or declare one object with a tagged template`);
  }
  return "clickhouse";
}

/** The `buildRoots` contribution: every `.sql` file's declarations, or nothing when the source directory holds none. */
export async function sqlFilesBuildRoot(ctx: BuildRootContext): Promise<BuildRootContribution> {
  const sourceDir = ctx.sourceDir ?? resolve(ctx.projectRoot, typeof ctx.config.sourceDir === "string" ? ctx.config.sourceDir : ".");
  const files = (await findSourceFiles(sourceDir, isSqlSourceFile)).sort();
  if (files.length === 0) return { entities: new Map() };
  const dialect = filesDialect(ctx.entities, ctx.config);
  const sources = files.map((f) => ({ origin: relative(ctx.projectRoot, f) || f, ddl: readFileSync(f, "utf8") }));
  return { entities: sqlFileEntities(dialect, sources, { known: ctx.entities ?? new Map() }) };
}
