/**
 * `chant sql diff` and `chant sql plan` for Postgres: the classified change
 * between two builds, or between a build and a live server.
 *
 * `diff` is offline and needs no server. `plan` reads the server
 * `sql.profiles.<env>` binds, and asks it about expressions the rules leave
 * different (`./server-normalize.ts`). Both exit 2 when a change can only be
 * made as expand and contract, which a plan refuses, and 0 otherwise.
 */

import { bindPostgres, loadSqlConfig, type BindOptions, type PostgresTarget } from "../live/bind";
import type { PostgresClient } from "../live/client";
import { markProviderOwned, readLiveSchema, type LivePgObject } from "../live/catalog";
import { scopeFor } from "../live/describe-resources";
import { diffPgSchemas, type PgSchemaDiff } from "./diff";
import { renderPgDiff } from "./report";
import { keyedByQualifiedName, pgSchemaFromBuildFile, pgSchemaFromLive, type PgSchemaObject } from "./schema";
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

export function diffPgBuildFiles(before: string, after: string, major?: number): PgSchemaDiff {
  return diffPgSchemas(pgSchemaFromBuildFile(before), pgSchemaFromBuildFile(after), { major });
}

const differs = (a: PgSchemaObject, b: PgSchemaObject) =>
  JSON.stringify([a.canonical.fields, a.canonical.columns, a.canonical.constraints]) !== JSON.stringify([b.canonical.fields, b.canonical.columns, b.canonical.constraints]);

/** What {@link planAgainstClient} compares and finds: both sides keyed by qualified name, and the classified changes between them. */
export interface PgServerPlan {
  /** The declarations, keyed by qualified name, with what the server said about expressions the rules left different. */
  declared: PgSchemaObject[];
  /** What the server holds in scope, keyed by qualified name. */
  live: PgSchemaObject[];
  /** The same, as the catalog read returned it (comments with their trailers). */
  liveObjects: LivePgObject[];
  diff: PgSchemaDiff;
}

/**
 * The declared objects (a build's, keyed by export name) against what a
 * connected server holds: read in the declarations' scope, the server asked
 * about expressions the rules leave different, then diffed. The plan and the
 * applier (`../apply/`) share it.
 */
export async function planAgainstClient(
  client: PostgresClient,
  target: PostgresTarget,
  build: readonly PgSchemaObject[],
  options: { major?: number; readLive?: typeof readLiveSchema; serverNormalize?: typeof serverNormalized } = {},
): Promise<PgServerPlan> {
  const declaredRaw = keyedByQualifiedName(build);
  const scope = scopeFor(
    target,
    declaredRaw.map((o) => ({ type: POSTGRES_ENTITY_TYPES[o.canonical.kind], props: { name: o.canonical.name, ...(o.canonical.schema ? { schema: o.canonical.schema } : {}) } })),
  );
  const liveObjects = markProviderOwned(await (options.readLive ?? readLiveSchema)(client, { schemas: scope }), target.provider);
  const live = pgSchemaFromLive(liveObjects, target.defaultSchema);
  const liveByKey = new Map(live.map((o) => [o.key, o]));
  const declared: PgSchemaObject[] = [];
  for (const o of declaredRaw) {
    const l = liveByKey.get(o.key);
    if (l && differs(o, l) && (o.canonical.kind === "table" || o.canonical.kind === "view" || o.canonical.kind === "materializedView")) {
      declared.push({ ...o, canonical: { ...o.canonical, ...(await (options.serverNormalize ?? serverNormalized)(client, o.canonical, target.defaultSchema)) } });
    } else declared.push(o);
  }
  return { declared, live, liveObjects, diff: diffPgSchemas(live, declared, { major: options.major }) };
}

/** The declared objects against the server, keys by qualified name and labels with the export name. */
export async function planPgAgainstServer(environment: string, buildFile: string, options: Omit<BindOptions, "environment"> = {}): Promise<PgSchemaDiff> {
  const { target, client } = await bindPostgres({ ...options, environment });
  try {
    const { declared, diff } = await planAgainstClient(client, target, pgSchemaFromBuildFile(buildFile, target.defaultSchema), { major: await projectMajor(options) });
    const label = new Map(declared.map((o) => [o.key, `${o.canonical.exportName} (${o.key.split(" ")[1]})`]));
    const changes = diff.changes.map((c) => ({ ...c, object: label.get(c.object) ?? c.object }));
    return { changes, hints: diff.hints, refused: changes.filter((c) => c.class === "expand") };
  } finally {
    await client.end();
  }
}
