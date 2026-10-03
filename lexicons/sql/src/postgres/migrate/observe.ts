/**
 * The expand-and-contract migration's view of the server (#3281): which
 * column of which table is migrated, how far the migration has got, and
 * what it will do.
 *
 * Every step of the Op re-observes from here rather than trusting what an
 * earlier run or step said, so the Op converges: run it again after a crash,
 * a gate or an approval, and each step finds its work done or still to do.
 * The progress is read off the table itself: its columns, the dual-write
 * trigger and its function, and the NOT NULL check, each carrying chant's
 * trailer with `migration=<key>` and a role (`./names.ts`).
 *
 * The change is found the way `chant sql plan` finds it: the declared table
 * against what the catalog read prints (`../plan/commands.ts`), which leaves
 * the working columns out. So the plan shows the change refused until the
 * switch, and the declaration held after it.
 *
 * States:
 *
 * - `migrate`: the declared column differs from the server's by a rename
 *   (SQLPG205) or a type change (SQLPG207, SQLPG208), and the switch has not
 *   run.
 * - `switched`: the switch ran; the old column is kept until its date.
 * - `done`: the server holds the declared column and nothing of the
 *   migration is left.
 *
 * Anything else is refused with a {@link MigrationRefusal}, naming what to
 * do: a table that is not there, a partition (run it on the partitioned
 * table) or an inheritance tree; no primary key to batch by; a column in the
 * partition key; a generated column; a column change the Op does not make
 * (a rename and a type change at once, a rename of a column with a default
 * or a sequence); something that uses the column and is
 * not carried over to the new one (`./carry.ts`: indexes, key, check and
 * foreign key constraints and declared views are); a publication that sends
 * it; a working object chant did not make.
 */

import type { OwnershipMarker } from "@intentius/chant/ownership";
import { computePlanDigest } from "@intentius/chant/op";
import { carriesMarker, readTrailerPairs } from "../../core/ownership";
import type { PostgresClient } from "../live/client";
import type { PostgresTarget } from "../live/bind";
import { planAgainstClient } from "../plan/commands";
import type { PgChange } from "../plan/diff";
import { PG_CLASSIFIER_RULES } from "../plan/rules";
import { qualifiedKey } from "../plan/schema";
import { POSTGRES_ENTITY_TYPES } from "../entity-types";
import type { ColumnDef } from "../entities";
import type { DeclaredPgObject } from "../apply/statements";
import { col, migrationNames, MIGRATION_TRAILER_KEY, pgName, type MigrationChange, type MigrationNames } from "./names";
import { publicationsOf, type PublicationHit } from "./replication";
import { keyText, type KeyColumn } from "./batches";
import { carriedStates, carriedSubject, discoverDependents, replaceColumn, storedType, type CarriedObject, type CarriedState, type CarriedView, type ColumnSequence, type Dependents } from "./carry";

/** A refusal: the migration cannot start, or cannot go on, for a reason a person has to act on. */
export class MigrationRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationRefusal";
  }
}

/** The rules the Op makes: a rename, and a type change with or without a rewrite in place. */
export const MIGRATION_RULES = new Set(["SQLPG205", "SQLPG207", "SQLPG208"]);

/** One column as the catalog holds it. */
export interface ServerColumn {
  attnum: number;
  name: string;
  type: string;
  notNull: boolean;
  default?: string;
  comment?: string;
  generated: boolean;
  identity: boolean;
  /** The trailer pairs of its comment, when it is a working column. */
  pairs?: Map<string, string>;
}

/** A working object other than a column: the trigger, its function, the check. */
export interface WorkingObject {
  name: string;
  comment?: string;
  pairs?: Map<string, string>;
}

export interface MigrationObservation {
  state: "migrate" | "switched" | "done";
  names: MigrationNames;
  declared: DeclaredPgObject;
  /** The declared column. */
  column: ColumnDef;
  /** The table's oid. */
  oid: string;
  /** Its primary key, which the backfill batches by: `id`, or `(tenant_id, id)`. */
  batchKey: string;
  /** The primary key's columns, in its order (`./batches.ts`). */
  keyColumns: KeyColumn[];
  /** The indexes and constraints on the old column, carried over to the new one before the switch (`./carry.ts`). */
  carried: CarriedObject[];
  /** Their working copies on the server, by working name. */
  carriedStates: Map<string, CarriedState>;
  /** The views that read the old column, made again at the switch. */
  views: CarriedView[];
  /** The sequence that gives the old column its values (identity or serial), moved to the new column at the switch. */
  sequence?: ColumnSequence;
  /** The table is partitioned: every step runs on it, and its partitions follow. */
  partitioned: boolean;
  columns: Map<string, ServerColumn>;
  /** The column the values come from, while there is one. */
  source?: ServerColumn;
  newColumn?: ServerColumn;
  old?: ServerColumn;
  trigger?: WorkingObject;
  fn?: WorkingObject;
  check?: WorkingObject & { validated: boolean };
  /** The changes the classifier reports for the column. */
  changes: PgChange[];
  /** The expression the new column's value is computed with, over the old row's columns. */
  expression: string;
  publications: PublicationHit[];
  major: number;
}

export interface ObserveInput {
  client: PostgresClient;
  target: PostgresTarget;
  declared: DeclaredPgObject;
  column: string;
  marker?: OwnershipMarker;
  /** Every object the build declares; the views the switch makes again come from here. Default: the table alone. */
  objects?: readonly DeclaredPgObject[];
  /** The type change's expression, over the old row's columns. Default: `CAST(<column> AS <declared type>)`. */
  using?: string;
  /** The major the build targets; the server's own wins. */
  major?: number;
}

/** The declared table with the given key (`schema.table`) or export name, or a refusal naming what is declared. */
export function declaredTable(declared: readonly DeclaredPgObject[], key: string): DeclaredPgObject {
  const found = declared.find((o) => o.name === key || o.exportName === key);
  if (!found) {
    throw new MigrationRefusal(`${key} is not declared in the build. Declared tables: ${declared.filter((o) => o.type === POSTGRES_ENTITY_TYPES.table).map((o) => o.name).join(", ") || "none"}`);
  }
  if (found.type !== POSTGRES_ENTITY_TYPES.table) throw new MigrationRefusal(`${key} is a ${found.type}, and the migration Op migrates a table's column`);
  return found;
}

const pairsOf = (comment: string | undefined): Map<string, string> | undefined => {
  const p = readTrailerPairs(comment);
  return p?.has(MIGRATION_TRAILER_KEY) ? p : undefined;
};

async function serverColumns(client: PostgresClient, oid: string): Promise<Map<string, ServerColumn>> {
  const rows = await client.query<{ attnum: number; name: string; type: string; notnull: boolean; dflt: string | null; comment: string | null; generated: string; identity: string }>(
    `SELECT a.attnum, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) AS dflt, pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
            a.attgenerated::text AS generated, a.attidentity::text AS identity
     FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [oid],
  );
  return new Map(
    rows.map((r) => {
      const comment = r.comment ?? undefined;
      const pairs = pairsOf(comment);
      return [
        r.name,
        {
          attnum: Number(r.attnum),
          name: r.name,
          type: r.type,
          notNull: r.notnull,
          ...(r.dflt !== null ? { default: r.dflt } : {}),
          ...(comment !== undefined ? { comment } : {}),
          generated: r.generated !== "",
          identity: r.identity !== "",
          ...(pairs ? { pairs } : {}),
        },
      ];
    }),
  );
}

/** The server's major, from `server_version_num`. */
export async function serverMajor(client: PostgresClient): Promise<number> {
  const [row] = await client.query<{ v: string }>("SELECT pg_catalog.current_setting('server_version_num') AS v");
  return Math.floor(Number(row?.v ?? "0") / 10000);
}

/**
 * A working object is this migration's only when it carries this project's
 * marker, names this migration and has the role its name says. One that has
 * the name and not the marker is somebody else's, and the migration stops
 * rather than drop or fill it.
 */
function own<T extends { name: string; comment?: string; pairs?: Map<string, string> }>(o: T | undefined, names: MigrationNames, role: string, what: string, marker: OwnershipMarker | undefined): T | undefined {
  if (!o) return undefined;
  if (!carriesMarker(o.comment, marker) || o.pairs?.get(MIGRATION_TRAILER_KEY) !== names.key || o.pairs.get("role") !== role) {
    throw new MigrationRefusal(
      `${names.schema}.${names.table}: ${what} ${o.name} exists and is not this migration's (its comment carries no migration=${names.key} role=${role} marker for this project). ` +
        `The migration uses that name, so it stops rather than touch it; rename or drop it by hand.`,
    );
  }
  return o;
}

/** The change the declaration makes to the column, as a plan against the server classifies it. */
async function columnChanges(input: ObserveInput): Promise<{ changes: PgChange[]; major?: number }> {
  const { declared } = input;
  const plan = await planAgainstClient(input.client, input.target, [{ key: declared.exportName, canonical: declared.canonical }], input.major !== undefined ? { major: input.major } : {});
  const key = qualifiedKey(declared.canonical);
  const changes = plan.diff.changes.filter((c) => c.object === key && (c.field === `columns.${input.column}` || c.field.startsWith(`columns.${input.column}.`)));
  return { changes, ...(plan.major !== undefined ? { major: plan.major } : {}) };
}

const ruleText = (c: PgChange) => `${c.rule} ${PG_CLASSIFIER_RULES[c.rule].title} (${c.field}${c.before !== undefined || c.after !== undefined ? `: ${c.before ?? "-"} -> ${c.after ?? "-"}` : ""})`;

interface RelationRow {
  oid: string;
  kind: string;
  partition: boolean;
  parents: string | null;
  children: string | null;
  partkey: string | null;
  partattrs: number[] | null;
}

/**
 * The tables the Op migrates: an ordinary table, and a partitioned one, whose
 * partitions take every column change, trigger, check and `NOT NULL` from it.
 * A partition is migrated through its partitioned table. Inheritance (not
 * partitioning) is refused: a write to a child table does not fire its
 * parent's trigger, so the dual write would miss it, and a child's indexes
 * and constraints are its own, which the carry-over does not read.
 */
function refuseRelation(where: string, rel: RelationRow): void {
  if (rel.partition) {
    throw new MigrationRefusal(`${where} is a partition of ${rel.parents}. A partition's columns are its partitioned table's: run the Op on ${rel.parents}, which migrates every partition.`);
  }
  if (rel.parents) {
    throw new MigrationRefusal(
      `${where} inherits from ${rel.parents}. An inherited column is changed through its parent, and the Op does not migrate inheritance trees: ` +
        `a write to a child table does not fire its parent's dual-write trigger, and each child's indexes and constraints are its own. Migrate by hand, or move to declarative partitioning (chant #3333).`,
    );
  }
  if (rel.kind === "r" && rel.children) {
    throw new MigrationRefusal(
      `${where} has inheritance children (${rel.children}). The Op does not migrate inheritance trees: a write to a child table does not fire the parent's dual-write trigger, ` +
        `so the new column would miss it, and each child's indexes and constraints are its own. Migrate by hand, or move to declarative partitioning (chant #3333).`,
    );
  }
  if (rel.kind !== "r" && rel.kind !== "p") throw new MigrationRefusal(`${where} is not a table (relkind ${rel.kind}); the migration Op migrates a table's column`);
}

/** Observe the migration of the declared table's column on the server. */
export async function observeMigration(input: ObserveInput): Promise<MigrationObservation> {
  const { client, declared, marker } = input;
  const schema = declared.canonical.schema ?? input.target.defaultSchema;
  const table = declared.canonical.name;
  const where = `${schema}.${table}`;
  const [rel] = await client.query<RelationRow>(
    `SELECT c.oid::text AS oid, c.relkind::text AS kind, c.relispartition AS partition,
            (SELECT pg_catalog.string_agg(i.inhparent::pg_catalog.regclass::text, ', ') FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid) AS parents,
            (SELECT pg_catalog.string_agg(i.inhrelid::pg_catalog.regclass::text, ', ' ORDER BY i.inhrelid::pg_catalog.regclass::text) FROM pg_catalog.pg_inherits i WHERE i.inhparent = c.oid) AS children,
            CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partkey,
            (SELECT p.partattrs::int2[] FROM pg_catalog.pg_partitioned_table p WHERE p.partrelid = c.oid) AS partattrs
     FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass($1)`,
    [`${col(schema)}.${col(table)}`],
  );
  if (!rel) throw new MigrationRefusal(`${where} is not on the server, so there is no column to migrate; the applier creates it`);
  refuseRelation(where, rel);
  const declaredColumns = (declared.props.columns as ColumnDef[] | undefined) ?? [];
  const column = declaredColumns.find((c) => c.name === input.column);
  if (!column) throw new MigrationRefusal(`${where} declares no column ${input.column}. Declared columns: ${declaredColumns.map((c) => c.name).join(", ") || "none"}`);
  const columns = await serverColumns(client, rel.oid);
  const { changes, major: planned } = await columnChanges(input);
  const major = planned ?? (await serverMajor(client));

  // The change, and the column it comes from: from the plan while it is
  // pending, else from the old column this migration kept after its switch.
  const rename = changes.find((c) => c.rule === "SQLPG205");
  const typeChange = changes.find((c) => c.rule === "SQLPG206" || c.rule === "SQLPG207" || c.rule === "SQLPG208");
  const key = `${schema}.${table}.${input.column}`;
  const mine = [...columns.values()].filter((c) => c.pairs?.get(MIGRATION_TRAILER_KEY) === key);
  const keptOld = mine.find((c) => c.pairs!.get("role") === "old");
  let change: MigrationChange = "type";
  let sourceName = input.column;
  if (rename) {
    change = "rename";
    sourceName = String(rename.before);
  } else if (keptOld && keptOld.name !== pgName(`${input.column}__chant_old`)) {
    change = "rename";
    sourceName = keptOld.name;
  }
  const names = migrationNames(schema, table, input.column, change, sourceName);

  // Whatever the state, a working object under a migration name, or with this
  // migration's key, is this migration's or it is refused.
  for (const c of mine) own(c, names, String(c.pairs!.get("role")), "column", marker);
  const working = (name: string) => (change === "type" || columns.get(name)?.pairs ? columns.get(name) : undefined);
  const newColumn = own(working(names.newColumn), names, "new", "column", marker);
  const old = own(working(names.oldColumn), names, "old", "column", marker);
  const [trigRow] = await client.query<{ name: string; comment: string | null }>(
    "SELECT t.tgname AS name, pg_catalog.obj_description(t.oid, 'pg_trigger') AS comment FROM pg_catalog.pg_trigger t WHERE t.tgrelid = $1::oid AND t.tgname = $2",
    [rel.oid, names.trigger],
  );
  const [fnRow] = await client.query<{ name: string; comment: string | null }>(
    "SELECT p.proname AS name, pg_catalog.obj_description(p.oid, 'pg_proc') AS comment FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 AND p.pronargs = 0",
    [schema, names.fn],
  );
  const [checkRow] = await client.query<{ name: string; comment: string | null; validated: boolean }>(
    "SELECT c.conname AS name, pg_catalog.obj_description(c.oid, 'pg_constraint') AS comment, c.convalidated AS validated FROM pg_catalog.pg_constraint c WHERE c.conrelid = $1::oid AND c.conname = $2",
    [rel.oid, names.check],
  );
  const asObject = (r: { name: string; comment: string | null } | undefined): WorkingObject | undefined =>
    r ? { name: r.name, ...(r.comment !== null ? { comment: r.comment } : {}), ...(pairsOf(r.comment ?? undefined) ? { pairs: pairsOf(r.comment ?? undefined)! } : {}) } : undefined;
  const trigger = own(asObject(trigRow), names, "dual", "trigger", marker);
  const fn = own(asObject(fnRow), names, "dual", "function", marker);
  const checkObj = own(asObject(checkRow), names, "nn", "check constraint", marker);
  const check = checkObj ? { ...checkObj, validated: checkRow!.validated } : undefined;

  const migrating = rename !== undefined || (typeChange !== undefined && typeChange.rule !== "SQLPG206");
  let state: MigrationObservation["state"];
  if (old) {
    if (migrating) {
      throw new MigrationRefusal(
        `${where}.${input.column} differs from its declaration again, and the old column of the last migration is still kept as ${names.oldColumn}. ` +
          `Run the contract (its gate, then the Contract phase) before migrating the column again.`,
      );
    }
    state = "switched";
  } else if (migrating) {
    state = "migrate";
  } else if (changes.length === 0) {
    if (newColumn || trigger || fn || check) {
      throw new MigrationRefusal(
        `${where}.${input.column} already holds its declaration, and ${[newColumn && `column ${newColumn.name}`, trigger && `trigger ${trigger.name}`, fn && `function ${fn.name}`, check && `check ${check.name}`].filter(Boolean).join(", ")} ` +
          `from an unfinished migration is still there. The run fails so onFailure drops it.`,
      );
    }
    state = "done";
  } else {
    throw new MigrationRefusal(
      `${where}.${input.column} has no change the migration Op makes: ${changes.map(ruleText).join("; ")}. ` +
        `The applier makes these in place (ApplyOp with target "postgres").`,
    );
  }

  const source = state === "migrate" ? columns.get(sourceName) : undefined;
  let batchKey = "";
  let keyColumns: KeyColumn[] = [];
  let dependents: Pick<Dependents, "carried" | "views" | "sequence"> = { carried: [], views: [] };
  let states = new Map<string, CarriedState>();
  let expression = col(sourceName);
  let publications: PublicationHit[] = [];
  if (state === "migrate") {
    if (!source) throw new MigrationRefusal(`${where}: the column ${sourceName} the values come from is not on the server`);
    ({ batchKey, keyColumns, dependents } = await refuseUnsupported(input, names, rel, source, column, changes, rename !== undefined, typeChange));
    states = await carriedStates(
      client,
      dependents.carried,
      (comment) => {
        const pairs = pairsOf(comment);
        if (!pairs) return comment === undefined ? "none" : "theirs";
        return pairs.get(MIGRATION_TRAILER_KEY) === names.key && pairs.get("role") === "carry" && carriesMarker(comment, marker) ? "ours" : "theirs";
      },
      (what) => {
        throw new MigrationRefusal(
          `${where}: ${what} exists and is not this migration's (its comment carries no migration=${names.key} role=carry marker for this project). The migration uses that name, so it stops rather than touch it; rename or drop it by hand.`,
        );
      },
    );
    if (change === "type") {
      expression = input.using ?? `CAST(${col(sourceName)} AS ${storedType(column.type)})`;
      if (expression.includes("$chant$")) throw new MigrationRefusal(`${where}: the using expression may not contain $chant$, which quotes the dual-write function's body`);
    } else if (input.using !== undefined) {
      throw new MigrationRefusal(`${where}.${input.column} is a rename of ${sourceName}, which copies the value as it is; using is for a type change`);
    }
    // The declared type as the classifier compared it: the server's spelling (character varying(10), not varchar(10)).
    const serial = storedType(column.type) !== column.type;
    const expectedType = change === "type" ? (serial ? storedType(column.type)! : String(typeChange?.after ?? column.type)) : source.type;
    if (newColumn && newColumn.type !== expectedType) {
      throw new MigrationRefusal(
        `${where}: ${newColumn.name} was made as ${newColumn.type}, from another declaration of ${input.column} (now ${column.type}). The run fails so onFailure drops it, and the next run starts again from the current declaration.`,
      );
    }
    publications = await publicationsOf(client, schema, table, sourceName, major);
    if (publications.length > 0) {
      throw new MigrationRefusal(
        `${where}.${sourceName} is sent by logical replication publication(s) ${publications.map((p) => `${p.name}${p.allColumns ? " (every column)" : ""}`).join(", ")}. ` +
          `A subscriber applies changes by column name and must have every column the publisher sends, so the column the expand adds would stop the subscriber's apply at the first backfilled row, ` +
          `and the switch would need the same change on the subscriber at the same moment (https://www.postgresql.org/docs/18/logical-replication-col-lists.html). ` +
          `Leave the column out of the publication with a column list (15 and later), or migrate the subscriber's table as well and run this Op on a table no publication sends. ` +
          `A migration of the publisher and the subscriber together is chant #3332.`,
      );
    }
  }

  return {
    state,
    names,
    declared,
    column,
    oid: rel.oid,
    batchKey,
    keyColumns,
    carried: dependents.carried,
    carriedStates: states,
    views: dependents.views,
    ...(dependents.sequence ? { sequence: dependents.sequence } : {}),
    partitioned: rel.kind === "p",
    columns,
    ...(source ? { source } : {}),
    ...(newColumn ? { newColumn } : {}),
    ...(old ? { old } : {}),
    ...(trigger ? { trigger } : {}),
    ...(fn ? { fn } : {}),
    ...(check ? { check } : {}),
    changes,
    expression,
    publications,
    major,
  };
}

/** The checks that hold only while there is something to migrate. Returns the batch key and what the Op carries over. */
async function refuseUnsupported(
  input: ObserveInput,
  names: MigrationNames,
  rel: RelationRow,
  source: ServerColumn,
  column: ColumnDef,
  changes: readonly PgChange[],
  rename: boolean,
  typeChange: PgChange | undefined,
): Promise<{ batchKey: string; keyColumns: KeyColumn[]; dependents: Pick<Dependents, "carried" | "views" | "sequence"> }> {
  const where = `${names.schema}.${names.table}`;
  const oid = rel.oid;
  if (rename && typeChange) {
    throw new MigrationRefusal(
      `${where}: ${source.name} is renamed to ${names.column} and its type changes (${typeChange.before} -> ${typeChange.after}) in one declaration. ` +
        `Migrate one at a time: declare the rename with the old type, run the Op to its end, then change the type. ` +
        `(In one run both names would stay written until the contract, which needs a conversion back to the old type for writers of the new name; chant #3331.)`,
    );
  }
  if (rename && (source.default !== undefined || column.default !== undefined)) {
    throw new MigrationRefusal(
      `${where}: ${source.name} has a default (${source.default ?? column.default}). During a rename both columns are written, each from the other, ` +
        `and a row inserted by a writer that names one column would get the other's default, which the trigger cannot tell from a value it was given. ` +
        `Drop the default first (the applier does), rename, then declare it again. A rename that keeps its default needs versioned views (chant #3331).`,
    );
  }
  if (source.generated || (column.generated && column.generated.kind !== "identity")) {
    throw new MigrationRefusal(
      `${where}.${source.name} is a generated column. There is no expand and contract for one: Postgres cannot make an existing column generated, so the new column could only be added generated, ` +
        `which computes every row under ACCESS EXCLUSIVE (a stored one) or needs no migration (a virtual one stores nothing). The applier makes the change in place (SQLPG207), in a maintenance window for a stored column.`,
    );
  }
  const unsupported = changes.filter((c) => /\.(generated|identity|collate|storage)$/.test(c.field));
  if (unsupported.length > 0) {
    throw new MigrationRefusal(`${where}.${names.column}: a change to its collation, storage, generation or identity (${unsupported.map(ruleText).join("; ")}) is not one the Op makes; the applier makes it in place.`);
  }
  if (rel.kind === "p" && ((rel.partattrs ?? []).map(Number).includes(source.attnum) || (rel.partkey !== null && replaceColumn(rel.partkey, source.name, `${source.name}_`) !== rel.partkey))) {
    throw new MigrationRefusal(
      `${where}.${source.name} is in the partition key (${rel.partkey}). A changed partition key would move rows between partitions, which no trigger can do; the Op migrates a partitioned table's other columns.`,
    );
  }
  const dependents = await discoverDependents({
    client: input.client,
    names,
    oid,
    attnum: source.attnum,
    objects: input.objects ?? [input.declared],
    declared: input.declared,
    defaultSchema: input.target.defaultSchema,
    partitioned: rel.kind === "p",
  });
  if (dependents.refused.length > 0) {
    throw new MigrationRefusal(
      `${where}.${source.name} is used by what the migration Op does not carry over to the new column: ${dependents.refused.join("; ")}. ` +
        `The old column could not be dropped while they use it.`,
    );
  }
  const keys = await input.client.query<KeyColumn>(
    `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_catalog.pg_constraint c, pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_catalog.pg_attribute a ON a.attnum = k.attnum
     WHERE c.conrelid = $1::oid AND c.contype = 'p' AND a.attrelid = c.conrelid ORDER BY k.ord`,
    [oid],
  );
  if (keys.length === 0) {
    throw new MigrationRefusal(
      `${where} has no primary key. The backfill fills the new column in batches of the primary key's ranges, the same rows in every run, which needs one; declare a primary key first.`,
    );
  }
  return { batchKey: keyText(keys), keyColumns: keys, dependents: { carried: dependents.carried, views: dependents.views, ...(dependents.sequence ? { sequence: dependents.sequence } : {}) } };
}

/**
 * What the migration will do, independent of how far it has got: the
 * change, the column on both sides, the expression, the batch key. The
 * Plan phase publishes its digest; the gate binds a digest of this and the
 * verification.
 */
export function migrationPlanSubject(o: MigrationObservation): Record<string, unknown> {
  return {
    migration: o.names.key,
    change: o.names.change,
    from: o.source ? { name: o.source.name, type: o.source.type, notNull: o.source.notNull, default: o.source.default ?? null } : null,
    to: { name: o.column.name, type: o.column.type ?? null, notNull: o.column.notNull === true, default: o.column.default ?? null, comment: o.column.comment ?? null },
    expression: o.expression,
    batchKey: o.batchKey,
    rules: o.changes.map((c) => c.rule),
    ...(o.carried.length > 0 || o.views.length > 0 || o.sequence ? { dependents: carriedSubject(o) } : {}),
  };
}

export const migrationPlanDigest = (o: MigrationObservation): string => computePlanDigest("postgres-migration", migrationPlanSubject(o));

export { MIGRATION_TRAILER_KEY };
