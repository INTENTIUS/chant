/**
 * The ClickHouse applier (#3208): make a server hold what a build declares,
 * for every change the classifier (`../plan/rules.ts`) puts in the metadata
 * or background-rewrite class, and refuse the rest.
 *
 * Per declared object, exactly one verdict (lexicon-authoring/applying.mdx):
 *
 * - APPLIED `created`: absent on the server; created from its declared
 *   `CREATE`, with chant's ownership marker in its comment.
 * - APPLIED `updated`: present, and the `ALTER`s for its changes ran. A
 *   background rewrite (a column type change, a TTL change) is waited on in
 *   `system.mutations` before the object counts as applied.
 * - APPLIED `unchanged`: present, nothing to change, the marker in place.
 * - NOT-ATTEMPTED `unsupported-kind`: a change ClickHouse cannot make with
 *   `ALTER` (a sorting key, a partition key, an engine, a key column's type).
 *   Nothing is sent for the object; the detail names each rule and the
 *   restriction behind it, and names the rebuild migration Op to run instead
 *   (`ClickHouseRebuildOp`, #3198).
 * - NOT-ATTEMPTED `filtered`: the change drops a column, which destroys its
 *   data, and the apply was not allowed to delete.
 * - NOT-ATTEMPTED `dependency-failed`: an object it references is not on the
 *   server, because creating it failed or was not attempted.
 * - NOT-ATTEMPTED with the binding's reason: no server to apply to.
 *
 * A statement the server refuses is neither: the object was attempted and did
 * not converge. The rest of the apply goes on, and the applier then throws
 * {@link ClickHouseApplyError}, which carries the outcome so far.
 *
 * Prune, when asked for, drops the objects in the declared databases that the
 * build no longer declares and whose comment carries this project's marker
 * (stack and env). Nothing else is ever dropped: an object without the marker
 * is not chant's, and one with another stack's marker is that stack's.
 */

import type { OwnershipMarker } from "@intentius/chant/ownership";
import type { ApplyRef } from "@intentius/chant/apply";
import {
  SqlApplyError,
  changesByObject,
  dependencyFailedDetail,
  missingDependencies,
  readBuildObjects,
  type SqlApplyOutcome,
} from "../../core/apply";
import { clickhouseQuery } from "../http";
import type { ClickHouseTarget } from "../live/bind";
import { readLiveSchema, type LiveObject } from "../live/catalog";
import { canonicalObject, type CanonicalObject } from "../plan/normalize";
import { diffSchemas, type Change } from "../plan/diff";
import { dropFormattingOnly } from "../plan/server-format";
import { CLICKHOUSE_ENTITY_TYPES, type ClickHouseEntityType } from "../entities";
import { carriesMarker, isChantManaged } from "../ownership";
import {
  alterSteps,
  commentStatement,
  createStatement,
  dropStatement,
  isDestructiveAlter,
  isRebuild,
  refusalDetail,
  sqlString,
  stepsSetComment,
  type DeclaredObject,
  type Step,
} from "./statements";
import { waitForMutations } from "./mutations";

export type { FailedObject } from "../../core/apply";

/**
 * The objects a `chant build` output declares, in creation order. Takes the
 * sql lexicon's primary output, or a multi-lexicon output holding it under
 * `sql` (the shared core's reader).
 */
export function declaredObjects(json: string, defaultDatabase = "default"): DeclaredObject[] {
  return readBuildObjects(json, "clickhouse", (o) => {
    const canonical = canonicalObject(o.ddl, defaultDatabase);
    return {
      exportName: o.export,
      type: o.type as ClickHouseEntityType,
      key: canonical.database !== undefined ? `${canonical.database}.${canonical.name}` : canonical.name,
      ddl: o.ddl,
      canonical,
      dependsOn: o.dependsOn,
    };
  });
}

/** The plan axis: one ref per declared object, by its kind and its name on the server. */
export const planRefs = (declared: readonly DeclaredObject[]): ApplyRef[] => declared.map((o) => ({ kind: o.type, name: o.key }));

export interface ClickHouseApplyOptions {
  /** The marker to stamp, and the identity a prune matches. Without a stack, prune declines. */
  marker?: OwnershipMarker;
  /** Drop owned objects the build no longer declares, and allow column drops. Default: off. */
  prune?: boolean;
  /** How long to wait for one table's mutations. Default: ten minutes. */
  mutationTimeoutMs?: number;
  signal?: AbortSignal;
  /** Where to report each statement. Default: nowhere. */
  log?: (line: string) => void;
}

/**
 * The shared core's outcome: `target` is the server's URL, `source` where the
 * binding came from (`sql.profiles.<env>` or `env CLICKHOUSE_URL`).
 */
export type ClickHouseApplyOutcome = SqlApplyOutcome;

/** An apply in which the server refused a statement. The outcome says what did and did not happen. */
export class ClickHouseApplyError extends SqlApplyError<ClickHouseApplyOutcome> {
  constructor(outcome: ClickHouseApplyOutcome) {
    super("ClickHouse", outcome);
    this.name = "ClickHouseApplyError";
  }
}

const liveKey = (o: LiveObject) => (o.database !== undefined ? `${o.database}.${o.name}` : o.name);

/** Drop order: what reads from a table before the table, a database last. */
const DROP_ORDER: Record<string, number> = {
  [CLICKHOUSE_ENTITY_TYPES.materializedView]: 0,
  [CLICKHOUSE_ENTITY_TYPES.view]: 1,
  [CLICKHOUSE_ENTITY_TYPES.table]: 2,
  [CLICKHOUSE_ENTITY_TYPES.database]: 3,
};

/**
 * The server's objects in the databases the declarations use, as the diff
 * compares them. The `default` database itself is never part of a schema.
 */
async function liveSchema(target: ClickHouseTarget, declared: readonly DeclaredObject[]): Promise<{ objects: LiveObject[]; canonical: Map<string, CanonicalObject> }> {
  const databases = new Set(declared.map((o) => o.canonical.database ?? o.canonical.name));
  const objects = (await readLiveSchema(target))
    .filter((o) => !(o.type === CLICKHOUSE_ENTITY_TYPES.database && o.name === "default"))
    .filter((o) => databases.has(o.database ?? o.name));
  return { objects, canonical: new Map(objects.map((o) => [liveKey(o), canonicalObject(o.statement, target.defaultDatabase)])) };
}

/**
 * The classified changes from the server to the declarations, keyed by the
 * declared object (`database.name`), with formatting-only differences dropped
 * by asking the server, as `chant sql plan` does.
 */
export async function plannedChanges(target: ClickHouseTarget, declared: readonly DeclaredObject[], live: Map<string, CanonicalObject>): Promise<Change[]> {
  const diff = diffSchemas(
    [...live].map(([key, canonical]) => ({ key, canonical })),
    declared.map((o) => ({ key: o.key, canonical: o.canonical })),
  );
  return dropFormattingOnly(target.endpoint, diff.changes);
}

/**
 * Apply the declarations to the server. Returns every declared object in
 * exactly one of applied or not attempted, and every pruned orphan; throws
 * {@link ClickHouseApplyError} when the server refused a statement.
 */
export async function applyClickHouse(target: ClickHouseTarget, declared: readonly DeclaredObject[], opts: ClickHouseApplyOptions = {}): Promise<ClickHouseApplyOutcome> {
  const log = opts.log ?? (() => undefined);
  const { objects: liveObjects, canonical: live } = await liveSchema(target, declared);
  const liveByKey = new Map(liveObjects.map((o) => [liveKey(o), o]));
  const changes = await plannedChanges(target, declared, live);
  const byObject = changesByObject(changes);

  const outcome: ClickHouseApplyOutcome = { target: target.endpoint.url, source: target.source, applied: [], pruned: [], notAttempted: [], failed: [] };
  /** Export names whose object is on the server. */
  const onServer = new Set<string>();
  const exportNames = new Set(declared.map((o) => o.exportName));

  const run = async (step: Step, obj: { database?: string; name: string }, ran: string[]) => {
    opts.signal?.throwIfAborted();
    log(step.sql);
    await clickhouseQuery(target.endpoint, step.sql);
    ran.push(step.sql);
    if (step.rewrite && obj.database !== undefined) {
      const ids = await waitForMutations(target.endpoint, obj.database, obj.name, {
        ...(opts.mutationTimeoutMs !== undefined ? { timeoutMs: opts.mutationTimeoutMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (ids.length > 0) log(`-- waited for ${ids.join(", ")}`);
    }
  };

  for (const obj of declared) {
    const ref = { kind: obj.type, name: obj.key };
    const mine = byObject.get(obj.key) ?? [];
    const created = mine.some((c) => c.rule === "SQLCH200");
    const renamedFrom = mine.find((c) => c.rule === "SQLCH230" || c.rule === "SQLCH231")?.before;
    const liveObject = liveByKey.get(renamedFrom ?? obj.key);
    const liveCanonical = live.get(renamedFrom ?? obj.key);

    const refused = mine.filter(isRebuild);
    if (refused.length > 0) {
      if (liveObject) onServer.add(obj.exportName);
      outcome.notAttempted.push({ ...ref, reason: "unsupported-kind", detail: refusalDetail(refused, obj.key, obj.type) });
      continue;
    }
    const destructive = mine.filter(isDestructiveAlter);
    if (destructive.length > 0 && !opts.prune) {
      onServer.add(obj.exportName);
      outcome.notAttempted.push({
        ...ref,
        reason: "filtered",
        detail: `drops ${destructive.map((c) => c.field).join(", ")}, which destroys the data in it; an apply that may delete (prune, ApplyOp delete "owned-only" or "gated") makes it`,
      });
      continue;
    }

    const restamp = !created && !stepsSetComment(obj, mine) && (mine.some((c) => c.field === "comment") || !carriesMarker(liveObject?.comment, opts.marker));
    const steps: Step[] = created
      ? [{ sql: createStatement(obj, opts.marker), rewrite: false }]
      : [...alterSteps(obj, mine, { ...(liveCanonical ? { live: liveCanonical } : {}), ...(opts.marker ? { marker: opts.marker } : {}) }), ...(restamp ? [{ sql: commentStatement(obj, opts.marker), rewrite: false }] : [])];

    if (steps.length === 0) {
      onServer.add(obj.exportName);
      outcome.applied.push({ ...ref, action: "unchanged", ...(liveObject?.uuid ? { physicalId: liveObject.uuid } : {}), statements: [] });
      continue;
    }
    const missing = missingDependencies(obj.exportName, obj.dependsOn, exportNames, onServer);
    if (missing.length > 0) {
      if (!created) onServer.add(obj.exportName);
      outcome.notAttempted.push({ ...ref, reason: "dependency-failed", detail: dependencyFailedDetail(missing) });
      continue;
    }

    const ran: string[] = [];
    try {
      for (const step of steps) await run(step, { ...(obj.canonical.database !== undefined ? { database: obj.canonical.database } : {}), name: obj.canonical.name }, ran);
      onServer.add(obj.exportName);
      outcome.applied.push({ ...ref, action: created ? "created" : "updated", ...(liveObject?.uuid ? { physicalId: liveObject.uuid } : {}), statements: ran });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (!created) onServer.add(obj.exportName);
      outcome.failed.push({ ...ref, error: err instanceof Error ? err.message : String(err), statements: ran });
    }
  }

  if (opts.prune) await prune(target, changes, liveByKey, opts, outcome, log);
  if (outcome.failed.length > 0) throw new ClickHouseApplyError(outcome);
  return outcome;
}

async function prune(
  target: ClickHouseTarget,
  changes: readonly Change[],
  liveByKey: Map<string, LiveObject>,
  opts: ClickHouseApplyOptions,
  outcome: ClickHouseApplyOutcome,
  log: (line: string) => void,
): Promise<void> {
  const orphans = changes
    .filter((c) => c.rule === "SQLCH250")
    .map((c) => liveByKey.get(c.object))
    .filter((o): o is LiveObject => o !== undefined)
    .sort((a, b) => (DROP_ORDER[a.type] ?? 9) - (DROP_ORDER[b.type] ?? 9));

  for (const o of orphans) {
    const ref = { kind: o.type, name: liveKey(o) };
    if (!isChantManaged(o.comment)) continue; // not chant's: never touched, never reported
    if (!opts.marker?.stack) {
      outcome.notAttempted.push({
        ...ref,
        reason: "not-prunable",
        detail: "the project declares no ownership.stack, so this project's objects cannot be told from another chant project's",
      });
      continue;
    }
    if (!carriesMarker(o.comment, opts.marker)) continue; // another stack's or env's
    try {
      if (o.type === CLICKHOUSE_ENTITY_TYPES.database) {
        const [row] = await clickhouseQuery<{ n: string | number }>(target.endpoint, `SELECT count() AS n FROM system.tables WHERE database = ${sqlString(o.name)}`);
        const n = Number(row?.n ?? 0);
        if (n > 0) {
          outcome.notAttempted.push({ ...ref, reason: "not-prunable", detail: `still holds ${n} object(s) this apply does not drop; dropping the database would drop them` });
          continue;
        }
      }
      const sql = dropStatement(o.type, o.database, o.name);
      opts.signal?.throwIfAborted();
      log(sql);
      await clickhouseQuery(target.endpoint, sql);
      outcome.pruned.push({ ...ref, deleted: true, statement: sql });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      outcome.failed.push({ ...ref, error: err instanceof Error ? err.message : String(err), statements: [] });
    }
  }
}
