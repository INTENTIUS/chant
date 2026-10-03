/**
 * The expand-and-contract migration's steps (#3281), each one convergent: it
 * observes the server (`./observe.ts`), does what is left of its own part,
 * and reports. Running a step twice does what running it once did.
 *
 * Every statement runs in a transaction with `lock_timeout` and
 * `statement_timeout` set by `SET LOCAL`, as the applier's do
 * (`../apply/apply.ts`), and with the declarations' schema as its
 * `search_path`. A statement that waits longer than the lock timeout behind
 * another session gives up instead of queueing every later query behind it,
 * and its transaction is tried again a few times before the step fails.
 *
 * The backfill and the verification are in `./backfill.ts`; the Op that
 * orders the steps is `./op.ts`.
 */

import type { OwnershipMarker } from "@intentius/chant/ownership";
import { computePlanDigest } from "@intentius/chant/op";
import { carriesMarker, readTrailerPairs, stampedComment } from "../../core/ownership";
import { PostgresQueryError, type PostgresClient } from "../live/client";
import type { PostgresTarget } from "../live/bind";
import { pgString, type DeclaredPgObject } from "../apply/statements";
import { quoteIdent } from "../keywords";
import { col, migrationNames, MIGRATION_TRAILER_KEY, type MigrationNames } from "./names";
import { MigrationRefusal, observeMigration, type MigrationObservation } from "./observe";
import { postgresReceiptStore, receiptAddress } from "./receipts";
import type { ReplicationLagBound } from "./replication";
import { addCarriedConstraint, carriedNotReady, carriedSwitchStatements, requiresNotNull, type CarriedObject } from "./carry";

/** What every step is given. */
export interface MigrationRun {
  client: PostgresClient;
  target: PostgresTarget;
  /** The declared table. */
  declared: DeclaredPgObject;
  /** Every object the build declares: the switch makes the views that read the column again from theirs. */
  objects?: readonly DeclaredPgObject[];
  /** The declared column being migrated. */
  column: string;
  /** The type change's expression over the old row's columns. */
  using?: string;
  /** This project's ownership marker, stamped on every working object. */
  marker?: OwnershipMarker;
  /** The major the build targets. */
  major?: number;
  /** The width of one batch's key range. */
  batchSize: number;
  /** How long the old column is kept after the switch, in milliseconds. */
  retainMs: number;
  /** The bound on replica lag the backfill pauses for, or false for no check. */
  replicationLag: ReplicationLagBound | false;
  /** `lock_timeout` for every statement, in ms. */
  lockTimeoutMs: number;
  /** `statement_timeout` for a statement that changes only the catalog, in ms. */
  statementTimeoutMs: number;
  /** How many times a transaction that hit the lock timeout is tried again. Default: 5. */
  lockRetries?: number;
  log: (line: string) => void;
  signal?: AbortSignal;
  /** The run's id, recorded on the receipts it writes. */
  runId?: string;
}

export const observe = (run: MigrationRun): Promise<MigrationObservation> =>
  observeMigration({
    client: run.client,
    target: run.target,
    declared: run.declared,
    column: run.column,
    ...(run.objects ? { objects: run.objects } : {}),
    ...(run.marker ? { marker: run.marker } : {}),
    ...(run.using !== undefined ? { using: run.using } : {}),
    ...(run.major !== undefined ? { major: run.major } : {}),
  });

/** The server's clock, in milliseconds: the retention is the server's time, not this machine's. */
export async function serverNow(client: PostgresClient): Promise<number> {
  const [row] = await client.query<{ t: string }>("SELECT (EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()) * 1000)::bigint::text AS t");
  return Number(row?.t ?? Date.now());
}

const SQLSTATE_LOCK_NOT_AVAILABLE = "55P03";
const ms = (n: number) => `'${Math.max(0, Math.floor(n))}ms'`;

/**
 * Run `body` in one transaction under the run's timeouts (`scan` lifts the
 * statement timeout, for a statement that reads every row) and the
 * declarations' schema as `search_path`. A lock timeout rolls it back and
 * tries again, waiting a little longer each time; any other error rolls it
 * back and is thrown.
 */
export async function inTransaction<T>(run: MigrationRun, body: (exec: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>, opts: { scan?: boolean } = {}): Promise<T> {
  const retries = run.lockRetries ?? 5;
  for (let attempt = 0; ; attempt++) {
    run.signal?.throwIfAborted();
    await run.client.query("BEGIN");
    try {
      await run.client.query(`SET LOCAL lock_timeout = ${ms(run.lockTimeoutMs)}`);
      await run.client.query(`SET LOCAL statement_timeout = ${ms(opts.scan ? 0 : run.statementTimeoutMs)}`);
      await run.client.query("SELECT pg_catalog.set_config('search_path', $1, true)", [quoteIdent(run.target.defaultSchema)]);
      const out = await body(async (sql, params) => {
        run.signal?.throwIfAborted();
        run.log(sql);
        return run.client.query(sql, params);
      });
      await run.client.query("COMMIT");
      return out;
    } catch (err) {
      await run.client.query("ROLLBACK").catch(() => undefined);
      if (run.signal?.aborted) throw err;
      if (err instanceof PostgresQueryError && err.code === SQLSTATE_LOCK_NOT_AVAILABLE && attempt < retries) {
        run.log(`-- lock_timeout ${run.lockTimeoutMs}ms: another session holds a lock this transaction needs; trying again (${attempt + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        continue;
      }
      if (err instanceof PostgresQueryError && err.code === SQLSTATE_LOCK_NOT_AVAILABLE) {
        throw new PostgresQueryError(`${err.message} (lock_timeout ${run.lockTimeoutMs}ms, tried ${retries + 1} times: another session kept a lock this step needs; SQLSTATE 55P03)`, err.code);
      }
      throw err;
    }
  }
}

/**
 * Run one statement outside any transaction (`CREATE INDEX CONCURRENTLY`,
 * `DROP INDEX CONCURRENTLY`), with `lock_timeout` and `statement_timeout`
 * set for the session first (none for a scan). A lock timeout leaves a
 * `CONCURRENTLY` build's index INVALID: `cleanup` drops it, and the statement
 * is tried again as a transaction is.
 */
export async function outsideTransaction(run: MigrationRun, sql: string, opts: { scan?: boolean; cleanup?: () => Promise<void> } = {}): Promise<void> {
  const retries = run.lockRetries ?? 5;
  for (let attempt = 0; ; attempt++) {
    run.signal?.throwIfAborted();
    await run.client.query(`SET lock_timeout = ${ms(run.lockTimeoutMs)}`);
    await run.client.query(`SET statement_timeout = ${ms(opts.scan ? 0 : run.statementTimeoutMs)}`);
    try {
      run.log(sql);
      await run.client.query(sql);
      return;
    } catch (err) {
      await opts.cleanup?.().catch(() => undefined);
      if (run.signal?.aborted) throw err;
      if (err instanceof PostgresQueryError && err.code === SQLSTATE_LOCK_NOT_AVAILABLE && attempt < retries) {
        run.log(`-- lock_timeout ${run.lockTimeoutMs}ms: another session holds a lock this statement needs; trying again (${attempt + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

/** A working object's role: the new column, the old one after the switch, the dual write, the NOT NULL proof, a carried index or constraint. */
export type WorkingRole = "new" | "old" | "dual" | "nn" | "carry";

/** The trailer pairs a working object carries besides the marker. */
const working = (names: MigrationNames, role: WorkingRole, extra: Record<string, string> = {}) => ({ [MIGRATION_TRAILER_KEY]: names.key, role, ...extra });

/** A working object's comment: a description, then chant's trailer. */
export const workingComment = (names: MigrationNames, marker: OwnershipMarker | undefined, role: WorkingRole, text: string, extra: Record<string, string> = {}): string =>
  stampedComment(`chant migration of ${names.key}: ${text}`, marker, working(names, role, extra));

const commentOnColumn = (names: MigrationNames, column: string, text: string | undefined) =>
  `COMMENT ON COLUMN ${names.qualifiedTable}.${col(column)} IS ${text === undefined ? "NULL" : pgString(text)}`;

// ── expand ─────────────────────────────────────────────────────────────

export interface ExpandResult {
  state: MigrationObservation["state"];
  /** The column being filled. */
  column: string;
  added: boolean;
}

/** The new column's type: the declared one, with its collation when it declares one. */
const newColumnType = (o: MigrationObservation): string => `${o.names.change === "rename" ? o.source!.type : o.column.type}${o.column.collate ? ` COLLATE ${o.column.collate}` : ""}`;

/**
 * Expand: add the new column, nullable and with no default, which changes
 * only the catalog (SQLPG201), marked as this migration's. Its NOT NULL and
 * default are set at the switch, once every row has a value.
 */
export async function expand(run: MigrationRun): Promise<ExpandResult> {
  const o = await observe(run);
  const n = o.names;
  if (o.state !== "migrate") return { state: o.state, column: n.column, added: false };
  if (o.newColumn) {
    run.log(`-- ${n.schema}.${n.table}.${n.newColumn} is there`);
    return { state: o.state, column: n.newColumn, added: false };
  }
  await inTransaction(run, async (exec) => {
    await exec(`ALTER TABLE ${n.qualifiedTable} ADD COLUMN ${col(n.newColumn)} ${newColumnType(o)}`);
    await exec(commentOnColumn(n, n.newColumn, workingComment(n, run.marker, "new", n.change === "rename" ? `the new name of ${n.source}` : `${n.column} as ${o.column.type}`)));
  });
  return { state: o.state, column: n.newColumn, added: true };
}

// ── dual write ─────────────────────────────────────────────────────────

/**
 * The dual-write trigger function's body.
 *
 * A type change: the new column is computed from the row on every insert and
 * update, with the same expression the backfill uses, so a write the backfill
 * already passed is not missed. A value the expression cannot convert fails
 * the write, as the declared column would.
 *
 * A rename: both columns are kept equal, each from the other, so old writers
 * (the old name) and new ones (the new name) both work until the contract.
 * An insert takes the new column's value when it is given and the old one's
 * otherwise; an update takes whichever of the two it changed.
 */
export function dualWriteBody(o: Pick<MigrationObservation, "names" | "expression">): string {
  const n = o.names;
  const nw = `NEW.${col(n.newColumn)}`;
  const src = `NEW.${col(n.source)}`;
  if (n.change === "type") {
    return [`BEGIN`, `  ${nw} := (SELECT ${o.expression} FROM (SELECT NEW.*) AS ${col(n.table)});`, `  RETURN NEW;`, `END`].join("\n");
  }
  return [
    `BEGIN`,
    `  IF TG_OP = 'INSERT' THEN`,
    `    IF ${nw} IS NULL THEN ${nw} := ${src}; ELSE ${src} := ${nw}; END IF;`,
    `  ELSIF ${nw} IS DISTINCT FROM OLD.${col(n.newColumn)} THEN`,
    `    ${src} := ${nw};`,
    `  ELSE`,
    `    ${nw} := ${src};`,
    `  END IF;`,
    `  RETURN NEW;`,
    `END`,
  ].join("\n");
}

/** The statements that start the dual write: the function, the trigger, their comments. */
export function dualWriteStatements(o: Pick<MigrationObservation, "names" | "expression">, marker: OwnershipMarker | undefined, defaultSchema: string): string[] {
  const n = o.names;
  return [
    `CREATE OR REPLACE FUNCTION ${n.qualifiedFn}() RETURNS trigger LANGUAGE plpgsql SET search_path = ${quoteIdent(defaultSchema)} AS $chant$\n${dualWriteBody(o)}\n$chant$`,
    `COMMENT ON FUNCTION ${n.qualifiedFn}() IS ${pgString(workingComment(n, marker, "dual", "keeps the new column written"))}`,
    `DROP TRIGGER IF EXISTS ${col(n.trigger)} ON ${n.qualifiedTable}`,
    `CREATE TRIGGER ${col(n.trigger)} BEFORE INSERT OR UPDATE ON ${n.qualifiedTable} FOR EACH ROW EXECUTE FUNCTION ${n.qualifiedFn}()`,
    `COMMENT ON TRIGGER ${col(n.trigger)} ON ${n.qualifiedTable} IS ${pgString(workingComment(n, marker, "dual", "keeps the new column written"))}`,
  ];
}

export interface DualWriteResult {
  state: MigrationObservation["state"];
  trigger: string;
  created: boolean;
}

/**
 * Dual write: the trigger that keeps the new column written from here on.
 * `CREATE TRIGGER` takes SHARE ROW EXCLUSIVE on the table, which waits for
 * running writes; the lock timeout bounds that wait.
 */
export async function startDualWrite(run: MigrationRun): Promise<DualWriteResult> {
  const o = await observe(run);
  const n = o.names;
  if (o.state !== "migrate") return { state: o.state, trigger: n.trigger, created: false };
  if (!o.newColumn) throw new MigrationRefusal(`${n.key}: the new column is not there yet; the Expand phase adds it`);
  if (o.trigger && o.fn) return { state: o.state, trigger: n.trigger, created: false };
  await inTransaction(run, async (exec) => {
    for (const sql of dualWriteStatements(o, run.marker, run.target.defaultSchema)) await exec(sql);
  });
  return { state: o.state, trigger: n.trigger, created: true };
}

// ── carry over ─────────────────────────────────────────────────────────

export interface CarryResult {
  state: MigrationObservation["state"];
  /** Working copies made in this run. */
  built: number;
  /** Working copies already there and ready. */
  ready: number;
  /** Views the switch makes again. */
  views: number;
  /** Each carried object, `<kind> <name> -> <name after the switch>`. */
  carried: string[];
}

const qualifiedIndex = (c: CarriedObject, name: string) => `${quoteIdent(c.schema)}.${quoteIdent(name)}`;

/**
 * Carry over: make each index and constraint on the old column again on the
 * new one, under a working name (`./carry.ts`). An index (a key's too) is
 * built `CONCURRENTLY`, outside any transaction, so writes go on; a build
 * that failed or was killed leaves an INVALID index, which the next run
 * drops and builds again. A check or a foreign key is added `NOT VALID` with
 * its comment in one transaction, then validated under SHARE UPDATE
 * EXCLUSIVE. Runs after the backfill, so every row has its new value.
 */
export async function carryOver(run: MigrationRun): Promise<CarryResult> {
  const o = await observe(run);
  const result: CarryResult = { state: o.state, built: 0, ready: 0, views: o.views.length, carried: [] };
  if (o.state !== "migrate") return result;
  const n = o.names;
  if (!o.newColumn || !o.trigger) throw new MigrationRefusal(`${n.key}: the new column and its dual write are not there; the Expand and Dual write phases make them`);
  // Indexes first: a foreign key onto the new column needs the working unique index it references.
  const indexesFirst = [...o.carried].sort((a, b) => Number(a.kind !== "index" && a.kind !== "key") - Number(b.kind !== "index" && b.kind !== "key"));
  for (const c of indexesFirst) {
    result.carried.push(`${c.kind} ${c.tableName}.${c.name} -> ${c.target}`);
    const state = o.carriedStates.get(c.working);
    const comment = workingComment(n, run.marker, "carry", `${c.kind} ${c.name} on the new column`, { of: c.name });
    if (c.kind === "index" || c.kind === "key") {
      const ident = qualifiedIndex(c, c.working);
      if (state?.ready) {
        if (!state.marked) await inTransaction(run, (exec) => exec(`COMMENT ON INDEX ${ident} IS ${pgString(comment)}`));
        result.ready++;
        continue;
      }
      if (state?.present) await outsideTransaction(run, `DROP INDEX CONCURRENTLY IF EXISTS ${ident}`);
      const dropInvalid = async () => {
        const [row] = await run.client.query<{ invalid: boolean }>("SELECT NOT i.indisvalid AS invalid FROM pg_catalog.pg_index i WHERE i.indexrelid = pg_catalog.to_regclass($1)", [ident]);
        if (row?.invalid) await run.client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${ident}`);
      };
      await outsideTransaction(run, c.definition, { scan: true, cleanup: dropInvalid });
      await inTransaction(run, (exec) => exec(`COMMENT ON INDEX ${ident} IS ${pgString(comment)}`));
      result.built++;
      continue;
    }
    if (state?.ready) {
      result.ready++;
      continue;
    }
    if (!state?.present) {
      await inTransaction(run, async (exec) => {
        await exec(addCarriedConstraint(c));
        await exec(`COMMENT ON CONSTRAINT ${quoteIdent(c.working)} ON ${c.table} IS ${pgString(comment)}`);
      });
    }
    if (c.validated) await inTransaction(run, (exec) => exec(`ALTER TABLE ${c.table} VALIDATE CONSTRAINT ${quoteIdent(c.working)}`), { scan: true });
    result.built++;
  }
  if (o.carried.length > 0 || o.views.length > 0) {
    run.log(`-- ${n.key}: ${o.carried.length} index(es) and constraint(s) on the new column (${result.built} made, ${result.ready} already there); ${o.views.length} view(s) made again at the switch`);
  }
  return result;
}

// ── switch ─────────────────────────────────────────────────────────────

export interface SwitchResult {
  state: MigrationObservation["state"];
  switched: boolean;
  /** Where the old column is kept, and until when. */
  oldColumn?: string;
  retainUntil?: string;
}

/**
 * The statements of the switch's one transaction. A type change swaps the
 * columns by name, so readers of the column read the new one from the
 * commit on, and stops writing the old one, which is kept as it was. A
 * rename has nothing to swap: readers move to the new name in the
 * application, and the trigger keeps both columns written until the
 * contract, so a reader still on the old name goes on working.
 */
export function switchStatements(o: MigrationObservation, marker: OwnershipMarker | undefined, retainUntil: string): string[] {
  const n = o.names;
  const t = n.qualifiedTable;
  const declared = o.column;
  const oldComment = workingComment(n, marker, "old", `the old ${n.change === "rename" ? "name" : "column"}, kept until ${retainUntil}`, { "retain-until": retainUntil });
  const carried = carriedSwitchStatements(
    o.carried,
    o.views,
    n.change,
    (c) => workingComment(n, marker, "old", `the old ${c.kind} ${c.name}, on ${n.oldColumn} until the contract drops it`, { of: c.name }),
    marker,
  );
  const out: string[] = [];
  if (requiresNotNull(declared, o.carried)) out.push(`ALTER TABLE ${t} ALTER COLUMN ${col(n.newColumn)} SET NOT NULL`);
  if (o.check) out.push(`ALTER TABLE ${t} DROP CONSTRAINT ${col(n.check)}`);
  if (n.change === "type") {
    out.push(`DROP TRIGGER ${col(n.trigger)} ON ${t}`);
    out.push(...carried.before);
    if (o.source!.notNull) out.push(`ALTER TABLE ${t} ALTER COLUMN ${col(n.source)} DROP NOT NULL`);
    if (o.source!.default !== undefined) out.push(`ALTER TABLE ${t} ALTER COLUMN ${col(n.source)} DROP DEFAULT`);
    out.push(`ALTER TABLE ${t} RENAME COLUMN ${col(n.source)} TO ${col(n.oldColumn)}`);
    out.push(`ALTER TABLE ${t} RENAME COLUMN ${col(n.newColumn)} TO ${col(n.column)}`);
    if (declared.default !== undefined) out.push(`ALTER TABLE ${t} ALTER COLUMN ${col(n.column)} SET DEFAULT ${declared.default}`);
    out.push(commentOnColumn(n, n.column, declared.comment));
    out.push(commentOnColumn(n, n.oldColumn, oldComment));
    out.push(`DROP FUNCTION ${n.qualifiedFn}()`);
  } else {
    out.push(...carried.before);
    out.push(commentOnColumn(n, n.column, declared.comment));
    out.push(commentOnColumn(n, n.oldColumn, oldComment));
  }
  out.push(...carried.after);
  return out;
}

/**
 * Switch, once the gate has approved the verified plan. A declared NOT NULL
 * is proven first by a check added NOT VALID and then validated, which reads
 * the table under SHARE UPDATE EXCLUSIVE while reads and writes go on, so
 * `SET NOT NULL` in the switch is a catalog change (since 12). Then the
 * switch runs in one short transaction under the lock timeout.
 */
export async function switchColumns(run: MigrationRun): Promise<SwitchResult> {
  const o = await observe(run);
  const n = o.names;
  if (o.state === "done") return { state: o.state, switched: false };
  if (o.state === "switched") return { state: o.state, switched: false, oldColumn: n.oldColumn, ...retention(o) };
  if (!o.newColumn || !o.trigger || !o.fn) throw new MigrationRefusal(`${n.key}: the new column and its dual write are not there; the Expand and Dual write phases make them`);
  const notReady = carriedNotReady(o.carried, o.carriedStates);
  if (notReady.length > 0) {
    throw new MigrationRefusal(`${n.key}: ${notReady.map((c) => `${c.kind} ${c.working}`).join(", ")} on the new column is not there or not yet valid; the Carry over phase makes them`);
  }
  const notNull = requiresNotNull(o.column, o.carried);

  if (notNull && !o.newColumn.notNull) {
    if (!o.check) {
      await inTransaction(run, async (exec) => {
        await exec(`ALTER TABLE ${n.qualifiedTable} ADD CONSTRAINT ${col(n.check)} CHECK (${col(n.newColumn)} IS NOT NULL) NOT VALID`);
        await exec(`COMMENT ON CONSTRAINT ${col(n.check)} ON ${n.qualifiedTable} IS ${pgString(workingComment(n, run.marker, "nn", `proves ${n.newColumn} NOT NULL`))}`);
      });
    }
    if (!o.check?.validated) {
      await inTransaction(run, (exec) => exec(`ALTER TABLE ${n.qualifiedTable} VALIDATE CONSTRAINT ${col(n.check)}`), { scan: true });
    }
  }
  const retainUntil = new Date((await serverNow(run.client)) + run.retainMs).toISOString();
  const withCheck = { ...o, check: o.check ?? (notNull && !o.newColumn.notNull ? { name: n.check, validated: true } : undefined) } as MigrationObservation;
  await inTransaction(run, async (exec) => {
    for (const sql of switchStatements(withCheck, run.marker, retainUntil)) await exec(sql);
  });
  return { state: "switched", switched: true, oldColumn: n.oldColumn, retainUntil };
}

// ── retain and contract ────────────────────────────────────────────────

function retention(o: MigrationObservation): { retainUntil?: string } {
  const until = o.old?.pairs?.get("retain-until");
  return until ? { retainUntil: until } : {};
}

export interface RetainResult {
  state: MigrationObservation["state"];
  /** `schema.table.column`, the old column while it is kept. */
  oldColumn?: string;
  retainUntil?: string;
  /** The retention date has passed. */
  due: boolean;
  /** What the contract gate approves: this old column, by its table's oid and attribute number, and its date. Absent when there is nothing to drop. */
  contractDigest?: string;
}

/** Where the old column is kept and until when, and the digest the contract gate binds. */
export async function retainPlan(run: MigrationRun): Promise<RetainResult> {
  const o = await observe(run);
  if (!o.old) return { state: o.state, due: false };
  const retainUntil = o.old.pairs?.get("retain-until");
  const due = retainUntil !== undefined && (await serverNow(run.client)) >= Date.parse(retainUntil);
  const oldColumn = `${o.names.schema}.${o.names.table}.${o.old.name}`;
  return {
    state: o.state,
    oldColumn,
    ...(retainUntil ? { retainUntil } : {}),
    due,
    contractDigest: computePlanDigest("postgres-migration-contract", { migration: o.names.key, table: o.oid, column: o.old.name, attnum: o.old.attnum, retainUntil: retainUntil ?? null }),
  };
}

export interface ContractResult {
  state: MigrationObservation["state"];
  dropped: boolean;
  oldColumn?: string;
  retainUntil?: string;
}

/** The receipt address prefix of one migration's batches. */
export const batchPrefix = (identity: { stack?: string; env?: string }, key: string): string => receiptAddress(identity, `migrate/${key}/`);

export const identityOf = (marker: OwnershipMarker | undefined): { stack?: string; env?: string } => ({
  ...(marker?.stack ? { stack: marker.stack } : {}),
  ...(marker?.env ? { env: marker.env } : {}),
});

/**
 * Contract, once the retention date has passed and the gate approved it:
 * drop the old column, and for a rename the trigger and function that kept
 * it written, in one transaction under the lock timeout (`DROP COLUMN` is a
 * catalog change under ACCESS EXCLUSIVE). The migration's receipts go with
 * them. Before the date, say until when and drop nothing.
 */
export async function contract(run: MigrationRun): Promise<ContractResult> {
  const plan = await retainPlan(run);
  if (!plan.oldColumn) return { state: plan.state, dropped: false };
  if (!plan.due) {
    run.log(`-- ${plan.oldColumn} is kept until ${plan.retainUntil}; a run after that drops it`);
    return { state: plan.state, dropped: false, oldColumn: plan.oldColumn, ...(plan.retainUntil ? { retainUntil: plan.retainUntil } : {}) };
  }
  const o = await observe(run);
  const n = o.names;
  await inTransaction(run, async (exec) => {
    if (o.trigger) await exec(`DROP TRIGGER ${col(n.trigger)} ON ${n.qualifiedTable}`);
    if (o.fn) await exec(`DROP FUNCTION ${n.qualifiedFn}()`);
    await exec(`ALTER TABLE ${n.qualifiedTable} DROP COLUMN ${col(o.old!.name)}`);
  });
  await postgresReceiptStore(run.client, n.schema, identityOf(run.marker)).forget(batchPrefix(identityOf(run.marker), n.key));
  return { state: "done", dropped: true, oldColumn: plan.oldColumn };
}

// ── onFailure ──────────────────────────────────────────────────────────

export interface CompensateResult {
  dropped: string[];
}

/**
 * onFailure: drop what the expand added, and nothing else: the trigger, its
 * function, the NOT NULL check, the carried indexes and constraints (another
 * table's foreign key onto the new column first, which would keep the column
 * from being dropped) and the new column, each only when its
 * comment names this migration and its role and carries this project's
 * marker, and the migration's receipts. After the switch nothing is undone:
 * the old column is kept (`role=old`) and the next run finishes the
 * migration; the contract gate decides when the old column goes.
 *
 * It reads the server directly rather than through the observation, which
 * may be what refused and failed the run.
 */
export async function compensate(run: Pick<MigrationRun, "client" | "target" | "declared" | "column" | "marker" | "log" | "signal" | "lockTimeoutMs" | "statementTimeoutMs" | "lockRetries">): Promise<CompensateResult> {
  const schema = run.declared.canonical.schema ?? run.target.defaultSchema;
  const table = run.declared.canonical.name;
  const n = migrationNames(schema, table, run.column, "type", run.column);
  const ours = (comment: string | null | undefined, role: string) => {
    const pairs = readTrailerPairs(comment ?? undefined);
    return pairs?.get(MIGRATION_TRAILER_KEY) === n.key && pairs.get("role") === role && carriesMarker(comment ?? undefined, run.marker);
  };
  const [rel] = await run.client.query<{ oid: string | null }>("SELECT pg_catalog.to_regclass($1)::oid::text AS oid", [n.qualifiedTable]);
  if (!rel?.oid) return { dropped: [] };
  const cols = await run.client.query<{ name: string; comment: string | null }>(
    "SELECT a.attname AS name, pg_catalog.col_description(a.attrelid, a.attnum) AS comment FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped",
    [rel.oid],
  );
  if (cols.some((c) => ours(c.comment, "old"))) {
    run.log(`-- ${n.key} has been switched; onFailure leaves it for the next run to finish`);
    return { dropped: [] };
  }
  const [trig] = await run.client.query<{ comment: string | null }>(
    "SELECT pg_catalog.obj_description(t.oid, 'pg_trigger') AS comment FROM pg_catalog.pg_trigger t WHERE t.tgrelid = $1::oid AND t.tgname = $2",
    [rel.oid, n.trigger],
  );
  const [fn] = await run.client.query<{ comment: string | null }>(
    "SELECT pg_catalog.obj_description(p.oid, 'pg_proc') AS comment FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = $1 AND p.proname = $2 AND p.pronargs = 0",
    [schema, n.fn],
  );
  const checks = await run.client.query<{ name: string; comment: string | null }>(
    "SELECT c.conname AS name, pg_catalog.obj_description(c.oid, 'pg_constraint') AS comment FROM pg_catalog.pg_constraint c WHERE c.conrelid = $1::oid",
    [rel.oid],
  );
  const newColumns = cols.filter((c) => ours(c.comment, "new")).map((c) => c.name);
  const nn = checks.filter((c) => ours(c.comment, "nn")).map((c) => c.name);
  // Carried constraints, this table's and those of tables whose foreign keys were carried onto the new column.
  const carriedConstraints = (
    await run.client.query<{ name: string; rel: string; comment: string | null }>(
      `SELECT k.conname AS name, k.conrelid::pg_catalog.regclass::text AS rel, pg_catalog.obj_description(k.oid, 'pg_constraint') AS comment
       FROM pg_catalog.pg_constraint k WHERE pg_catalog.strpos(pg_catalog.obj_description(k.oid, 'pg_constraint'), $1) > 0 ORDER BY k.conrelid = $2::oid, k.conname`,
      [`${MIGRATION_TRAILER_KEY}=`, rel.oid],
    )
  ).filter((c) => ours(c.comment, "carry"));
  const carriedIndexes = (
    await run.client.query<{ name: string; comment: string | null }>(
      "SELECT i.indexrelid::pg_catalog.regclass::text AS name, pg_catalog.obj_description(i.indexrelid, 'pg_class') AS comment FROM pg_catalog.pg_index i WHERE i.indrelid = $1::oid ORDER BY 1",
      [rel.oid],
    )
  ).filter((c) => ours(c.comment, "carry"));
  const dropped: string[] = [];
  const full: MigrationRun = { ...(run as MigrationRun), batchSize: 0, retainMs: 0, replicationLag: false };
  await inTransaction(full, async (exec) => {
    if (trig && ours(trig.comment, "dual")) {
      await exec(`DROP TRIGGER ${col(n.trigger)} ON ${n.qualifiedTable}`);
      dropped.push(`trigger ${n.trigger}`);
    }
    if (fn && ours(fn.comment, "dual")) {
      await exec(`DROP FUNCTION ${n.qualifiedFn}()`);
      dropped.push(`function ${schema}.${n.fn}`);
    }
    for (const c of nn) {
      await exec(`ALTER TABLE ${n.qualifiedTable} DROP CONSTRAINT ${col(c)}`);
      dropped.push(`constraint ${c}`);
    }
    for (const c of carriedConstraints) {
      await exec(`ALTER TABLE ${c.rel} DROP CONSTRAINT ${col(c.name)}`);
      dropped.push(`constraint ${c.name} on ${c.rel}`);
    }
    for (const c of carriedIndexes) {
      await exec(`DROP INDEX ${c.name}`);
      dropped.push(`index ${c.name}`);
    }
    for (const c of newColumns) {
      await exec(`ALTER TABLE ${n.qualifiedTable} DROP COLUMN ${col(c)}`);
      dropped.push(`column ${schema}.${table}.${c}`);
    }
  });
  const forgotten = await postgresReceiptStore(run.client, schema, identityOf(run.marker)).forget(batchPrefix(identityOf(run.marker), n.key));
  if (forgotten > 0) dropped.push(`${forgotten} receipt(s)`);
  return { dropped };
}
