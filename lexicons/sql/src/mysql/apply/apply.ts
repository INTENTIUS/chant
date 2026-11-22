/**
 * The MySQL applier (#5449): make a server hold what a build declares.
 *
 * Per declared object, exactly one verdict (lexicon-authoring/applying.mdx):
 *
 * - APPLIED `created`: absent on the server; created from its declared
 *   `CREATE`, a table with chant's ownership marker as a trailer on its
 *   comment.
 * - APPLIED `updated`: present, and the statements for its changes ran
 *   (`../plan/diff.ts`): a table's in at most three statements, a view's as
 *   `CREATE OR REPLACE VIEW`, a database's as `ALTER DATABASE`. A table that
 *   lacks this project's marker gets it.
 * - APPLIED `unchanged`: present, nothing to change, the marker in place.
 * - NOT-ATTEMPTED `filtered`: a change drops a column, which destroys its
 *   data, and the apply was not asked to prune.
 * - NOT-ATTEMPTED `dependency-failed`: an object it references is not on the
 *   server, because creating it failed or was not attempted.
 * - NOT-ATTEMPTED with the binding's reason: no server to apply to.
 *
 * MySQL commits each DDL statement on its own, so an object whose second
 * statement fails keeps what its first did; the failure lists the statements
 * that ran. A statement the server refuses fails that object, the rest of the
 * apply goes on, and the applier then throws {@link MysqlApplyError} with the
 * outcome so far.
 *
 * Prune, when asked for, drops the tables in the declared databases that the
 * build no longer declares and whose comment carries this project's marker
 * (stack and env). A view or a database has no comment to carry a marker, so
 * neither is ever dropped.
 */

import type { OwnershipMarker } from "@intentius/chant/ownership";
import type { ApplyRef } from "@intentius/chant/apply";
import { SqlApplyError, dependencyFailedDetail, missingDependencies, readBuildObjects, type SqlApplyOutcome } from "../../core/apply";
import { carriesMarker, isChantManaged, stampedComment } from "../../core/ownership";
import type { Keyed } from "../../core/diff";
import { canonicalObject, objectKey, type CanonicalObject, type CanonicalTable } from "../canonical";
import { diffMysqlSchemas, type MysqlChange, type ObjectStatements } from "../plan/diff";
import { checkServer, readLiveSchema, type LiveMysqlObject } from "../live/catalog";
import type { MysqlClient } from "../live/client";
import type { MysqlTarget } from "../live/bind";
import { MYSQL_ENTITY_TYPES, type MysqlEntityType } from "../entities";
import { mysqlString, quoteIdent } from "../names";
import { isTrivia, tokenizeText } from "../tokens";
import { parseMysqlCreate } from "../parser";

/** One declared object, as the build output holds it and the plan compares it. */
export interface MysqlDeclaredObject {
  exportName: string;
  type: MysqlEntityType;
  /** Its key on the server: `table shop.users`. */
  key: string;
  ddl: string;
  canonical: CanonicalObject;
  /** The export names it references. */
  dependsOn: string[];
}

/** The database an unqualified declaration is in, or why there is none. */
export function requireDefaultDatabase(target: Pick<MysqlTarget, "defaultDatabase" | "source">, declared: readonly { ddl: string; type: string }[]): string {
  if (target.defaultDatabase !== undefined) return target.defaultDatabase;
  // A placeholder no MySQL name can equal; an unqualified table or view then names the problem.
  const unqualified = declared.find((o) => o.type !== MYSQL_ENTITY_TYPES.database && (canonicalObject(o.ddl, "\u0000") as { database?: string }).database === "\u0000");
  if (unqualified) {
    throw new Error(`${target.source} names no database, and the build declares ${unqualified.type} without one: name it in the url (mysql://host:3306/shop), set defaultDatabase, or qualify the declaration`);
  }
  return "\u0000";
}

/** The objects a `chant build` output declares, in creation order. */
export function declaredObjects(json: string, defaultDatabase: string): MysqlDeclaredObject[] {
  return readBuildObjects(json, "mysql", (o) => {
    const canonical = canonicalObject(o.ddl, defaultDatabase);
    return { exportName: o.export, type: o.type as MysqlEntityType, key: objectKey(canonical), ddl: o.ddl, canonical, dependsOn: o.dependsOn };
  });
}

/**
 * The order an apply creates in: databases, then tables, each after the
 * tables its foreign keys reference, then views in the build's order. A
 * declaration that names another object as text gives the build no edge to
 * order by, and MySQL refuses a foreign key to a table that does not exist.
 */
export function creationOrder(declared: readonly MysqlDeclaredObject[]): MysqlDeclaredObject[] {
  const rank = (o: MysqlDeclaredObject) => (o.canonical.kind === "database" ? 0 : o.canonical.kind === "table" ? 1 : 2);
  const sorted = [...declared].sort((a, b) => rank(a) - rank(b));
  const byKey = new Map(declared.map((o) => [o.key, o]));
  const out: MysqlDeclaredObject[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (o: MysqlDeclaredObject) => {
    if (done.has(o.key) || visiting.has(o.key)) return;
    visiting.add(o.key);
    for (const dep of referencedKeys(o)) {
      const d = byKey.get(dep);
      if (d) visit(d);
    }
    visiting.delete(o.key);
    done.add(o.key);
    out.push(o);
  };
  for (const o of sorted) visit(o);
  return out;
}

/** The keys of the tables a table's foreign keys reference, and of the database it is in. */
function referencedKeys(o: MysqlDeclaredObject): string[] {
  const c = o.canonical;
  if (c.kind === "database") return [];
  const own = `database ${c.database}`;
  if (c.kind === "view") return [own];
  return [own, ...c.foreignKeys.map((f) => `table ${f.references}`).filter((k) => k !== o.key)];
}

/** The raw objects of a build output, for {@link requireDefaultDatabase} before the default database is known. */
export const buildObjects = (json: string) => readBuildObjects(json, "mysql", (o) => o);

/** The plan axis: one ref per declared object, by its type and its key. */
export const planRefs = (declared: readonly MysqlDeclaredObject[]): ApplyRef[] => declared.map((o) => ({ kind: o.type, name: o.key }));

/** What {@link planAgainstClient} reads and finds. */
export interface MysqlServerPlan {
  live: LiveMysqlObject[];
  liveByKey: Map<string, LiveMysqlObject>;
  changes: MysqlChange[];
  hints: string[];
  statements: Map<string, ObjectStatements>;
  /** Live objects in scope whose statement chant cannot read, with why. */
  unreadable: Array<{ key: string; reason: string }>;
}

/** The databases a plan reads: the profile's, else those the declarations are in. */
export function scopeOf(target: Pick<MysqlTarget, "databases">, declared: readonly MysqlDeclaredObject[]): string[] {
  if (target.databases && target.databases.length > 0) return [...target.databases];
  return [...new Set(declared.map((o) => (o.canonical.kind === "database" ? o.canonical.name : o.canonical.database!)))].sort();
}

/**
 * The declarations against a connected server: the server checked (MySQL
 * 8.0 or Aurora MySQL 3), the databases in scope read, and the changes
 * classified. With `marker` and `prune`, a table the build no longer declares
 * that carries the marker is a drop.
 */
export async function planAgainstClient(
  client: MysqlClient,
  target: Pick<MysqlTarget, "databases" | "defaultDatabase">,
  declared: readonly MysqlDeclaredObject[],
  options: { marker?: OwnershipMarker; prune?: boolean; readLive?: typeof readLiveSchema } = {},
): Promise<MysqlServerPlan> {
  await checkServer(client);
  const live = await (options.readLive ?? readLiveSchema)(client, { databases: scopeOf(target, declared) });
  const liveByKey = new Map<string, LiveMysqlObject>();
  const liveKeyed: Keyed<CanonicalObject>[] = [];
  const unreadable: MysqlServerPlan["unreadable"] = [];
  for (const o of live) {
    const key = objectKey({ kind: o.type === MYSQL_ENTITY_TYPES.database ? "database" : o.type === MYSQL_ENTITY_TYPES.view ? "view" : "table", ...(o.database !== undefined ? { database: o.database } : {}), name: o.name });
    liveByKey.set(key, o);
    try {
      // `SHOW CREATE TABLE` names the table, and a referenced table in its own database, unqualified.
      liveKeyed.push({ key, canonical: canonicalObject(o.statement, o.database ?? target.defaultDatabase ?? "") });
    } catch (err) {
      unreadable.push({ key, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const declaredKeys = new Set(declared.map((o) => o.key));
  const diff = diffMysqlSchemas(
    liveKeyed,
    declared.map((o) => ({ key: o.key, canonical: o.canonical })),
    { droppable: (o) => options.prune === true && o.canonical.kind === "table" && !declaredKeys.has(o.key) && options.marker?.stack !== undefined && carriesMarker(liveByKey.get(o.key)?.comment, options.marker) },
  );
  return { live, liveByKey, changes: diff.changes, hints: diff.hints, statements: diff.statements, unreadable: unreadable.filter((u) => declaredKeys.has(u.key)) };
}

export interface MysqlApplyOptions {
  /** The marker to stamp, and the identity a prune matches. Without a stack, prune declines. */
  marker?: OwnershipMarker;
  /** Drop owned tables the build no longer declares, and allow column drops. Default: off. */
  prune?: boolean;
  signal?: AbortSignal;
  /** Where to report each statement. Default: nowhere. */
  log?: (line: string) => void;
  /** A catalog reader in place of the server's (tests). */
  readLive?: typeof readLiveSchema;
}

/** The shared core's outcome: `target` is the server's URL, `source` where the binding came from. */
export type MysqlApplyOutcome = SqlApplyOutcome;

/** An apply in which the server refused a statement. The outcome says what did and did not happen. */
export class MysqlApplyError extends SqlApplyError<MysqlApplyOutcome> {
  constructor(outcome: MysqlApplyOutcome) {
    super("MySQL", outcome);
    this.name = "MysqlApplyError";
  }
}

/** A table's `CREATE` with `comment` as its table comment, in place of the one it declares or after its options. */
export function withTableComment(ddl: string, comment: string): string {
  const tokens = tokenizeText(ddl, 0);
  const node = parseMysqlCreate(tokens);
  if (node.statement !== "table") return ddl;
  const option = node.options.find((o) => o.key === "COMMENT");
  const text = `COMMENT = ${mysqlString(comment)}`;
  if (!option) return `${ddl.replace(/\s*;\s*$/, "")} ${text}`;
  // From the COMMENT word (the significant token before the value, or before `=`) to the end of its value.
  let from = option.value.from - 1;
  while (from > 0 && (isTrivia(tokens[from]!) || (tokens[from]!.kind === "punct" && tokens[from]!.text === "="))) from--;
  return tokens.slice(0, from).map((t) => t.text).join("") + text + tokens.slice(option.value.to).map((t) => t.text).join("");
}

/** A view's declared `CREATE [OR REPLACE] ... VIEW` as `CREATE OR REPLACE ... VIEW`. */
export const createOrReplace = (ddl: string): string => ddl.replace(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?/i, "CREATE OR REPLACE ");

const tableSql = (t: { database?: string; name: string }) => (t.database ? `${quoteIdent(t.database)}.${quoteIdent(t.name)}` : quoteIdent(t.name));

/** The statements one declared object takes, given its changes. Empty when there is nothing to do. */
export function objectStatements(obj: MysqlDeclaredObject, created: boolean, planned: ObjectStatements | undefined, live: LiveMysqlObject | undefined, marker: OwnershipMarker | undefined): string[] {
  const c = obj.canonical;
  if (created) return [c.kind === "table" ? withTableComment(obj.ddl, stampedComment(c.comment, marker)) : obj.ddl];
  if (c.kind === "view") return planned ? [createOrReplace(obj.ddl)] : [];
  if (c.kind === "database") return planned?.statement ? [planned.statement] : [];
  const table = c as CanonicalTable;
  const clauses = [...(planned?.clauses ?? [])].filter((x) => !x.startsWith("COMMENT = "));
  const stamped = stampedComment(table.comment, marker);
  const commentChanged = planned?.clauses.some((x) => x.startsWith("COMMENT = ")) === true;
  if (commentChanged || !carriesMarker(live?.comment, marker)) clauses.push(`COMMENT = ${mysqlString(stamped)}`);
  return [...(planned?.before ?? []), ...(clauses.length > 0 ? [`ALTER TABLE ${tableSql(table)} ${clauses.join(", ")}`] : [])];
}

/**
 * Apply the declarations to the server. Returns every declared object in
 * exactly one of applied or not attempted, and every pruned table; throws
 * {@link MysqlApplyError} when the server refused a statement.
 */
export async function applyMysql(client: MysqlClient, target: MysqlTarget, declared: readonly MysqlDeclaredObject[], opts: MysqlApplyOptions = {}): Promise<MysqlApplyOutcome> {
  const log = opts.log ?? (() => undefined);
  const plan = await planAgainstClient(client, target, declared, { ...(opts.marker ? { marker: opts.marker } : {}), ...(opts.prune ? { prune: true } : {}), ...(opts.readLive ? { readLive: opts.readLive } : {}) });
  const outcome: MysqlApplyOutcome = { target: redact(target.endpoint.url), source: target.source, applied: [], pruned: [], notAttempted: [], failed: [] };
  const byObject = new Map<string, MysqlChange[]>();
  for (const c of plan.changes) byObject.set(c.object, [...(byObject.get(c.object) ?? []), c]);
  const unreadable = new Map(plan.unreadable.map((u) => [u.key, u.reason]));
  const onServer = new Set<string>();
  const exportNames = new Set(declared.map((o) => o.exportName));

  const exportOf = new Map(declared.map((o) => [o.key, o.exportName]));
  for (const obj of creationOrder(declared)) {
    const ref = { kind: obj.type, name: obj.key };
    const changes = byObject.get(obj.key) ?? [];
    const created = changes.some((c) => c.rule === "SQLMY200");
    const renamedFrom = changes.find((c) => c.rule === "SQLMY221")?.before;
    const live = plan.liveByKey.get(renamedFrom !== undefined ? `table ${renamedFrom}` : obj.key);
    if (unreadable.has(obj.key)) {
      onServer.add(obj.exportName);
      outcome.notAttempted.push({ ...ref, reason: "unsupported-kind", detail: `the server's definition cannot be read as a declaration: ${unreadable.get(obj.key)}` });
      continue;
    }
    const drops = changes.filter((c) => c.destructive);
    if (drops.length > 0 && !opts.prune) {
      onServer.add(obj.exportName);
      outcome.notAttempted.push({ ...ref, reason: "filtered", detail: `drops ${drops.map((c) => c.field.replace(/^columns\./, "column ")).join(", ")}, which destroys data; apply with prune to drop` });
      continue;
    }
    const statements = objectStatements(obj, created, plan.statements.get(obj.key), live, opts.marker);
    if (statements.length === 0) {
      onServer.add(obj.exportName);
      outcome.applied.push({ ...ref, action: "unchanged", statements: [] });
      continue;
    }
    const needs = [...new Set([...obj.dependsOn, ...referencedKeys(obj).map((k) => exportOf.get(k)).filter((e): e is string => e !== undefined)])];
    const missing = missingDependencies(obj.exportName, needs, exportNames, onServer);
    if (missing.length > 0) {
      if (!created) onServer.add(obj.exportName);
      outcome.notAttempted.push({ ...ref, reason: "dependency-failed", detail: dependencyFailedDetail(missing) });
      continue;
    }
    const ran: string[] = [];
    try {
      for (const sql of statements) {
        opts.signal?.throwIfAborted();
        log(sql);
        await client.query(sql);
        ran.push(sql);
      }
      onServer.add(obj.exportName);
      outcome.applied.push({ ...ref, action: created ? "created" : "updated", statements: ran });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (!created) onServer.add(obj.exportName);
      outcome.failed.push({ ...ref, error: err instanceof Error ? err.message : String(err), statements: ran });
    }
  }

  if (opts.prune) await prune(client, plan, declared, opts, outcome, log);
  if (outcome.failed.length > 0) throw new MysqlApplyError(outcome);
  return outcome;
}

async function prune(client: MysqlClient, plan: MysqlServerPlan, declared: readonly MysqlDeclaredObject[], opts: MysqlApplyOptions, outcome: MysqlApplyOutcome, log: (line: string) => void): Promise<void> {
  const declaredKeys = new Set(declared.map((o) => o.key));
  const renamed = new Set(plan.changes.filter((c) => c.rule === "SQLMY221" && c.before !== undefined).map((c) => `table ${c.before}`));
  for (const [key, o] of plan.liveByKey) {
    if (o.type !== MYSQL_ENTITY_TYPES.table || declaredKeys.has(key) || renamed.has(key)) continue;
    if (!isChantManaged(o.comment)) continue; // not chant's: never touched, never reported
    const ref = { kind: o.type, name: key };
    if (!opts.marker?.stack) {
      outcome.notAttempted.push({ ...ref, reason: "not-prunable", detail: "the project declares no ownership.stack, so this project's tables cannot be told from another chant project's" });
      continue;
    }
    if (!carriesMarker(o.comment, opts.marker)) continue; // another stack's or env's
    const sql = `DROP TABLE ${tableSql(o)}`;
    try {
      opts.signal?.throwIfAborted();
      log(sql);
      await client.query(sql);
      outcome.pruned.push({ ...ref, deleted: true, statement: sql });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      outcome.failed.push({ ...ref, error: err instanceof Error ? err.message : String(err), statements: [] });
    }
  }
}

/** A URL with any password in it taken out, for a message. */
export const redact = (url: string): string => url.replace(/^(mysql:\/\/[^:/@]+):[^@]*@/i, "$1:***@");

