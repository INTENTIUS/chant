/**
 * `chant query "<sql>"` (#4297): one read-only SQL statement over the
 * snapshots and the Ops records, run in this process with no server.
 *
 * The rows come from the ledgers chant already writes:
 *
 * - the snapshots, `<env>/<lexicon>.json` and `<env>/<stack>__<lexicon>.json`
 *   (`./git.ts` `snapshotStorageKey`), each lexicon's `describeResources`
 *   read, so the inventory works for every lexicon. They are read through the
 *   index store (./snapshot-store.ts, #4519) when the ledger names one, so
 *   the tables are the same whichever store holds them;
 * - the Op run ledgers, `<env>/runs__<op>.jsonl` (`./run-ledger.ts`);
 * - the gate ledgers, `_gates/<op>.jsonl` (`./gate-ledger.ts`);
 * - the deploy records, `<env>/releases.jsonl` (`./release-read.ts`);
 * - the releases and their cuts, `_releases/<digest>.json` and
 *   `_releases/cuts.jsonl` (`./release-store.ts`);
 * - the applies under an approval, `_gates/<op>/applied.jsonl`
 *   (`./gate-applied.ts`), each joined with its `finished` line (#4551);
 * - the pull request environments, `_pr-envs/records.jsonl`
 *   (`../components/pr-environment.ts`, #4551);
 * - the control repo's entries, `_control/entries.jsonl`
 *   (`../control/records.ts`, #4568, #4593).
 *
 * The tables are a contract. {@link QUERY_SCHEMA_VERSION} names it, and the
 * `chant_schema` table lists every table and column with the version, so a
 * saved query can check what it runs against. A column is only added within
 * a version; renaming or removing one, or changing what it holds, is a new
 * version.
 *
 * Everything but {@link runQuery} is pure over a {@link LedgerReadPort}: the
 * caller decides which members to read and how.
 *
 * The engine is `node:sqlite`, the SQLite built into Node.js 22.13 and later.
 * The database is in memory, takes `PRAGMA query_only`, and only a statement
 * that begins with SELECT, WITH or VALUES runs. This mirrors terragucci's
 * `query.ts`, which reads report JSON from a bucket instead.
 */
import type { GateOrigin } from "./gate-origin";
import { parseGateLedger, GATES_DIR, type GateResolutionRecord, type PendingGateRecord } from "./gate-ledger";
import type { LedgerReadPort } from "./ledger-port";
import { parseReleaseLedger, releaseLedgerLines } from "./release-read";
import { CUTS_FILE, parseCuts, parseRelease, RELEASES_DIR, verifyReleaseDigest } from "./release-store";
import { opOfRunLedgerFile, parseRunLedger } from "./run-ledger";
import type { LifecycleSnapshot } from "./types";
import { appliedGatePath, finishedApply, parseAppliedGateFile } from "./gate-applied";
import { PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE, parsePrEnvRecords } from "../components/pr-environment";
import { CONTROL_LEDGER_DIR, CONTROL_LEDGER_FILE, parseControlEntries } from "../control/records";
import { NEXT_RELEASE } from "../release-floors";

/** The version of the table schema below. */
export const QUERY_SCHEMA_VERSION = 1;

type ColumnType = "TEXT" | "INTEGER";

/**
 * Each table's columns, in order, with their SQLite type. A column named in
 * the doc as JSON holds a JSON text, for `json_extract`. Every table starts
 * with `member`: the workspace member whose ledger the row came from, or NULL
 * for a project outside a workspace.
 */
export const QUERY_TABLES = {
  /**
   * One row per resource in each environment's newest snapshot. `attributes`
   * is JSON. `ownership` is chant's marker verdict; `marker_stack` and
   * `marker_env` (#4534) are the stack and env that marker names, read off
   * the resource. `engine_ownership` and `engine_owned_by` (#4534) are an
   * ownership engine's verdict and what bound the node (choudoufu, plunge;
   * the snapshot's `facts.ownership` and `facts.ownedBy`), shown beside
   * chant's and never in place of it. NULL means unknown.
   */
  resources: [["member", "TEXT"], ["env", "TEXT"], ["stack", "TEXT"], ["lexicon", "TEXT"], ["name", "TEXT"], ["type", "TEXT"], ["physical_id", "TEXT"], ["status", "TEXT"], ["last_updated", "TEXT"], ["ownership", "TEXT"], ["attributes", "TEXT"], ["git_sha", "TEXT"], ["observed_at", "TEXT"], ["marker_stack", "TEXT"], ["marker_env", "TEXT"], ["engine_ownership", "TEXT"], ["engine_owned_by", "TEXT"]],
  /** One row per snapshot file: what was observed, when, and how many resources it holds. */
  snapshots: [["member", "TEXT"], ["env", "TEXT"], ["stack", "TEXT"], ["lexicon", "TEXT"], ["git_sha", "TEXT"], ["observed_at", "TEXT"], ["depth", "TEXT"], ["resources", "INTEGER"], ["unobserved", "INTEGER"]],
  /**
   * One row per Op run record. `labels` and `outcomes` are JSON. `root_member`
   * (#4482) is the workspace member whose directory holds the terraform root
   * a TerraformApplyOp run applied, read off its `TerraformRootPath` outcome.
   * NULL means unknown (#4508): any other run, outside a workspace, or a run
   * whose Init step failed before it resolved the root's directory, since the
   * Op names its root only by key and Init is what resolves it. A run whose
   * `terraform init` itself failed still names it (#4512).
   */
  runs: [["member", "TEXT"], ["id", "TEXT"], ["op", "TEXT"], ["env", "TEXT"], ["started", "TEXT"], ["ended", "TEXT"], ["status", "TEXT"], ["git_sha", "TEXT"], ["forge", "TEXT"], ["run_url", "TEXT"], ["failure_code", "TEXT"], ["failure_reason", "TEXT"], ["failed_phase", "TEXT"], ["gate", "TEXT"], ["steward", "TEXT"], ["labels", "TEXT"], ["outcomes", "TEXT"], ["root_member", "TEXT"], ["wave", "TEXT"]],
  /**
   * One row per gate ledger line: `kind` is `pending` or `resolution`.
   * `signed` is 1 for a sealed approval. `change_set` (#4551) is the digest
   * of the stored change set the line cites; `request` (#4551) is the gated
   * request a pending fact asks for, as JSON.
   */
  gates: [["member", "TEXT"], ["op", "TEXT"], ["gate", "TEXT"], ["kind", "TEXT"], ["timestamp", "TEXT"], ["resolved_by", "TEXT"], ["relayed_by", "TEXT"], ["approver_kind", "TEXT"], ["plan_digest", "TEXT"], ["environment", "TEXT"], ["release_digest", "TEXT"], ["git_sha", "TEXT"], ["run_id", "TEXT"], ["url", "TEXT"], ["note", "TEXT"], ["expires_at", "TEXT"], ["origin", "TEXT"], ["empty", "INTEGER"], ["signed", "INTEGER"], ["change_set", "TEXT"], ["request", "TEXT"]],
  /** One row per deploy record in `<env>/releases.jsonl`. `promoted_from`, `restores` and `redeploys` are JSON. */
  deploys: [["member", "TEXT"], ["env", "TEXT"], ["component", "TEXT"], ["digest", "TEXT"], ["git_sha", "TEXT"], ["run_id", "TEXT"], ["forge", "TEXT"], ["run_url", "TEXT"], ["timestamp", "TEXT"], ["actor", "TEXT"], ["approver", "TEXT"], ["release_digest", "TEXT"], ["digest_kind", "TEXT"], ["promoted_from", "TEXT"], ["restores", "TEXT"], ["redeploys", "TEXT"]],
  /** One row per release file whose content hashes to its digest. `envs` joins its targets' environments with commas; `artifacts` is JSON. */
  releases: [["member", "TEXT"], ["release_digest", "TEXT"], ["release_member", "TEXT"], ["git_sha", "TEXT"], ["envs", "TEXT"], ["artifacts", "TEXT"]],
  /** One row per line of `_releases/cuts.jsonl`. `signed` is 1 for a signed cut. */
  cuts: [["member", "TEXT"], ["release_digest", "TEXT"], ["label", "TEXT"], ["actor", "TEXT"], ["timestamp", "TEXT"], ["run_id", "TEXT"], ["forge", "TEXT"], ["channel", "TEXT"], ["signed", "INTEGER"], ["composed_base", "TEXT"]],
  /**
   * One row per `applied` or `changes` line of `_gates/<op>/applied.jsonl`
   * (#4551): an apply under an approval, with the approval it spent, joined
   * with the `finished` line that says how it ended. `finished_at`, `result`
   * and `detail` are NULL while it has none. `wave` and `detail` are JSON.
   */
  applies: [["member", "TEXT"], ["op", "TEXT"], ["gate", "TEXT"], ["kind", "TEXT"], ["plan_digest", "TEXT"], ["approved_at", "TEXT"], ["approved_by", "TEXT"], ["timestamp", "TEXT"], ["run_id", "TEXT"], ["git_sha", "TEXT"], ["wave", "TEXT"], ["finished_at", "TEXT"], ["result", "TEXT"], ["detail", "TEXT"]],
  /**
   * One row per line of `_pr-envs/records.jsonl` (#4551): a pull request
   * environment applied (`up`) or torn down (`down`). `env_member` is the
   * workspace member the record names; `components` and `approvers` are JSON.
   */
  pr_envs: [["member", "TEXT"], ["kind", "TEXT"], ["pr", "INTEGER"], ["env", "TEXT"], ["env_member", "TEXT"], ["template", "TEXT"], ["git_sha", "TEXT"], ["components", "TEXT"], ["plan_digest", "TEXT"], ["result", "TEXT"], ["by", "TEXT"], ["timestamp", "TEXT"], ["expires_at", "TEXT"], ["approvers", "TEXT"], ["reason", "TEXT"], ["run_url", "TEXT"]],
  /**
   * One row per line of the control repo's `_control/entries.jsonl` (#4568,
   * #4593): one version of a project's entry or of the shared defaults.
   * `digest` is the version's own, `prev_digest` the digest of the version
   * it replaced (NULL for an entry's first). `current` is 1 on the newest
   * version of each id, which is the entry's state now (a `retired` one
   * closes it). `settings` and `estates` are JSON. A line whose digest does
   * not match it is counted malformed and left out.
   */
  control_entries: [["member", "TEXT"], ["id", "TEXT"], ["entry", "TEXT"], ["project", "TEXT"], ["state", "TEXT"], ["product", "TEXT"], ["settings", "TEXT"], ["estates", "TEXT"], ["by", "TEXT"], ["timestamp", "TEXT"], ["digest", "TEXT"], ["prev_digest", "TEXT"], ["current", "INTEGER"]],
} as const satisfies Record<string, ReadonlyArray<readonly [string, ColumnType]>>;

/**
 * The first chant that writes `root_member` on a `runs` row, in `chant query`
 * and in `chant ledger runs --json` (#4482, #4500). A contract field added
 * within version 1: a reader treats a row from an older chant as lacking it.
 */
export const LEDGER_ROOT_MEMBER_FLOOR = "0.124.54";

/**
 * The first chant that writes `marker_stack`, `marker_env`,
 * `engine_ownership` and `engine_owned_by` on a `resources` row, in
 * `chant query` and in `chant ledger resources --json` (#4534). Columns added
 * within version 1: a reader treats a row from an older chant as lacking
 * them, which reads as unknown.
 */
export const QUERY_OWNERSHIP_COLUMNS_FLOOR = "0.124.54";

/**
 * The first chant that writes `wave` on a `runs` row and `change_set` and
 * `request` on a `gates` row (#4551). Columns added within version 1: a row
 * from an older chant lacks them.
 */
export const LEDGER_WAVE_COLUMNS_FLOOR = NEXT_RELEASE;

/** The first chant with the `applies` and `pr_envs` tables (#4551), added within version 1. */
export const LEDGER_APPLIES_FLOOR = NEXT_RELEASE;

/** The first chant with the `control_entries` table (#4593), added within version 1. */
export const LEDGER_CONTROL_ENTRIES_FLOOR = NEXT_RELEASE;

export type QueryTable = keyof typeof QUERY_TABLES;

/** The table that describes the others: one row per column, with the schema version. */
export const SCHEMA_TABLE = "chant_schema";

type Value = string | number | null;
export type QueryRow = Record<string, Value>;

/** The rows of each table, as loaded. */
export type QueryData = Record<QueryTable, QueryRow[]>;

/** One ledger to read: a member's, or the project's own with `member` null. */
export interface QueryLedger {
  member: string | null;
  port: LedgerReadPort;
  /**
   * The snapshot family of the index store (#4519, `snapshotReadPort`). Given,
   * the `resources` and `snapshots` rows come from it and snapshot files on
   * `port` are skipped. Absent, they come from `port`, as before the store.
   */
  snapshots?: LedgerReadPort;
  /**
   * The member whose directory holds a workspace-relative path, or null
   * (#4482). Given in a workspace; without it `root_member` is NULL.
   */
  ownerOfPath?: (path: string) => string | null;
}

export interface QueryLoad {
  data: QueryData;
  /** Lines and files that could not be read as their kind, per table. Left out of the rows. */
  malformed: Record<QueryTable, number>;
}

export interface QueryResult {
  schemaVersion: number;
  columns: string[];
  rows: QueryRow[];
  /** How many rows each table held. */
  tables: Record<QueryTable, number>;
  malformed: Record<QueryTable, number>;
}

/** A statement that can't run, or a Node.js with no SQLite. The message is for a person. */
export class QueryError extends Error {}

const TABLE_NAMES = Object.keys(QUERY_TABLES) as QueryTable[];
const empty = <T>(v: () => T): Record<QueryTable, T> => Object.fromEntries(TABLE_NAMES.map((t) => [t, v()])) as Record<QueryTable, T>;
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bit = (v: boolean): number => (v ? 1 : 0);

/** Whether a parsed `.json` file under an environment is a snapshot (an observation baseline or another file is not). */
function isSnapshot(v: unknown): v is LifecycleSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<LifecycleSnapshot>;
  return typeof s.lexicon === "string" && typeof s.environment === "string" && typeof s.commit === "string" && typeof s.timestamp === "string" && !!s.resources && typeof s.resources === "object" && !Array.isArray(s.resources);
}

function snapshotRows(member: string | null, env: string, file: string, s: LifecycleSnapshot, data: QueryData): void {
  // The file name folds the stack in as `<stack>__<lexicon>` (git.ts snapshotStorageKey); the record names it too.
  const key = file.slice(0, -".json".length);
  const stack = s.stack ?? (key.includes("__") ? key.slice(0, key.lastIndexOf("__")) : null);
  const at = { git_sha: s.commit, observed_at: s.timestamp };
  const resources = Object.entries(s.resources);
  data.snapshots.push({ member, env, stack, lexicon: s.lexicon, ...at, depth: s.depth ?? "identity", resources: resources.length, unobserved: Object.keys(s.unobserved ?? {}).length });
  for (const [name, r] of resources) {
    data.resources.push({
      member,
      env,
      stack,
      lexicon: s.lexicon,
      name,
      type: str(r?.type),
      physical_id: str(r?.physicalId),
      status: str(r?.status),
      last_updated: str(r?.lastUpdated),
      ownership: str(r?.ownership),
      attributes: json(r?.attributes),
      ...at,
      // Read as data from the snapshot (#4534): a projection for people, never a decision.
      marker_stack: str(r?.marker?.stack),
      marker_env: str(r?.marker?.env),
      engine_ownership: str(r?.facts?.ownership),
      engine_owned_by: str(r?.facts?.ownedBy),
    });
  }
}

function gateRow(member: string | null, r: GateResolutionRecord | PendingGateRecord): QueryRow {
  const pending = r.kind === "pending";
  const res = pending ? undefined : (r as GateResolutionRecord);
  const origin: GateOrigin | undefined = (r as { origin?: GateOrigin }).origin;
  return {
    member,
    op: r.op,
    gate: r.gate,
    kind: pending ? "pending" : "resolution",
    timestamp: r.timestamp,
    resolved_by: res?.resolvedBy ?? null,
    relayed_by: str(res?.relayedBy),
    approver_kind: str(res?.approver?.kind),
    plan_digest: str(r.planDigest),
    environment: str(r.environment),
    release_digest: str(r.releaseDigest),
    git_sha: str(r.gitSha),
    run_id: str(r.runId),
    url: str(res?.url),
    note: str(res?.note),
    expires_at: pending ? str((r as PendingGateRecord).expiresAt) : null,
    origin: str(origin),
    empty: bit(res?.empty === true),
    signed: bit(res?.seal !== undefined),
    change_set: str((r as { changeSet?: unknown }).changeSet),
    request: pending ? json((r as PendingGateRecord).request) : null,
  };
}

/**
 * The member a run's `TerraformRootPath` outcome falls in (#4482): the
 * workspace-relative directory of the root a TerraformApplyOp's Init step
 * resolved. A local `chant run` records under the member that declares the
 * Op, so this is what names the member whose root it applied when the two
 * differ, as for a choudoufu member applied from a chant one.
 */
function rootMemberOf(outcomes: Record<string, unknown> | undefined, ownerOfPath: ((path: string) => string | null) | undefined): string | null {
  const path = outcomes?.TerraformRootPath;
  if (typeof path !== "string" || !ownerOfPath) return null;
  return ownerOfPath(path);
}

/**
 * Read every table's rows from the ledgers, in the order given. A ledger
 * whose branch is absent reads as no rows. A line or file that is not its
 * kind is counted in `malformed` and left out, as each ledger's own reader
 * does.
 */
export async function loadQueryData(ledgers: readonly QueryLedger[]): Promise<QueryLoad> {
  const data = empty<QueryRow[]>(() => []) as QueryData;
  const malformed = empty(() => 0);
  for (const { member, port, ownerOfPath, snapshots } of ledgers) {
    if (snapshots) {
      for (const env of (await snapshots.trees()).filter((t) => !t.startsWith("_")).sort()) {
        for (const file of (await snapshots.list(env)).sort()) {
          if (!file.endsWith(".json")) continue;
          const text = await snapshots.read(env, file);
          let parsed: unknown;
          try {
            parsed = text === null ? null : JSON.parse(text);
          } catch {
            parsed = null;
          }
          if (isSnapshot(parsed)) snapshotRows(member, env, file, parsed, data);
        }
      }
    }
    const trees = (await port.trees()).sort();
    for (const env of trees.filter((t) => !t.startsWith("_"))) {
      for (const file of (await port.list(env)).sort()) {
        if (file.endsWith(".json")) {
          if (snapshots) continue;
          const text = await port.read(env, file);
          let parsed: unknown;
          try {
            parsed = text === null ? null : JSON.parse(text);
          } catch {
            parsed = null;
          }
          // Other JSON files live beside the snapshots (the observation baseline); only a snapshot-shaped one is read.
          if (isSnapshot(parsed)) snapshotRows(member, env, file, parsed, data);
          continue;
        }
        if (file === "releases.jsonl") {
          const { records, malformed: bad } = parseReleaseLedger(releaseLedgerLines(await port.read(env, file)));
          malformed.deploys += bad;
          for (const d of records) {
            data.deploys.push({ member, env: d.env, component: d.component, digest: d.digest, git_sha: d.gitSha, run_id: d.runId, forge: str(d.runOrigin?.forge), run_url: str(d.runOrigin?.url), timestamp: d.timestamp, actor: d.actor, approver: str(d.approver), release_digest: str(d.releaseDigest), digest_kind: str(d.digestKind), promoted_from: json(d.promotedFrom), restores: json(d.restores), redeploys: json(d.redeploys) });
          }
          continue;
        }
        if (opOfRunLedgerFile(file) !== null) {
          const text = await port.read(env, file);
          if (text === null) continue;
          const { records, malformed: bad } = parseRunLedger(text);
          malformed.runs += bad;
          for (const r of records) {
            data.runs.push({ member, id: r.id, op: r.op, env: r.env, started: r.started, ended: r.ended, status: r.status, git_sha: str(r.gitSha), forge: str(r.runOrigin?.forge), run_url: str(r.runOrigin?.url), failure_code: str(r.failure?.code), failure_reason: str(r.failure?.reason), failed_phase: str(r.failure?.phase), gate: str(r.gate?.name), steward: str(r.steward), labels: json(r.labels ?? {}), outcomes: json(r.outcomes ?? {}), root_member: rootMemberOf(r.outcomes, ownerOfPath), wave: json(r.wave) });
          }
        }
      }
    }
    if (trees.includes(GATES_DIR)) {
      for (const file of (await port.list(GATES_DIR)).sort()) {
        if (!file.endsWith(".jsonl")) continue;
        const text = await port.read(GATES_DIR, file);
        if (text === null) continue;
        const { resolutions, pending, malformed: bad } = parseGateLedger(text);
        malformed.gates += bad;
        // Both kinds share the file; ledger order is time order, so they are merged back by timestamp.
        const lines = [...pending, ...resolutions].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        for (const r of lines) data.gates.push(gateRow(member, r));
      }
      // #4551: each op's applies, `_gates/<op>/applied.jsonl`, joined with their finished lines.
      // A port lists a subdirectory by its name, or (a flat one) by its files' paths under it.
      const ops = [...new Set((await port.list(GATES_DIR)).map((n) => n.split("/")[0]!).filter((n) => !n.includes(".")))].sort();
      for (const name of ops) {
        const { dir, file } = appliedGatePath(name);
        const text = await port.read(dir, file);
        if (text === null) continue;
        const { applied, finished } = parseAppliedGateFile(text);
        for (const a of applied) {
          const done = finishedApply(finished, a);
          data.applies.push({ member, op: a.op || name, gate: a.gate, kind: a.kind, plan_digest: a.planDigest, approved_at: a.approvedAt, approved_by: str(a.approvedBy), timestamp: a.timestamp, run_id: str(a.runId), git_sha: str(a.commit), wave: json(a.wave), finished_at: str(done?.timestamp), result: str(done?.result), detail: json(done?.detail) });
        }
      }
    }
    if (trees.includes(PR_ENV_LEDGER_DIR)) {
      const text = await port.read(PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE);
      for (const r of parsePrEnvRecords(text)) {
        data.pr_envs.push({ member, kind: r.kind, pr: r.pr, env: r.env, env_member: str(r.member), template: str(r.template), git_sha: str(r.commit), components: json(r.components), plan_digest: str(r.planDigest), result: str(r.result), by: str(r.by), timestamp: str(r.timestamp), expires_at: str(r.expiresAt), approvers: json(r.approvedBy), reason: str(r.reason), run_url: str(r.runUrl) });
      }
    }
    // #4593: the control repo's entries, every version, the newest of each id marked current.
    if (trees.includes(CONTROL_LEDGER_DIR)) {
      const { records, malformed: bad } = parseControlEntries(await port.read(CONTROL_LEDGER_DIR, CONTROL_LEDGER_FILE));
      malformed.control_entries += bad.length;
      const newest = new Map<string, number>();
      records.forEach((r, i) => newest.set(r.id, i));
      records.forEach((r, i) => {
        data.control_entries.push({ member, id: r.id, entry: r.entry, project: r.project, state: r.state, product: r.product, settings: json(r.settings), estates: json(r.estates), by: str(r.by), timestamp: r.at, digest: r.digest, prev_digest: r.prev, current: bit(newest.get(r.id) === i) });
      });
    }
    if (trees.includes(RELEASES_DIR)) {
      for (const file of (await port.list(RELEASES_DIR)).sort()) {
        if (file === CUTS_FILE) {
          const { cuts, malformed: bad } = parseCuts(await port.read(RELEASES_DIR, file));
          malformed.cuts += bad;
          for (const c of cuts) {
            data.cuts.push({ member, release_digest: c.releaseDigest, label: c.label, actor: c.actor, timestamp: c.timestamp, run_id: c.runId, forge: str(c.runOrigin?.forge), channel: str(c.channel), signed: bit(c.signature !== null), composed_base: str(c.composed?.base) });
          }
          continue;
        }
        if (!file.endsWith(".json")) continue;
        const text = await port.read(RELEASES_DIR, file);
        const release = text === null ? null : parseRelease(text);
        // `readAllReleases` (release-store.ts) counts a file whose content does not hash to its digest as malformed; so does this.
        if (!release || release.releaseDigest.replace(/:/g, "_") !== file.slice(0, -".json".length) || !verifyReleaseDigest(release)) {
          malformed.releases++;
          continue;
        }
        data.releases.push({ member, release_digest: release.releaseDigest, release_member: release.member, git_sha: release.commit, envs: release.targets.map((t) => t.env).join(","), artifacts: json(release.artifactDigests) });
      }
    }
  }
  return { data, malformed };
}

/** The part of `node:sqlite` this uses, typed here since the repo's @types/node predates the module. */
interface SqliteStatement {
  run(...values: Value[]): unknown;
  all(): unknown[];
  columns?(): Array<{ name: string }>;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void };
}

/** node:sqlite, without the experimental warning some Node.js versions print when it loads. */
async function sqlite(): Promise<SqliteModule> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (/SQLite/.test(typeof warning === "string" ? warning : warning.message)) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const name = "node:sqlite";
    return (await import(name)) as SqliteModule;
  } catch {
    throw new QueryError(`chant query runs on the SQLite built into Node.js 22.13 or later; this is Node.js ${process.versions.node}`);
  } finally {
    process.emitWarning = emit;
  }
}

/** The first word of a statement, past whitespace and comments. */
export function firstWord(sql: string): string {
  const s = sql.replace(/^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/, "");
  return (/^[A-Za-z]+/.exec(s)?.[0] ?? "").toLowerCase();
}

/** Run one read-only statement over the tables. */
export async function runQuery(sql: string, load: QueryLoad): Promise<QueryResult> {
  if (sql.trim() === "") throw new QueryError('chant query needs a statement: chant query "SELECT * FROM resources"');
  if (!["select", "with", "values"].includes(firstWord(sql))) throw new QueryError("chant query runs one SELECT (or WITH, or VALUES) statement; it changes nothing");
  const { DatabaseSync } = await sqlite();
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE ${SCHEMA_TABLE} ("version" INTEGER, "table_name" TEXT, "column_name" TEXT, "type" TEXT, "position" INTEGER)`);
    const describe = db.prepare(`INSERT INTO ${SCHEMA_TABLE} VALUES (?, ?, ?, ?, ?)`);
    for (const table of TABLE_NAMES) {
      const cols = QUERY_TABLES[table] as ReadonlyArray<readonly [string, ColumnType]>;
      db.exec(`CREATE TABLE ${table} (${cols.map(([c, t]) => `"${c}" ${t}`).join(", ")})`);
      cols.forEach(([c, t], i) => describe.run(QUERY_SCHEMA_VERSION, table, c, t, i + 1));
      const insert = db.prepare(`INSERT INTO ${table} VALUES (${cols.map(() => "?").join(", ")})`);
      db.exec("BEGIN");
      for (const row of load.data[table]) insert.run(...cols.map(([c]) => row[c] ?? null));
      db.exec("COMMIT");
    }
    db.exec("PRAGMA query_only = ON");
    let stmt: SqliteStatement;
    try {
      stmt = db.prepare(sql);
    } catch (e) {
      throw new QueryError(`the query does not run: ${(e as Error).message}`);
    }
    let rows: QueryRow[];
    try {
      rows = stmt.all() as QueryRow[];
    } catch (e) {
      throw new QueryError(`the query does not run: ${(e as Error).message}`);
    }
    const columns = typeof stmt.columns === "function" ? stmt.columns().map((c) => c.name) : Object.keys(rows[0] ?? {});
    const tables = Object.fromEntries(TABLE_NAMES.map((t) => [t, load.data[t].length])) as Record<QueryTable, number>;
    return { schemaVersion: QUERY_SCHEMA_VERSION, columns, rows: rows.map((r) => ({ ...r })), tables, malformed: load.malformed };
  } finally {
    db.close();
  }
}

const cell = (v: Value | undefined): string => (v === null || v === undefined ? "" : String(v));

/** The rows as an aligned table, a header and a count. */
export function formatQueryResult(r: QueryResult): string {
  const widths = r.columns.map((c) => Math.max(c.length, ...r.rows.map((row) => cell(row[c]).length)));
  const line = (vals: string[]): string => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(r.columns), line(widths.map((w) => "-".repeat(w))), ...r.rows.map((row) => line(r.columns.map((c) => cell(row[c]))))];
  out.push(`(${r.rows.length} ${r.rows.length === 1 ? "row" : "rows"})`);
  return out.join("\n");
}
