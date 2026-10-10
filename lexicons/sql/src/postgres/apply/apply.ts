/**
 * The Postgres applier (#3280): make a server hold what a build declares, for
 * every change the classifier (`../plan/rules.ts`) does not refuse, and
 * refuse the rest.
 *
 * Per declared object, exactly one verdict (lexicon-authoring/applying.mdx):
 *
 * - APPLIED `created`: absent on the server; created from its declared
 *   statements, with chant's ownership marker set by `COMMENT ON`.
 * - APPLIED `updated`: present, and the statements for its changes ran and
 *   committed.
 * - APPLIED `unchanged`: present, nothing to change, the marker in place.
 * - NOT-ATTEMPTED `unsupported-kind`: a change only expand and contract
 *   makes (a column rename, a type change across kinds, a NOT NULL column
 *   with no default), or one with no in-place statement. Nothing is sent for
 *   the object; the detail names each rule, the restriction and the
 *   expand-and-contract migration Op (#3281).
 * - NOT-ATTEMPTED `filtered`: the change drops a column, which destroys its
 *   data, and the apply was not allowed to delete; or another tool keeps the
 *   object (an ORM's revision table, a managed provider's schema).
 * - NOT-ATTEMPTED `dependency-failed`: an object it references is not on the
 *   server, or its statements ran in a transaction that rolled back because
 *   another object's statement failed. The detail names that statement.
 * - NOT-ATTEMPTED with the binding's reason: no server to apply to.
 *
 * A statement the server refuses fails its object, which was attempted and
 * did not converge. Its transaction rolls back, the rest of the apply goes on,
 * and the applier then throws {@link PostgresApplyError}, which carries the
 * outcome so far.
 *
 * ## Transactions
 *
 * Statements run in the build's order, each object's in the order its
 * changes need, and are grouped:
 *
 * 1. Consecutive statements that change only the catalog (create, metadata,
 *    drop) share one transaction, across objects, so they land together or
 *    not at all.
 * 2. A statement that reads or rewrites a table's rows (an `ACCESS
 *    EXCLUSIVE` rewrite or scan, a validation, a non-concurrent index build)
 *    runs in a transaction of its own object, so a long scan holds locks on
 *    that one table and the changes before it have committed.
 * 3. A statement that refuses a transaction block (`CREATE INDEX
 *    CONCURRENTLY`, `DROP INDEX CONCURRENTLY`) runs alone, outside any
 *    transaction, and so does `ALTER TYPE ... ADD VALUE`, whose new label
 *    cannot be used in the transaction that adds it.
 *
 * ## Timeouts
 *
 * Every statement runs with its own `lock_timeout` and `statement_timeout`
 * (`SET LOCAL` in a transaction, `SET` before one outside), so a statement
 * blocked behind another session's lock fails fast instead of queueing every
 * query behind it. Defaults: a lock is waited for 5 s; a catalog-only
 * statement may run 60 s; a statement that reads or rewrites rows has no
 * limit. `sql.profiles.<env>` sets them (`lockTimeoutMs`,
 * `statementTimeoutMs`, `scanTimeoutMs`), and the outcome records the values
 * each statement ran with.
 *
 * ## Prune
 *
 * When asked for, prune drops the objects in the declared schemas that the
 * build no longer declares and whose comment carries this project's marker
 * (stack and env): views first, schemas last, never `CASCADE`, so an object
 * something else still depends on is kept and reported. An object without
 * the marker is not chant's and is never touched; one another tool keeps is
 * never read as an orphan at all.
 */

import type { OwnershipMarker } from "@intentius/chant/ownership";
import type { ApplyRef } from "@intentius/chant/apply";
import { SqlApplyError, dependencyFailedDetail, missingDependencies, readBuildObjects, type SqlApplyOutcome } from "../../core/apply";
import { carriesMarker, isChantManaged } from "../../core/ownership";
import { PostgresQueryError, type PostgresClient } from "../live/client";
import type { PostgresTarget } from "../live/bind";
import type { LivePgObject, readLiveSchema } from "../live/catalog";
import { liveProps } from "../plan/deep";
import { diffObject, qualifiedKey, type PgSchemaObject } from "../plan/schema";
import { POSTGRES_LATEST_MAJOR } from "../../spec/postgres-pin";
import { matchPgObjects, type PgChange } from "../plan/diff";
import { planAgainstClient } from "../plan/commands";
import type { serverNormalized } from "../plan/server-normalize";
import type { PostgresEntityType } from "../entity-types";
import type { PgChangeClass } from "../plan/rules";
import type { CanonicalKind } from "../plan/normalize";
import { quoteIdent } from "../keywords";
import { planPgStatements, scansRows, type DeclaredPgObject, type PgDropStatement, type PgStep } from "./statements";
import { ACCESS_KINDS, ACCESS_MANAGED_KINDS } from "../plan/normalize";
import { declaredAccess, diffAccess, targetKey } from "../access/acl";
import { readLiveAccess } from "../access/live";

/** The timeouts a statement runs with, in milliseconds; 0 is no limit. */
export interface PostgresApplyTimeouts {
  /** `lock_timeout` for every statement. */
  lockTimeoutMs: number;
  /** `statement_timeout` for a statement that changes only the catalog. */
  statementTimeoutMs: number;
  /** `statement_timeout` for a statement that reads or rewrites rows. */
  scanTimeoutMs: number;
}

export const DEFAULT_POSTGRES_APPLY_TIMEOUTS: PostgresApplyTimeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 60_000, scanTimeoutMs: 0 };

/** One statement as it ran: its object, the timeouts it ran with, and the transaction it was in. */
export interface RanStatement {
  /** The object it was for, as an apply result names it. */
  object: string;
  sql: string;
  class: PgChangeClass;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  /** The transaction's number in {@link PostgresApplyOutcome.transactions}, or undefined for a statement run outside one. */
  transaction?: number;
}

/** A transaction as it ended. */
export interface TransactionRecord {
  /** The objects with statements in it. */
  objects: string[];
  result: "committed" | "rolled-back";
  /** The statement that failed it, and the server's message. */
  failedAt?: { sql: string; error: string };
}

/**
 * The shared core's outcome, with what a Postgres apply adds: the timeouts it
 * ran with, every statement it sent in order, and how each transaction ended.
 * `target` is the server's URL (no password), `source` where the binding came
 * from.
 */
export interface PostgresApplyOutcome extends SqlApplyOutcome {
  timeouts: PostgresApplyTimeouts;
  statements: RanStatement[];
  transactions: TransactionRecord[];
}

/** An apply in which the server refused a statement. The outcome says what did and did not happen. */
export class PostgresApplyError extends SqlApplyError<PostgresApplyOutcome> {
  constructor(outcome: PostgresApplyOutcome) {
    super("Postgres", outcome);
    this.name = "PostgresApplyError";
  }
}

/**
 * The name an apply result gives an object: `schema.name`, or a schema's or
 * extension's own name; a routine's with its parameter types
 * (`app.touch()`), a trigger's with its table (`touch ON app.users`).
 */
export const refName = (o: { kind: CanonicalKind; schema?: string; name: string; signature?: string }): string =>
  o.kind === "trigger" || o.kind === "policy"
    ? `${o.name}${o.signature ?? ""}`
    : o.kind === "schema" || o.kind === "extension" || o.kind === "role" || o.schema === undefined
      ? o.name
      : `${o.schema}.${o.name}${o.kind === "function" || o.kind === "procedure" ? (o.signature ?? "") : ""}`;

/**
 * The objects a Postgres `chant build` output declares, in creation order,
 * each parsed with its tag and in canonical form. Takes the sql lexicon's
 * primary output, or a multi-lexicon output holding it under `sql`.
 */
export function declaredObjects(json: string, defaultSchema = "public"): DeclaredPgObject[] {
  return readBuildObjects(json, "postgres", (o) => {
    const canonical = { ...diffObject(o.type, o.ddl, defaultSchema), exportName: o.export };
    return {
      exportName: o.export,
      type: o.type as PostgresEntityType,
      name: refName(canonical),
      key: qualifiedKey(canonical),
      ddl: o.ddl,
      props: liveProps({ type: o.type, statement: o.ddl } as LivePgObject),
      canonical,
      dependsOn: o.dependsOn,
    };
  });
}

/** The plan axis: one ref per declared object, by its type and its name on the server. */
export const planRefs = (declared: readonly DeclaredPgObject[]): ApplyRef[] => declared.map((o) => ({ kind: o.type, name: o.name }));

export interface PostgresApplyOptions {
  /** The marker to stamp, and the identity a prune matches. Without a stack, prune declines. */
  marker?: OwnershipMarker;
  /** Drop owned objects the build no longer declares, and allow column drops. Default: off. */
  prune?: boolean;
  /** The timeouts; each one left out is the target's (`sql.profiles.<env>`), else the default. */
  timeouts?: Partial<PostgresApplyTimeouts>;
  /** The server's major (`sql.postgresMajor`); the newest pinned one when omitted. */
  major?: number;
  signal?: AbortSignal;
  /** Where to report each statement. Default: nowhere. */
  log?: (line: string) => void;
  /** Read the server's schema with this instead of the catalog reader (tests). */
  readLive?: typeof readLiveSchema;
  /** Ask the server about expressions with this instead (tests). */
  serverNormalize?: typeof serverNormalized;
}

const SQLSTATE_LOCK_NOT_AVAILABLE = "55P03";
const SQLSTATE_QUERY_CANCELED = "57014";
const SQLSTATE_DEPENDENT_OBJECTS = "2BP01";
const SQLSTATE_UNDEFINED = new Set(["42P01", "42704", "3F000"]);

const ms = (n: number) => `'${Math.max(0, Math.floor(n))}ms'`;

/** A server error as a detail: its message, and what the timeouts mean when one fired. */
function errorText(err: unknown, t: { lockTimeoutMs: number; statementTimeoutMs: number }): string {
  const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
  const code = err instanceof PostgresQueryError ? err.code : undefined;
  if (code === SQLSTATE_LOCK_NOT_AVAILABLE) return `${message} (lock_timeout ${t.lockTimeoutMs}ms: another session holds a lock this statement needs; SQLSTATE 55P03)`;
  if (code === SQLSTATE_QUERY_CANCELED) return `${message} (statement_timeout ${t.statementTimeoutMs}ms; SQLSTATE 57014)`;
  return code ? `${message} (SQLSTATE ${code})` : message;
}

/** One object's work: its ref, its steps, and how far they got. */
interface Unit {
  obj: DeclaredPgObject;
  ref: ApplyRef;
  created: boolean;
  physicalId?: string;
  steps: PgStep[];
  /** Statements committed, or run outside a transaction. */
  ran: string[];
  /** Statements run in the open transaction, not yet committed. */
  pending: string[];
  /** How many steps have run. */
  done: number;
  state: "planned" | "applied" | "failed" | "rolled-back" | "skipped";
}

/**
 * Apply the declarations to the server `client` is connected to. Returns
 * every declared object in exactly one of applied or not attempted, and every
 * pruned orphan; throws {@link PostgresApplyError} when the server refused a
 * statement. The client is left open; the caller ends it.
 */
export async function applyPostgres(
  client: PostgresClient,
  target: PostgresTarget,
  declared: readonly DeclaredPgObject[],
  opts: PostgresApplyOptions = {},
): Promise<PostgresApplyOutcome> {
  const log = opts.log ?? (() => undefined);
  const timeouts: PostgresApplyTimeouts = { ...DEFAULT_POSTGRES_APPLY_TIMEOUTS, ...target.timeouts, ...opts.timeouts };
  const outcome: PostgresApplyOutcome = {
    target: target.endpoint.url,
    source: target.source,
    applied: [],
    pruned: [],
    notAttempted: [],
    failed: [],
    timeouts,
    statements: [],
    transactions: [],
  };

  // ── Plan: the same diff `chant sql plan` shows. ──
  const build: PgSchemaObject[] = declared.map((o) => ({ key: o.exportName, canonical: o.canonical }));
  const plan = await planAgainstClient(client, target, build, {
    ...(opts.major !== undefined ? { major: opts.major } : {}),
    ...(opts.readLive ? { readLive: opts.readLive } : {}),
    ...(opts.serverNormalize ? { serverNormalize: opts.serverNormalize } : {}),
  });
  const normalizedByKey = new Map(plan.declared.map((o) => [o.key, o.canonical]));
  const liveRawByKey = new Map(plan.liveObjects.map((o) => [qualifiedKey(liveCanonicalAddress(o)), o]));
  const managed = target.access === true;
  // Access declarations a profile does not manage are not applied; grants and default privileges run after every object, as access.
  for (const o of declared) {
    if (!managed && ACCESS_MANAGED_KINDS.has(o.canonical.kind)) {
      outcome.notAttempted.push({
        kind: o.type,
        name: o.name,
        reason: "filtered",
        detail: `access is not managed in this environment: set sql.profiles.<env>.access to plan and apply policies, roles, grants and row-level security`,
      });
    }
  }
  const objects = declared
    .filter((o) => !ACCESS_KINDS.has(o.canonical.kind) && (managed || !ACCESS_MANAGED_KINDS.has(o.canonical.kind)))
    .map((original) => ({ ...original, canonical: { ...original.canonical, ...normalizedByKey.get(original.key) } }));
  const matchedLive = new Set<string>();
  for (const m of matchPgObjects(plan.live, plan.declared)) if (m.kind === "matched") matchedLive.add(m.after.key);

  // An extension's own comment stays under the trailer when the declaration sets none.
  const extensionComments = await extensionDefaults(client, objects.filter((o) => o.canonical.kind === "extension" && !matchedLive.has(o.key)).map((o) => o.canonical.name));

  // ── Each object's statements, or its verdict when it has none to send. ──
  const statements = planPgStatements({
    declared: objects,
    changes: plan.diff.changes,
    current: plan.live,
    major: plan.major ?? POSTGRES_LATEST_MAJOR,
    allowDestructive: opts.prune === true,
    carriesMarker: (_live, key) => carriesMarker(liveRawByKey.get(key)?.comment, opts.marker),
    extensionComment: (name) => extensionComments.get(name),
    access: managed,
    ...(opts.marker ? { marker: opts.marker } : {}),
  });

  const units: Unit[] = [];
  const onServer = new Set<string>();
  const exportNames = new Set(declared.map((o) => o.exportName));
  for (const entry of statements.objects) {
    const obj = entry.obj;
    const ref = { kind: obj.type, name: obj.name };
    const liveRaw = entry.live ? liveRawByKey.get(qualifiedKey(entry.live)) : undefined;
    switch (entry.verdict) {
      case "foreign":
      case "withheld":
      case "unsupported":
        onServer.add(obj.exportName);
        outcome.notAttempted.push({ ...ref, reason: entry.verdict === "unsupported" ? "unsupported-kind" : "filtered", detail: entry.detail });
        continue;
      case "refused":
        if (entry.live) onServer.add(obj.exportName);
        outcome.notAttempted.push({ ...ref, reason: "unsupported-kind", detail: entry.detail });
        continue;
    }
    if (entry.steps.length === 0) {
      onServer.add(obj.exportName);
      outcome.applied.push({ ...ref, action: "unchanged", ...(liveRaw ? { physicalId: liveRaw.oid } : {}), statements: [] });
      continue;
    }
    units.push({ obj, ref, created: !entry.live, ...(liveRaw ? { physicalId: liveRaw.oid } : {}), steps: entry.steps, ran: [], pending: [], done: 0, state: "planned" });
  }

  // ── Run them, grouped into transactions. ──
  // Statements use the default schema for a bare name, as the declarations do; the catalog was read with an empty search_path.
  await client.query("SELECT pg_catalog.set_config('search_path', $1, false)", [quoteIdent(target.defaultSchema)]);

  let tx: { number: number; heavy: boolean; owner?: Unit; members: Set<Unit>; statements: string[] } | undefined;

  const finish = (u: Unit) => {
    if (u.state !== "planned" || u.done < u.steps.length || u.pending.length > 0) return;
    u.state = "applied";
    onServer.add(u.obj.exportName);
    outcome.applied.push({ ...u.ref, action: u.created ? "created" : "updated", ...(u.physicalId ? { physicalId: u.physicalId } : {}), statements: u.ran });
  };
  const fail = (u: Unit, error: string) => {
    u.state = "failed";
    if (!u.created) onServer.add(u.obj.exportName);
    outcome.failed.push({ ...u.ref, error, statements: u.ran });
  };

  const commit = async (): Promise<void> => {
    if (!tx) return;
    const t = tx;
    tx = undefined;
    try {
      log("COMMIT");
      await client.query("COMMIT");
    } catch (err) {
      await rollBack(t, "COMMIT", err instanceof Error ? err.message : String(err), undefined);
      return;
    }
    outcome.transactions.push({ objects: [...t.members].map((u) => u.ref.name), result: "committed" });
    for (const u of t.members) {
      u.ran.push(...u.pending);
      u.pending = [];
      finish(u);
    }
  };

  /** Roll the open transaction back: the failing object fails, the others in it are rolled back with it. */
  const rollBack = async (t: NonNullable<typeof tx>, sql: string, error: string, failing: Unit | undefined): Promise<void> => {
    log("ROLLBACK");
    await client.query("ROLLBACK").catch(() => undefined);
    outcome.transactions.push({ objects: [...t.members].map((u) => u.ref.name), result: "rolled-back", failedAt: { sql, error } });
    for (const u of t.members) {
      u.pending = [];
      if (u === failing) continue;
      if (u.state !== "planned" && u.state !== "applied") continue;
      if (u.ran.length > 0) fail(u, `rolled back with the transaction that failed at ${sql}: ${error}`);
      else {
        u.state = "rolled-back";
        outcome.notAttempted.push({
          ...u.ref,
          reason: "dependency-failed",
          detail: `its statements ran in a transaction that rolled back, so nothing of it was kept: the transaction failed at ${sql}: ${error}`,
        });
      }
    }
    if (failing) fail(failing, error);
  };

  for (const u of units) {
    for (const s of u.steps) {
      opts.signal?.throwIfAborted();
      if (u.state !== "planned") break;
      const heavy = scansRows(s.class);
      const t = { lockTimeoutMs: timeouts.lockTimeoutMs, statementTimeoutMs: heavy ? timeouts.scanTimeoutMs : timeouts.statementTimeoutMs };
      // Close the open transaction when this statement cannot join it.
      if (tx && (!s.transactional || tx.heavy !== heavy || (heavy && tx.owner !== u))) await commit();
      if (u.state !== "planned") break;
      if (u.done === 0 && !tx?.members.has(u)) {
        // An object whose statements all ran in the open transaction is on the server as far as this transaction sees.
        const seen = new Set([...onServer, ...[...(tx?.members ?? [])].filter((m) => m.state === "planned" && m.done === m.steps.length).map((m) => m.obj.exportName)]);
        const missing = missingDependencies(u.obj.exportName, u.obj.dependsOn, exportNames, seen);
        if (missing.length > 0) {
          u.state = "skipped";
          if (!u.created) onServer.add(u.obj.exportName);
          outcome.notAttempted.push({ ...u.ref, reason: "dependency-failed", detail: dependencyFailedDetail(missing) });
          break;
        }
      }

      if (!s.transactional) {
        const record: RanStatement = { object: u.ref.name, sql: s.sql, class: s.class, ...t };
        try {
          for (const set of [`SET lock_timeout = ${ms(t.lockTimeoutMs)}`, `SET statement_timeout = ${ms(t.statementTimeoutMs)}`]) {
            log(set);
            await client.query(set);
          }
          log(s.sql);
          outcome.statements.push(record);
          await client.query(s.sql);
          u.ran.push(s.sql);
          u.done++;
          finish(u);
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          if (s.buildsIndex) await dropInvalidIndex(client, s.buildsIndex, log);
          fail(u, `${errorText(err, t)}, at ${s.sql}`);
        }
        continue;
      }

      if (!tx) {
        log("BEGIN");
        await client.query("BEGIN");
        tx = { number: outcome.transactions.length, heavy, ...(heavy ? { owner: u } : {}), members: new Set(), statements: [] };
      }
      tx.members.add(u);
      const record: RanStatement = { object: u.ref.name, sql: s.sql, class: s.class, ...t, transaction: tx.number };
      try {
        for (const set of [`SET LOCAL lock_timeout = ${ms(t.lockTimeoutMs)}`, `SET LOCAL statement_timeout = ${ms(t.statementTimeoutMs)}`]) {
          log(set);
          await client.query(set);
        }
        log(s.sql);
        outcome.statements.push(record);
        await client.query(s.sql);
        u.pending.push(s.sql);
        u.done++;
      } catch (err) {
        if (opts.signal?.aborted) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        }
        const failed = tx;
        tx = undefined;
        await rollBack(failed, s.sql, errorText(err, t), u);
      }
    }
  }
  await commit();

  if (managed) await applyAccess(client, declared, onServer, exportNames, { ...opts, major: plan.major ?? opts.major ?? POSTGRES_LATEST_MAJOR, ...(plan.scope ? { schemas: plan.scope } : {}) }, timeouts, outcome, log);

  if (opts.prune) await prune(client, statements.drops, liveRawByKey, opts, timeouts, outcome, log);
  if (outcome.failed.length > 0) throw new PostgresApplyError(outcome);
  return outcome;
}

/**
 * Access, after every object (#3681): the privileges and default privileges
 * the declarations add up to, against what the server holds now that the
 * objects exist, made in one transaction. A grant or default-privileges
 * declaration is `updated` when a statement ran for it and `unchanged`
 * otherwise; a privilege nothing declares is revoked under the object's name.
 */
async function applyAccess(
  client: PostgresClient,
  declared: readonly DeclaredPgObject[],
  onServer: ReadonlySet<string>,
  exportNames: ReadonlySet<string>,
  opts: PostgresApplyOptions & { major: number; schemas?: string[] },
  timeouts: PostgresApplyTimeouts,
  outcome: PostgresApplyOutcome,
  log: (line: string) => void,
): Promise<void> {
  const decls = declared.filter((o) => ACCESS_KINDS.has(o.canonical.kind));
  const ref = (o: DeclaredPgObject) => ({ kind: o.type, name: o.canonical.name });
  const ready: DeclaredPgObject[] = [];
  for (const o of decls) {
    const missing = missingDependencies(o.exportName, o.dependsOn, exportNames, onServer);
    if (missing.length > 0) outcome.notAttempted.push({ ...ref(o), reason: "dependency-failed", detail: dependencyFailedDetail(missing) });
    else ready.push(o);
  }
  const skipped = new Set(decls.filter((o) => !ready.includes(o)).map((o) => o.exportName));
  const [me] = await client.query<{ self: string }>("SELECT current_user AS self");
  const want = declaredAccess(
    declared.filter((o) => !skipped.has(o.exportName)).map((o) => ({ key: o.exportName, canonical: o.canonical })),
    { major: opts.major, ...(me?.self ? { self: me.self } : {}) },
  );
  const have = await readLiveAccess(client, want.targets, {
    ...(opts.schemas ? { schemas: opts.schemas } : {}),
    forRoles: want.forRoles,
    declaredDefaults: want.targets.filter((t) => t.kind === "default"),
  });
  // A target that is not on the server (its object failed) is left for the next apply.
  const changes = diffAccess(have.state, want.state, want.exportsOf).filter(
    (c) => c.target.kind === "default" || have.present.has(targetKey(c.target.kind === "column" ? { kind: "table", name: c.target.name } : c.target)),
  );
  const ranFor = new Map<string, string[]>();
  if (changes.length > 0) {
    const t = { lockTimeoutMs: timeouts.lockTimeoutMs, statementTimeoutMs: timeouts.statementTimeoutMs };
    const number = outcome.transactions.length;
    const members = new Set<string>();
    log("BEGIN");
    await client.query("BEGIN");
    try {
      for (const set of [`SET LOCAL lock_timeout = ${ms(t.lockTimeoutMs)}`, `SET LOCAL statement_timeout = ${ms(t.statementTimeoutMs)}`]) {
        log(set);
        await client.query(set);
      }
      for (const c of changes) {
        const object = c.exports[0] !== undefined ? (declared.find((o) => o.exportName === c.exports[0])?.canonical.name ?? c.change.object) : c.change.object.slice(4);
        members.add(object);
        for (const sql of c.sql) {
          opts.signal?.throwIfAborted();
          log(sql);
          outcome.statements.push({ object, sql, class: c.change.class, ...t, transaction: number });
          await client.query(sql);
          for (const e of c.exports) ranFor.set(e, [...(ranFor.get(e) ?? []), sql]);
        }
      }
      log("COMMIT");
      await client.query("COMMIT");
      outcome.transactions.push({ objects: [...members], result: "committed" });
    } catch (err) {
      if (opts.signal?.aborted) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
      const error = errorText(err, t);
      const failedAt = outcome.statements[outcome.statements.length - 1]?.sql ?? "BEGIN";
      log("ROLLBACK");
      await client.query("ROLLBACK").catch(() => undefined);
      outcome.transactions.push({ objects: [...members], result: "rolled-back", failedAt: { sql: failedAt, error } });
      for (const o of ready) {
        if (changes.some((c) => c.exports.includes(o.exportName))) outcome.failed.push({ ...ref(o), error: `${error}, in the access transaction at ${failedAt}`, statements: [] });
        else outcome.applied.push({ ...ref(o), action: "unchanged", statements: [] });
      }
      return;
    }
  }
  for (const o of ready) {
    const ran = ranFor.get(o.exportName) ?? [];
    outcome.applied.push({ ...ref(o), action: ran.length > 0 ? "updated" : "unchanged", statements: ran });
  }
}

/** The address a live object is keyed by in the diff. */
function liveCanonicalAddress(o: LivePgObject): { kind: CanonicalKind; schema?: string; name: string; signature?: string } {
  const kind = (
    {
      "Postgres::Schema": "schema",
      "Postgres::Table": "table",
      "Postgres::Index": "index",
      "Postgres::View": "view",
      "Postgres::MaterializedView": "materializedView",
      "Postgres::Sequence": "sequence",
      "Postgres::Enum": "enum",
      "Postgres::Domain": "domain",
      "Postgres::Extension": "extension",
      "Postgres::Function": "function",
      "Postgres::Procedure": "procedure",
      "Postgres::Trigger": "trigger",
      "Postgres::Policy": "policy",
      "Postgres::Role": "role",
      "Postgres::Grant": "grant",
      "Postgres::DefaultPrivileges": "defaultPrivileges",
    } as const
  )[o.type];
  return {
    kind,
    ...(o.schema !== undefined && kind !== "schema" && kind !== "extension" && kind !== "role" ? { schema: o.schema } : {}),
    name: o.name,
    ...(o.signature !== undefined ? { signature: o.signature } : {}),
  };
}

/** The comments the extensions' control files set, by extension name. */
async function extensionDefaults(client: PostgresClient, names: readonly string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const rows = await client
    .query<{ name: string; comment: string | null }>("SELECT name, comment FROM pg_catalog.pg_available_extensions WHERE name = ANY($1::text[])", [[...names]])
    .catch(() => []);
  return new Map(rows.filter((r) => r.comment).map((r) => [r.name, r.comment!]));
}

/** After a failed CREATE INDEX CONCURRENTLY: drop the INVALID index it left, and only an INVALID one. */
async function dropInvalidIndex(client: PostgresClient, index: string, log: (line: string) => void): Promise<void> {
  try {
    const [row] = await client.query<{ invalid: boolean }>("SELECT NOT i.indisvalid AS invalid FROM pg_catalog.pg_index i WHERE i.indexrelid = pg_catalog.to_regclass($1)", [index]);
    if (!row?.invalid) return;
    const sql = `DROP INDEX CONCURRENTLY IF EXISTS ${index}`;
    log(sql);
    await client.query(sql);
  } catch {
    // Left for the next apply, which reads it and builds it again.
  }
}

async function prune(
  client: PostgresClient,
  drops: readonly PgDropStatement[],
  liveRawByKey: Map<string, LivePgObject>,
  opts: PostgresApplyOptions,
  timeouts: PostgresApplyTimeouts,
  outcome: PostgresApplyOutcome,
  log: (line: string) => void,
): Promise<void> {
  for (const drop of drops) {
    const raw = liveRawByKey.get(drop.key);
    if (!raw || raw.foreign) continue;
    const address = liveCanonicalAddress(raw);
    const ref = { kind: raw.type, name: refName(address) };
    if (!isChantManaged(raw.comment)) continue; // not chant's: never touched, never reported
    if (!opts.marker?.stack) {
      outcome.notAttempted.push({
        ...ref,
        reason: "not-prunable",
        detail: "the project declares no ownership.stack, so this project's objects cannot be told from another chant project's",
      });
      continue;
    }
    if (!carriesMarker(raw.comment, opts.marker)) continue; // another stack's or env's
    const s = drop.step;
    const t = { lockTimeoutMs: timeouts.lockTimeoutMs, statementTimeoutMs: scansRows(s.class) ? timeouts.scanTimeoutMs : timeouts.statementTimeoutMs };
    try {
      opts.signal?.throwIfAborted();
      for (const set of [`SET lock_timeout = ${ms(t.lockTimeoutMs)}`, `SET statement_timeout = ${ms(t.statementTimeoutMs)}`]) {
        log(set);
        await client.query(set);
      }
      log(s.sql);
      outcome.statements.push({ object: ref.name, sql: s.sql, class: s.class, ...t });
      await client.query(s.sql);
      outcome.pruned.push({ ...ref, deleted: true, statement: s.sql });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const code = err instanceof PostgresQueryError ? err.code : undefined;
      if (code === SQLSTATE_DEPENDENT_OBJECTS) {
        outcome.notAttempted.push({ ...ref, reason: "not-prunable", detail: `${errorText(err, t)}; dropping it would take what depends on it, which this apply does not drop` });
      } else if (code && SQLSTATE_UNDEFINED.has(code)) {
        // Gone with an object dropped before it (a table's own index or sequence).
        outcome.pruned.push({ ...ref, deleted: false, statement: s.sql });
      } else outcome.failed.push({ ...ref, error: `${errorText(err, t)}, at ${s.sql}`, statements: [] });
    }
  }
}

