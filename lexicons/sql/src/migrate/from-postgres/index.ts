/**
 * `chant migrate --from sql/postgres --to sql/clickhouse <file or member>`
 * (#4399): the Postgres tables a CDC pipeline mirrors, as the ClickHouse
 * tables that receive them.
 *
 * ## Naming
 *
 * A `chant migrate` side names a lexicon, and the sql lexicon holds two
 * dialects whose builds never mix, so a side is `<lexicon>/<dialect>`:
 * `sql/postgres` and `sql/clickhouse`. `--to sql/clickhouse` loads the sql
 * lexicon and asks it for `migrationSource("sql/postgres", "sql/clickhouse")`.
 * The same shape would name a later pair (`sql/clickhouse` to `sql/postgres`)
 * without a new flag. A side with no slash is a lexicon alone, as for
 * `--from github --to gitlab`.
 *
 * ## The source
 *
 * - a `.sql` file of Postgres DDL;
 * - a TypeScript file or a member directory of `table` declarations, read by
 *   a folded build of the project it belongs to (`chant sql types` reads the
 *   same way), so `${shop}.customers` and other interpolations resolve.
 *
 * ## What it writes
 *
 * `--emit ts` (the default here) writes declarations: `table` templates, or
 * `CdcMirror` calls with `--use-composites`. `--emit sql` writes the DDL.
 * Every decision that is not the type map is a finding from the shared
 * catalog (`../../clickhouse/review-catalog.ts`), reported as SARIF with
 * `--report`, and a `warning` fails the run under `--strict`.
 *
 * `links` names the Postgres output each mirrored column reads
 * (`shop.customers.email`). In a workspace, `chant migrate` writes them as
 * `links` of the ClickHouse member (`../../../../packages/core/src/workspace/migrate-links.ts`),
 * so `chant workspace check` fails when the Postgres declaration drops or
 * renames one.
 *
 * `--validate` creates the emitted DDL on a throwaway server of the pinned
 * ClickHouse image (`../../sqlserver/validate.ts` runs it).
 */

import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Declarable } from "@intentius/chant/declarable";
import type { MigrateOptions, MigrationResult, MigrationSource } from "@intentius/chant/lexicon";
import { looksLikePostgres } from "./detect";
import { emitSql, emitTs, mirrorObjects } from "./emit";
import { translatePostgres, type Translation } from "./translate";

export const FROM_POSTGRES = "sql/postgres";
export const TO_CLICKHOUSE = "sql/clickhouse";

/** Whether `from` and `to` name this pair. */
export const isPostgresToClickHouse = (from: string, to?: string): boolean => from === FROM_POSTGRES && (to === undefined || to === TO_CLICKHOUSE);

/** The Postgres declarations at `sourceFile`: a `.sql` file read as DDL, else a folded build of its project. */
export async function loadPostgresEntities(content: string, sourceFile: string | undefined): Promise<Map<string, Declarable>> {
  const isDir = sourceFile !== undefined && existsSync(sourceFile) && statSync(sourceFile).isDirectory();
  if (!isDir && (sourceFile === undefined || sourceFile.endsWith(".sql"))) {
    const { sqlFileEntities } = await import("../../sql-files");
    return sqlFileEntities("postgres", [{ ddl: content, origin: sourceFile ?? "the DDL" }], { known: new Map() });
  }
  const { buildFolded, loadProject } = await import("../../sql-types-command");
  const project = await loadProject(isDir ? sourceFile! : dirname(sourceFile!));
  const result = await buildFolded(project, "chant migrate", "nothing was translated");
  if (!result) throw new Error(`the build of ${sourceFile} failed`);
  return new Map(result.entities as ReadonlyMap<string, Declarable>);
}

/** A finding as the lint diagnostic `chant migrate` writes as SARIF. */
function toDiagnostic(file: string, d: Translation["diagnostics"][number], strict: boolean): Record<string, unknown> {
  return {
    file,
    line: d.line ?? 1,
    column: d.column ?? 1,
    ruleId: d.ruleId,
    // Under --strict a warning is an error, which is what fails the run (core reads the severity).
    severity: strict && d.severity === "warning" ? "error" : d.severity,
    message: d.message,
    ...(d.entity ? { entity: d.entity } : {}),
  };
}

export async function transform(content: string, opts: MigrateOptions): Promise<MigrationResult> {
  const emit = opts.emit ?? "ts";
  if (emit === "yaml") throw new Error("--emit yaml has no meaning here; use --emit ts or --emit sql");
  const composite = opts.useComposites === true;
  const file = opts.sourceFile ?? "schema.sql";
  const entities = await loadPostgresEntities(content, opts.sourceFile);
  const translation = translatePostgres(entities, { composite });
  if (translation.mirrors.length === 0) {
    const refused = translation.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    throw new Error(`no Postgres table to mirror in ${file}${refused.length > 0 ? `: ${refused.join(" ")}` : ""}`);
  }
  const output = emit === "sql" ? emitSql(translation.mirrors, composite) : emitTs(translation.mirrors, composite);
  const diagnostics = translation.diagnostics.map((d) => toDiagnostic(file, d, opts.strict === true));
  const provenance = translation.mirrors.map((m) => ({
    sourceKey: `${m.source.schema}.${m.source.table}`,
    rule: composite ? "SQLMIG-CDC-MIRROR" : "SQLMIG-TABLE",
    category: "translated",
    note: `${String(m.columns.length)} columns; ORDER BY ${m.primaryKey.length === 0 ? "tuple()" : `(${m.primaryKey.join(", ")})`}`,
  }));
  return {
    output,
    provenance,
    diagnostics,
    links: translation.outputs,
    validate: async () => {
      const [{ objectsToIR }, { validateOnEmulator }] = await Promise.all([import("../../clickhouse/import/ir"), import("../../sqlserver/validate")]);
      const found = await validateOnEmulator(objectsToIR(mirrorObjects(translation.mirrors, composite)));
      return found.map((d) => ({ file, line: 1, column: 1, ruleId: d.ruleId, severity: d.severity, message: d.message, ...(d.entity ? { entity: d.entity } : {}) }));
    },
  };
}

/** The `migrationSource` of the sql lexicon for this pair. */
export function postgresToClickHouseSource(): MigrationSource {
  return {
    detect: looksLikePostgres,
    directory: true,
    transform,
  };
}
