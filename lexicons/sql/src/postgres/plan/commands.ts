/**
 * `chant sql diff` and `chant sql plan` for Postgres: the classified change
 * between two builds, or between a build and a live server.
 *
 * `diff` is offline and needs no server. `plan` reads the server
 * `sql.profiles.<env>` binds, and asks it about expressions the rules leave
 * different (`./server-normalize.ts`). Both exit 2 when a change can only be
 * made as expand and contract, which a plan refuses, and 0 otherwise.
 */

import { bindPostgres, loadSqlConfig, type BindOptions } from "../live/bind";
import { markProviderOwned, readLiveSchema } from "../live/catalog";
import { scopeFor } from "../live/describe-resources";
import { diffPgSchemas, type PgSchemaDiff } from "./diff";
import { renderPgDiff } from "./report";
import { keyedByQualifiedName, pgBuildFileMajor, pgSchemaFromBuildFile, pgSchemaFromLive, type PgSchemaObject } from "./schema";
import { serverNormalized } from "./server-normalize";
import { POSTGRES_ENTITY_TYPES } from "../entity-types";

export function emitPg(diff: PgSchemaDiff, json: boolean, title: string): number {
  console.log(json ? JSON.stringify(diff, null, 2) : renderPgDiff(diff, { title }));
  return diff.refused.length > 0 ? 2 : 0;
}

/** The major the project declares (`sql.postgresMajor`); undefined is the newest pinned one. */
export async function projectMajor(options: { config?: { sql?: { postgresMajor?: number } }; cwd?: string } = {}): Promise<number | undefined> {
  const config = options.config ?? (await loadSqlConfig(options.cwd ?? process.cwd()));
  return (config?.sql as { postgresMajor?: number } | undefined)?.postgresMajor;
}

/**
 * Offline, the major is the one the builds recorded (`postgresMajor`): the
 * newer build's, else the older's, so a diff between revisions does not
 * depend on today's config. `configMajor` (`sql.postgresMajor`) answers for
 * builds that recorded none.
 */
export function diffPgBuildFiles(before: string, after: string, configMajor?: number): PgSchemaDiff {
  const major = pgBuildFileMajor(after) ?? pgBuildFileMajor(before) ?? configMajor;
  return diffPgSchemas(pgSchemaFromBuildFile(before), pgSchemaFromBuildFile(after), { major });
}

/** The live server's major, from `server_version_num` (`180006` is 18). */
async function serverMajor(client: { query<T>(sql: string): Promise<T[]> }): Promise<number | undefined> {
  const rows = await client.query<{ v: string }>("select current_setting('server_version_num') as v");
  const n = Number(rows[0]?.v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 10000) : undefined;
}

const differs = (a: PgSchemaObject, b: PgSchemaObject) =>
  JSON.stringify([a.canonical.fields, a.canonical.columns, a.canonical.constraints]) !== JSON.stringify([b.canonical.fields, b.canonical.columns, b.canonical.constraints]);

/** The declared objects against the server, keys by qualified name and labels with the export name. */
export async function planPgAgainstServer(environment: string, buildFile: string, options: Omit<BindOptions, "environment"> = {}): Promise<PgSchemaDiff> {
  const { target, client } = await bindPostgres({ ...options, environment });
  try {
    const declared = keyedByQualifiedName(pgSchemaFromBuildFile(buildFile, target.defaultSchema));
    const scope = scopeFor(
      target,
      declared.map((o) => ({ type: POSTGRES_ENTITY_TYPES[o.canonical.kind], props: { name: o.canonical.name, ...(o.canonical.schema ? { schema: o.canonical.schema } : {}) } })),
    );
    const live = pgSchemaFromLive(markProviderOwned(await readLiveSchema(client, { schemas: scope }), target.provider), target.defaultSchema);
    const liveByKey = new Map(live.map((o) => [o.key, o]));
    const normalized: PgSchemaObject[] = [];
    for (const o of declared) {
      const l = liveByKey.get(o.key);
      if (l && differs(o, l) && (o.canonical.kind === "table" || o.canonical.kind === "view" || o.canonical.kind === "materializedView")) {
        normalized.push({ ...o, canonical: { ...o.canonical, ...(await serverNormalized(client, o.canonical, target.defaultSchema)) } });
      } else normalized.push(o);
    }
    // The build's recorded major, else the config's; the server's own when it differs, since the server is what takes the locks.
    const targeted = pgBuildFileMajor(buildFile) ?? (await projectMajor(options));
    const running = await serverMajor(client);
    const major = running ?? targeted;
    const diff = diffPgSchemas(live, normalized, { major });
    if (running !== undefined && targeted !== undefined && running !== targeted) {
      diff.hints.push(`the build targets Postgres ${targeted} but ${environment} runs Postgres ${running}; changes are classified for ${running}`);
    }
    const label = new Map(declared.map((o) => [o.key, `${o.canonical.exportName} (${o.key.split(" ")[1]})`]));
    const changes = diff.changes.map((c) => ({ ...c, object: label.get(c.object) ?? c.object }));
    return { changes, hints: diff.hints, refused: changes.filter((c) => c.class === "expand") };
  } finally {
    await client.end();
  }
}
