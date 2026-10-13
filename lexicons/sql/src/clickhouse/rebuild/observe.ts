/**
 * The rebuild migration's view of the server (#3198): which table is being
 * rebuilt, how far the rebuild has got, and what it will do.
 *
 * Every step of the Op re-observes from here rather than trusting what an
 * earlier run or step said, so the Op converges: run it again after a crash,
 * a gate or an approval, and each step finds its work done or still to do.
 * The progress is read off the server's own objects:
 *
 * - the table being rebuilt, `db.t`, as declared and as the server has it;
 * - `db.t__chant_new`, the new table being filled (`role=new` in its comment);
 * - `db.t__chant_dual`, the dual-write materialized view (`role=dual`);
 * - `db.t__chant_old`, the old table kept after the swap (`role=old`, with
 *   `retain-until`).
 *
 * Each working object carries chant's ownership trailer plus
 * `rebuild=<db.t>` and its role (`../ownership.ts`), so it is chant's and
 * this rebuild's, and schema reads leave it out.
 *
 * States:
 *
 * - `rebuild`: the declaration differs from the server by at least one
 *   rebuild-class change, and the old table has not been swapped out yet.
 * - `swapped`: the swap ran; the old table is retained until its date.
 * - `done`: the server holds the declaration and nothing of the rebuild is
 *   left.
 *
 * Anything else is refused with a {@link RebuildRefusal}: a database that is
 * neither Atomic nor Replicated, a table that is not there, a change that is
 * not a rebuild, a working object chant did not make.
 *
 * A Replicated database (#3249) is Atomic on every replica, with its DDL run
 * on each through Keeper, so the same EXCHANGE swaps the table everywhere.
 * Its tables have to be `Replicated*MergeTree` on both sides of the rebuild:
 * a plain MergeTree there keeps a different set of rows on each replica, and
 * a copy run on one replica would fill the new table with that replica's rows
 * alone.
 */

import type { OwnershipMarker } from "@intentius/chant/ownership";
import { computePlanDigest } from "@intentius/chant/op";
import { clickhouseQuery } from "../http";
import type { ClickHouseTarget } from "../live/bind";
import { canonicalObject, type CanonicalObject } from "../plan/normalize";
import { diffSchemas, type Change } from "../plan/diff";
import { dropFormattingOnly } from "../plan/server-format";
import { CLASSIFIER_RULES } from "../plan/rules";
import { CLICKHOUSE_ENTITY_TYPES } from "../entities";
import { carriesMarker, readTrailerPairs, REBUILD_TRAILER_KEY, stripMarkerFromStatement } from "../ownership";
import { ident, isRebuild, qualifiedIdent, sqlString, type DeclaredObject } from "../apply/statements";

/** How the new table keeps up with writes to the old one while it is filled. */
export type DualWrite =
  | {
      /**
       * A materialized view on the old table writes every row whose
       * `cutoverColumn` is at or after the cut-over into the new table; the
       * backfill copies the rows before it, and the rows at or after it that
       * the table held before the view was made. The cut-over is the server's
       * time when the view is made plus `cutoverDelay` (default `5s`), rounded
       * up to a whole second. The backfill starts once the server's clock has
       * passed it and every write into the old table begun before it has
       * finished (`cutoverTimeout` bounds that wait). The column must be a time
       * (`Date`, `DateTime`, `DateTime64`) that rows arrive in order of, give
       * or take the delay; a row that arrives later than that is caught by
       * the verification, which then fails the run. Writers that batch rows
       * for longer than five seconds before inserting them need a delay
       * longer than their batches.
       */
      mode: "materialized-view";
      cutoverColumn: string;
      cutoverDelay?: string;
    }
  | {
      /**
       * The application stops writing to the old table (pauses, or buffers)
       * and a person says so at a gate before the backfill. The backfill then
       * copies every row, and writes resume against the table's own name
       * after the swap.
       */
      mode: "app";
    };

/** A refusal: the rebuild cannot start, or cannot go on, for a reason a person has to act on. */
export class RebuildRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RebuildRefusal";
  }
}

/** The table's name and its working objects' names. */
export interface RebuildNames {
  /** `db.t`, the rebuild's identity. */
  key: string;
  database: string;
  name: string;
  newName: string;
  dualName: string;
  oldName: string;
  /** Quoted, qualified: `` `db`.`t` `` and so on. */
  table: string;
  newTable: string;
  dualView: string;
  oldTable: string;
}

export function rebuildNames(database: string, name: string): RebuildNames {
  const newName = `${name}__chant_new`;
  const dualName = `${name}__chant_dual`;
  const oldName = `${name}__chant_old`;
  return {
    key: `${database}.${name}`,
    database,
    name,
    newName,
    dualName,
    oldName,
    table: qualifiedIdent(database, name),
    newTable: qualifiedIdent(database, newName),
    dualView: qualifiedIdent(database, dualName),
    oldTable: qualifiedIdent(database, oldName),
  };
}

/** One object on the server, as `system.tables` reports it. */
export interface ServerObject {
  name: string;
  uuid: string;
  engine: string;
  comment: string;
  partitionKey: string;
  /** The working-object pairs in its comment's trailer, if any. */
  pairs?: Map<string, string>;
}

/** A column copied from the old table into the new one. */
export interface CopiedColumn {
  /** Its name in the new table. */
  name: string;
  /** Its name in the old table: the same, or the `-- previously:` name. */
  source: string;
}

export interface RebuildObservation {
  state: "rebuild" | "swapped" | "done";
  names: RebuildNames;
  declared: DeclaredObject;
  /** The table under its own name. */
  live: ServerObject;
  /** Its definition on the server, as the classifier compares it. */
  liveCanonical: CanonicalObject;
  /** The classified changes from the server's table to the declaration. */
  changes: Change[];
  newTable?: ServerObject;
  dual?: ServerObject;
  old?: ServerObject;
  /** After the EXCHANGE and before the swap finished: the old table, still under the new table's name. */
  exchangedOld?: ServerObject;
  /** The swap's EXCHANGE ran and the swap has not finished: the table's own name holds the new table. */
  exchanged: boolean;
  /** The columns the backfill copies, and the verification compares. */
  copied: CopiedColumn[];
  /**
   * The database is Replicated: every replica runs its DDL, the tables'
   * rows replicate through Keeper, and a step reading rows first waits for
   * this replica to catch up (`SYSTEM SYNC REPLICA`).
   */
  replicated: boolean;
}

const qualifiedKey = (o: DeclaredObject) => `${o.canonical.database ?? "default"}.${o.canonical.name}`;

/** The declared table with the given key (`db.t`), or a refusal naming what is declared. */
export function declaredTable(declared: readonly DeclaredObject[], key: string): DeclaredObject {
  const found = declared.find((o) => o.key === key || o.exportName === key);
  if (!found) {
    throw new RebuildRefusal(`${key} is not declared in the build. Declared tables: ${declared.filter((o) => o.type === CLICKHOUSE_ENTITY_TYPES.table).map(qualifiedKey).join(", ") || "none"}`);
  }
  if (found.type !== CLICKHOUSE_ENTITY_TYPES.table) throw new RebuildRefusal(`${key} is a ${found.type}, and only a table is rebuilt`);
  return found;
}

/**
 * The columns the backfill copies: every declared column the old table has
 * under its name or its `-- previously:` name, except a `MATERIALIZED`,
 * `ALIAS` or `EPHEMERAL` one, which the new table computes itself.
 */
export function copiedColumns(declared: CanonicalObject, live: CanonicalObject): CopiedColumn[] {
  const liveNames = new Set(live.columns.map((c) => c.name));
  const out: CopiedColumn[] = [];
  for (const c of declared.columns) {
    if (c.defaultKind && c.defaultKind !== "DEFAULT") continue;
    const source = liveNames.has(c.name) ? c.name : c.previously && liveNames.has(c.previously) ? c.previously : undefined;
    if (source) out.push({ name: c.name, source });
  }
  return out;
}

/** A canonical definition without what names it, for comparing and digesting by role. */
export function anonymous(c: CanonicalObject): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...c,
    columns: c.columns.map((col) => Object.fromEntries(Object.entries(col).filter(([k]) => k !== "text"))),
  };
  for (const k of ["name", "database", "previously", "comment"]) delete out[k];
  return out;
}

async function serverObjects(target: ClickHouseTarget, names: RebuildNames): Promise<Map<string, ServerObject>> {
  const rows = await clickhouseQuery<{ name: string; uuid: string; engine: string; comment: string; partition_key: string }>(
    target.endpoint,
    `SELECT name, toString(uuid) AS uuid, engine, comment, partition_key FROM system.tables ` +
      `WHERE database = ${sqlString(names.database)} AND name IN (${[names.name, names.newName, names.dualName, names.oldName].map(sqlString).join(", ")})`,
  );
  return new Map(
    rows.map((r) => {
      const pairs = readTrailerPairs(r.comment);
      return [r.name, { name: r.name, uuid: r.uuid, engine: r.engine, comment: r.comment, partitionKey: r.partition_key, ...(pairs?.has(REBUILD_TRAILER_KEY) ? { pairs } : {}) }];
    }),
  );
}

/** The definition `SHOW CREATE` prints, less chant's trailer, canonical. */
export async function showCreate(target: ClickHouseTarget, qualified: string): Promise<CanonicalObject> {
  const [row] = await clickhouseQuery<{ statement: string }>(target.endpoint, `SHOW CREATE TABLE ${qualified}`);
  return canonicalObject(stripMarkerFromStatement(row?.statement ?? ""), target.defaultDatabase);
}

/** The classified changes from one definition to another, compared by role, with server formatting differences dropped. */
export async function changesBetween(target: ClickHouseTarget, key: string, from: CanonicalObject, to: CanonicalObject): Promise<Change[]> {
  const diff = diffSchemas([{ key, canonical: from }], [{ key, canonical: to }]);
  return dropFormattingOnly(target.endpoint, diff.changes);
}

/**
 * A working object is this rebuild's only when it carries this project's
 * marker, names this table and has the role its name says. One that has
 * the name and not the marker is somebody else's, and the rebuild stops
 * rather than drop or fill it.
 */
function ownWorkingObject(o: ServerObject | undefined, names: RebuildNames, role: "new" | "dual" | "old", marker: OwnershipMarker | undefined): ServerObject | undefined {
  if (!o) return undefined;
  if (!carriesMarker(o.comment, marker) || o.pairs?.get(REBUILD_TRAILER_KEY) !== names.key || o.pairs.get("role") !== role) {
    throw new RebuildRefusal(
      `${names.database}.${o.name} exists and is not this rebuild's ${role} table (its comment carries no rebuild=${names.key} role=${role} marker for this project). ` +
        `The rebuild uses that name, so it stops rather than touch it; rename or drop it by hand.`,
    );
  }
  return o;
}

/** Observe the rebuild of the declared table on the server. */
export async function observeRebuild(target: ClickHouseTarget, declared: DeclaredObject, marker: OwnershipMarker | undefined): Promise<RebuildObservation> {
  const database = declared.canonical.database ?? target.defaultDatabase;
  const names = rebuildNames(database, declared.canonical.name);

  const [db] = await clickhouseQuery<{ engine: string }>(target.endpoint, `SELECT engine FROM system.databases WHERE name = ${sqlString(database)}`);
  if (!db) throw new RebuildRefusal(`database ${database} is not on the server, so there is no ${names.key} to rebuild; the applier creates it`);
  if (db.engine !== "Atomic" && db.engine !== "Replicated") {
    throw new RebuildRefusal(
      `database ${database} uses the ${db.engine} engine. The swap is EXCHANGE TABLES, which ClickHouse supports only in an Atomic database ` +
        `(https://clickhouse.com/docs/sql-reference/statements/exchange) and the Replicated one built on it, and two RENAMEs in its place would leave a moment with no ${names.key} for writes to land in. ` +
        `Convert the database to Atomic first (https://clickhouse.com/docs/engines/database-engines/atomic), then run the rebuild.`,
    );
  }
  const replicated = db.engine === "Replicated";

  const objects = await serverObjects(target, names);
  const liveRow = objects.get(names.name);
  if (!liveRow) throw new RebuildRefusal(`${names.key} is not on the server, so there is nothing to rebuild; the applier creates it`);
  // Between EXCHANGE and the end of the swap, the table's own name holds the
  // new table, still carrying role=new, and the new table's name holds the
  // old table until it is renamed; the swap step finishes that.
  const exchanged = liveRow.pairs?.get(REBUILD_TRAILER_KEY) === names.key && liveRow.pairs.get("role") === "new";
  const newTable = exchanged ? undefined : ownWorkingObject(objects.get(names.newName), names, "new", marker);
  const exchangedOld = exchanged ? objects.get(names.newName) : undefined;
  const dual = ownWorkingObject(objects.get(names.dualName), names, "dual", marker);
  const old = ownWorkingObject(objects.get(names.oldName), names, "old", marker);
  const liveCanonical = await showCreate(target, names.table);
  const changes = (await changesBetween(target, names.key, { ...liveCanonical, name: declared.canonical.name }, declared.canonical)).filter((c) => !(c.field === "comment" && c.rule === "SQLCH203"));
  const copied = copiedColumns(declared.canonical, liveCanonical);

  let state: RebuildObservation["state"];
  if (old || exchanged) {
    if (changes.some(isRebuild) && !exchanged) {
      throw new RebuildRefusal(
        `${names.key} differs from its declaration by a rebuild again, and the old table of the last rebuild is still kept as ${names.database}.${names.oldName}. ` +
          `Drop it (the rebuild's drop phase, or DROP TABLE) before rebuilding again.`,
      );
    }
    state = "swapped";
  } else if (changes.some(isRebuild)) {
    state = "rebuild";
  } else if (changes.length === 0) {
    state = "done";
  } else {
    throw new RebuildRefusal(
      `${names.key} has no change that needs a rebuild: ${changes.map((c) => `${c.rule} ${CLASSIFIER_RULES[c.rule].title} on ${c.field}`).join("; ")}. ` +
        `The applier makes these in place (ApplyOp with target "clickhouse").`,
    );
  }
  if (state === "rebuild") {
    if (replicated) refuseUnreplicated(names, liveRow.engine, declared.canonical.engineName);
    refuseSharedKeeperPath(names, liveCanonical.engine, declared.canonical.engine);
  }
  if (state === "done" && (newTable || dual)) {
    throw new RebuildRefusal(
      `${names.key} already holds its declaration, and ${[newTable, dual].filter(Boolean).map((o) => `${names.database}.${o!.name}`).join(" and ")} from an unfinished rebuild is still there. ` +
        `The run fails so onFailure drops it.`,
    );
  }

  return {
    state,
    names,
    declared,
    live: liveRow,
    liveCanonical,
    changes,
    ...(newTable ? { newTable } : {}),
    ...(dual ? { dual } : {}),
    ...(old ? { old } : {}),
    ...(exchangedOld ? { exchangedOld } : {}),
    exchanged,
    copied,
    replicated,
  };
}

const REPLICATED_MERGE_TREE = /^Replicated.*MergeTree$/;

/** In a Replicated database, both the table and its declaration have to replicate their rows. */
function refuseUnreplicated(names: RebuildNames, live: string, declared: string | undefined): void {
  const side = !REPLICATED_MERGE_TREE.test(live) ? `the table is ${live}` : declared !== undefined && !REPLICATED_MERGE_TREE.test(declared) ? `the declaration makes it ${declared}` : undefined;
  if (!side) return;
  throw new RebuildRefusal(
    `${names.key} is in a Replicated database and ${side}, which keeps a separate set of rows on each replica. ` +
      `The backfill runs on one replica and would copy that replica's rows alone, while the EXCHANGE runs on every replica, so the others would swap in a table without their rows. ` +
      `Rebuild it from and to a Replicated*MergeTree engine (ENGINE = ReplicatedMergeTree, with no arguments in a Replicated database), or move it to an Atomic database first.`,
  );
}

/** The Keeper path a `Replicated*MergeTree` engine names, when it names one. */
function keeperPath(engine: string | undefined): string | undefined {
  const m = /^Replicated\w*MergeTree\(\s*('(?:[^'\\]|\\.)*')/.exec(engine ?? "");
  return m?.[1];
}

/**
 * The new table is made from the declaration under another name. With an
 * explicit Keeper path that is the old table's own and has no `{uuid}` in
 * it, both tables would be the same replicated table to Keeper, and the
 * create would fail on a replica that is already there or, worse, share parts.
 */
function refuseSharedKeeperPath(names: RebuildNames, live: string | undefined, declared: string | undefined): void {
  const path = keeperPath(declared);
  if (!path || path.includes("{uuid}") || path !== keeperPath(live)) return;
  throw new RebuildRefusal(
    `${names.key} names its Keeper path explicitly, ${path}, and the new table made from the declaration would get the same path as the old table. ` +
      `Put {uuid} in the path (or leave the engine's arguments out, which defaults to '/clickhouse/tables/{uuid}/{shard}'), so each table has its own.`,
  );
}

/**
 * What the rebuild will do, independent of how far it has got: the changes,
 * the definitions on both sides, the columns copied and how writes are kept
 * up. The Plan phase publishes its digest; the gate binds a digest of this
 * plus the verification.
 */
export function rebuildPlanSubject(o: RebuildObservation, dualWrite: DualWrite): Record<string, unknown> {
  return {
    table: o.names.key,
    from: anonymous(o.liveCanonical),
    to: anonymous(o.declared.canonical),
    changes: o.changes.map((c) => ({ rule: c.rule, field: c.field, ...(c.before !== undefined ? { before: c.before } : {}), ...(c.after !== undefined ? { after: c.after } : {}) })),
    copied: o.copied,
    dualWrite,
  };
}

export const rebuildPlanDigest = (o: RebuildObservation, dualWrite: DualWrite): string => computePlanDigest("clickhouse-rebuild", rebuildPlanSubject(o, dualWrite));

/** `ident` re-exported for the steps, which quote column names. */
export { ident };
