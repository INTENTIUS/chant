/**
 * `chant query "<sql>"` (#4297): one read-only SQL statement over what
 * `chant/lifecycle` holds, run in this process with no server.
 *
 * The rows come from the ledgers chant already writes:
 *
 * - the snapshots, `<env>/<lexicon>.json` and `<env>/<stack>__<lexicon>.json`
 *   (`./git.ts` `snapshotStorageKey`), each lexicon's `describeResources`
 *   read, so the inventory works for every lexicon;
 * - the Op run ledgers, `<env>/runs__<op>.jsonl` (`./run-ledger.ts`);
 * - the gate ledgers, `_gates/<op>.jsonl` (`./gate-ledger.ts`);
 * - the deploy records, `<env>/releases.jsonl` (`./release-read.ts`);
 * - the releases and their cuts, `_releases/<digest>.json` and
 *   `_releases/cuts.jsonl` (`./release-store.ts`);
 * - the converge ticks, `<env>/converge.jsonl` (`./converge-ledger.ts`), and
 *   the deploy outcomes, `<env>/outcomes.jsonl` (`./deploy-outcome.ts`),
 *   added in #4329;
 * - the build manifests, `_builds/<digest>.json` (`./build-ledger-store.ts`),
 *   the stored change sets, `_change-sets/<digest>.json`
 *   (`./change-set-store.ts`), and the work lease histories,
 *   `_leases/<item>.jsonl` (`./work-lease.ts`), added in #4329.
 *
 * A product with records of its own, kept somewhere else, hands them in as a
 * {@link QuerySource} (#4329): its tables sit beside chant's in the same
 * database, so one statement joins them.
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
 * that begins with SELECT, WITH or VALUES runs.
 */
import { changeSetFile, parseStoredChangeSet, CHANGE_SETS_DIR } from "./change-set-store";
import { CONVERGE_FILE, parseConvergeLedger } from "./converge-ledger";
import { OUTCOMES_FILE, parseDeployOutcomes } from "./deploy-outcome";
import type { GateOrigin } from "./gate-origin";
import { parseGateLedger, GATES_DIR, type GateResolutionRecord, type PendingGateRecord } from "./gate-ledger";
import type { LedgerReadPort } from "./ledger-port";
import { parseReleaseLedger, releaseLedgerLines } from "./release-read";
import { CUTS_FILE, parseCuts, parseRelease, RELEASES_DIR, verifyReleaseDigest } from "./release-store";
import { opOfRunLedgerFile, parseRunLedger } from "./run-ledger";
import type { LifecycleSnapshot } from "./types";
import { BUILDS_DIR } from "./build-ledger-store";
import { hasLegacyContentDigest } from "./legacy-digest";
import { LEASES_DIR, parseLeaseHistory } from "./work-lease";
import type { BuildArchiveManifest } from "../components/verbs/build-archive";

/** The version of the table schema below. */
export const QUERY_SCHEMA_VERSION = 1;

export type QueryColumnType = "TEXT" | "INTEGER" | "REAL";
type ColumnType = QueryColumnType;

/**
 * Each table's columns, in order, with their SQLite type. A column named in
 * the doc as JSON holds a JSON text, for `json_extract`. Every table starts
 * with `member`: the workspace member whose ledger the row came from, or NULL
 * for a project outside a workspace.
 */
export const QUERY_TABLES = {
  /** One row per resource in each environment's newest snapshot. `attributes` is JSON. */
  resources: [["member", "TEXT"], ["env", "TEXT"], ["stack", "TEXT"], ["lexicon", "TEXT"], ["name", "TEXT"], ["type", "TEXT"], ["physical_id", "TEXT"], ["status", "TEXT"], ["last_updated", "TEXT"], ["ownership", "TEXT"], ["attributes", "TEXT"], ["git_sha", "TEXT"], ["observed_at", "TEXT"]],
  /** One row per snapshot file: what was observed, when, and how many resources it holds. */
  snapshots: [["member", "TEXT"], ["env", "TEXT"], ["stack", "TEXT"], ["lexicon", "TEXT"], ["git_sha", "TEXT"], ["observed_at", "TEXT"], ["depth", "TEXT"], ["resources", "INTEGER"], ["unobserved", "INTEGER"]],
  /** One row per Op run record. `labels` and `outcomes` are JSON. */
  runs: [["member", "TEXT"], ["id", "TEXT"], ["op", "TEXT"], ["env", "TEXT"], ["started", "TEXT"], ["ended", "TEXT"], ["status", "TEXT"], ["git_sha", "TEXT"], ["forge", "TEXT"], ["run_url", "TEXT"], ["failure_code", "TEXT"], ["failure_reason", "TEXT"], ["failed_phase", "TEXT"], ["gate", "TEXT"], ["steward", "TEXT"], ["labels", "TEXT"], ["outcomes", "TEXT"]],
  /** One row per gate ledger line: `kind` is `pending` or `resolution`. `signed` is 1 for a sealed approval. */
  gates: [["member", "TEXT"], ["op", "TEXT"], ["gate", "TEXT"], ["kind", "TEXT"], ["timestamp", "TEXT"], ["resolved_by", "TEXT"], ["relayed_by", "TEXT"], ["approver_kind", "TEXT"], ["plan_digest", "TEXT"], ["environment", "TEXT"], ["release_digest", "TEXT"], ["git_sha", "TEXT"], ["run_id", "TEXT"], ["url", "TEXT"], ["note", "TEXT"], ["expires_at", "TEXT"], ["origin", "TEXT"], ["empty", "INTEGER"], ["signed", "INTEGER"]],
  /** One row per deploy record in `<env>/releases.jsonl`. `promoted_from`, `restores` and `redeploys` are JSON. */
  deploys: [["member", "TEXT"], ["env", "TEXT"], ["component", "TEXT"], ["digest", "TEXT"], ["git_sha", "TEXT"], ["run_id", "TEXT"], ["forge", "TEXT"], ["run_url", "TEXT"], ["timestamp", "TEXT"], ["actor", "TEXT"], ["approver", "TEXT"], ["release_digest", "TEXT"], ["digest_kind", "TEXT"], ["promoted_from", "TEXT"], ["restores", "TEXT"], ["redeploys", "TEXT"]],
  /** One row per release file whose content hashes to its digest. `envs` joins its targets' environments with commas; `artifacts` is JSON. */
  releases: [["member", "TEXT"], ["release_digest", "TEXT"], ["release_member", "TEXT"], ["git_sha", "TEXT"], ["envs", "TEXT"], ["artifacts", "TEXT"]],
  /** One row per line of `_releases/cuts.jsonl`. `signed` is 1 for a signed cut. */
  cuts: [["member", "TEXT"], ["release_digest", "TEXT"], ["label", "TEXT"], ["actor", "TEXT"], ["timestamp", "TEXT"], ["run_id", "TEXT"], ["forge", "TEXT"], ["channel", "TEXT"], ["signed", "INTEGER"], ["composed_base", "TEXT"]],
  /** One row per ConvergeOp tick in `<env>/converge.jsonl` (#4329). The counts are the tick's summary; `fired_rule_ids`, `outcomes`, `components` and `resources` are JSON. */
  converge: [["member", "TEXT"], ["env", "TEXT"], ["id", "TEXT"], ["op", "TEXT"], ["timestamp", "TEXT"], ["fired_rule_ids", "TEXT"], ["outcomes", "TEXT"], ["components", "TEXT"], ["resources", "TEXT"], ["drifted", "INTEGER"], ["remediated", "INTEGER"], ["reported", "INTEGER"], ["skipped_budget", "INTEGER"], ["skipped_flap", "INTEGER"], ["unobserved", "INTEGER"], ["adopted", "INTEGER"], ["gated", "INTEGER"], ["log", "TEXT"]],
  /** One row per component of each deploy outcome in `<env>/outcomes.jsonl` (#4329): a promote, rollback or redeploy that failed or stopped at a gate. `status` is the run's, `outcome` the component's. */
  deploy_outcomes: [["member", "TEXT"], ["env", "TEXT"], ["verb", "TEXT"], ["run_id", "TEXT"], ["timestamp", "TEXT"], ["actor", "TEXT"], ["release_digest", "TEXT"], ["status", "TEXT"], ["component", "TEXT"], ["outcome", "TEXT"], ["digest", "TEXT"], ["component_release_digest", "TEXT"]],
  /** One row per build manifest in `_builds/` (#4329). `artifacts` counts its entries; `legacy_digest` is 1 when it holds digests from before real SHA-256. */
  builds: [["member", "TEXT"], ["manifest_digest", "TEXT"], ["component", "TEXT"], ["created_at", "TEXT"], ["artifacts", "INTEGER"], ["legacy_digest", "INTEGER"]],
  /** One row per entry of each build manifest (#4329): `kind` is image, template, asset or sbom. */
  build_artifacts: [["member", "TEXT"], ["manifest_digest", "TEXT"], ["component", "TEXT"], ["kind", "TEXT"], ["path", "TEXT"], ["digest", "TEXT"], ["media_type", "TEXT"], ["subject_digest", "TEXT"], ["package_count", "INTEGER"], ["generator", "TEXT"]],
  /** One row per stored change set in `_change-sets/` whose content hashes to its digest (#4329). `plans` is JSON, one object per member with its lexicon, planner, status and plan digest; `actions` is JSON, the count of each action; `failed` is JSON. */
  change_sets: [["member", "TEXT"], ["digest", "TEXT"], ["release_digest", "TEXT"], ["environment", "TEXT"], ["chant", "TEXT"], ["plans", "TEXT"], ["entries", "INTEGER"], ["holes", "INTEGER"], ["actions", "TEXT"], ["failed", "TEXT"], ["graph_member", "TEXT"], ["graph_at", "TEXT"]],
  /** One row per entry of each stored change set (#4329). `set_member` is the member the entry plans for, inside the document; `plan_digest` is that member's. `importing` is 1 for an entry that imports. `attributes` is JSON. */
  change_set_entries: [["member", "TEXT"], ["digest", "TEXT"], ["set_member", "TEXT"], ["lexicon", "TEXT"], ["planner", "TEXT"], ["address", "TEXT"], ["type", "TEXT"], ["name", "TEXT"], ["module", "TEXT"], ["deposed", "TEXT"], ["physical_id", "TEXT"], ["action", "TEXT"], ["importing", "INTEGER"], ["disruption", "TEXT"], ["region", "TEXT"], ["scope", "TEXT"], ["node", "TEXT"], ["source", "TEXT"], ["plan_digest", "TEXT"], ["attributes", "TEXT"]],
  /** One row per line of each work lease history, `_leases/<item>.jsonl` (#4329): `event` is claim, renew or release; `written_by` is who wrote the line. */
  leases: [["member", "TEXT"], ["item", "TEXT"], ["event", "TEXT"], ["holder", "TEXT"], ["written_by", "TEXT"], ["token", "TEXT"], ["acquired_at", "TEXT"], ["expires_at", "TEXT"], ["timestamp", "TEXT"], ["outcome", "TEXT"], ["note", "TEXT"]],
} as const satisfies Record<string, ReadonlyArray<readonly [string, ColumnType]>>;

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
}

export interface QueryLoad {
  data: QueryData;
  /** Lines and files that could not be read as their kind, per table. Left out of the rows. */
  malformed: Record<QueryTable, number>;
}

/**
 * A product's own records, as tables beside chant's (#4329). The product
 * reads them however it keeps them and hands in the rows; chant creates the
 * tables, lists them in `chant_schema` under the source's name and version,
 * and runs the statement over all of them. A table may not take the name of
 * a chant table or of `chant_schema`, and every name is lower-case letters,
 * digits and `_`.
 */
export interface QuerySource {
  /** The product, such as `terragucci`: `chant_schema.source` for its tables. */
  name: string;
  /** The product's own schema version for these tables: `chant_schema.version` on their rows. */
  version: number;
  tables: Record<string, { columns: ReadonlyArray<readonly [string, QueryColumnType]>; rows: readonly QueryRow[] }>;
}

export interface QueryOptions {
  /** Products' tables to add beside chant's. */
  sources?: readonly QuerySource[];
}

export interface QueryResult {
  schemaVersion: number;
  columns: string[];
  rows: QueryRow[];
  /** How many rows each table held, a source's tables included. */
  tables: Record<string, number>;
  malformed: Record<QueryTable, number>;
}

/** A statement that can't run, or a Node.js with no SQLite. The message is for a person. */
export class QueryError extends Error {}

const TABLE_NAMES = Object.keys(QUERY_TABLES) as QueryTable[];
const empty = <T>(v: () => T): Record<QueryTable, T> => Object.fromEntries(TABLE_NAMES.map((t) => [t, v()])) as Record<QueryTable, T>;
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bit = (v: boolean): number => (v ? 1 : 0);
/** A summary count, 0 when an older record has none (`ConvergeTickRecord.summary.gated` came later). */
const n = (v: unknown): number => (typeof v === "number" ? v : 0);

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
    data.resources.push({ member, env, stack, lexicon: s.lexicon, name, type: str(r?.type), physical_id: str(r?.physicalId), status: str(r?.status), last_updated: str(r?.lastUpdated), ownership: str(r?.ownership), attributes: json(r?.attributes), ...at });
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
  };
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
  for (const { member, port } of ledgers) {
    const trees = (await port.trees()).sort();
    for (const env of trees.filter((t) => !t.startsWith("_"))) {
      for (const file of (await port.list(env)).sort()) {
        if (file.endsWith(".json")) {
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
        if (file === CONVERGE_FILE) {
          const { records, malformed: bad } = parseConvergeLedger(await port.read(env, file));
          malformed.converge += bad;
          for (const t of records) {
            data.converge.push({ member, env: t.env, id: str(t.id), op: t.op, timestamp: t.timestamp, fired_rule_ids: json(t.firedRuleIds), outcomes: json(t.outcomes ?? []), components: json(t.components), resources: json(t.resources), drifted: n(t.summary?.drifted), remediated: n(t.summary?.remediated), reported: n(t.summary?.reported), skipped_budget: n(t.summary?.skippedBudget), skipped_flap: n(t.summary?.skippedFlap), unobserved: n(t.summary?.unobserved), adopted: n(t.summary?.adopted), gated: n(t.summary?.gated), log: str(t.log) });
          }
          continue;
        }
        if (file === OUTCOMES_FILE) {
          const { outcomes, malformed: bad } = parseDeployOutcomes(await port.read(env, file));
          malformed.deploy_outcomes += bad;
          for (const o of outcomes) {
            for (const c of o.components) {
              data.deploy_outcomes.push({ member, env: o.env, verb: o.verb, run_id: o.runId, timestamp: o.timestamp, actor: o.actor, release_digest: str(o.releaseDigest), status: o.status, component: c.component, outcome: c.outcome, digest: c.digest, component_release_digest: str(c.releaseDigest) });
            }
          }
          continue;
        }
        if (opOfRunLedgerFile(file) !== null) {
          const text = await port.read(env, file);
          if (text === null) continue;
          const { records, malformed: bad } = parseRunLedger(text);
          malformed.runs += bad;
          for (const r of records) {
            data.runs.push({ member, id: r.id, op: r.op, env: r.env, started: r.started, ended: r.ended, status: r.status, git_sha: str(r.gitSha), forge: str(r.runOrigin?.forge), run_url: str(r.runOrigin?.url), failure_code: str(r.failure?.code), failure_reason: str(r.failure?.reason), failed_phase: str(r.failure?.phase), gate: str(r.gate?.name), steward: str(r.steward), labels: json(r.labels ?? {}), outcomes: json(r.outcomes ?? {}) });
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
    if (trees.includes(BUILDS_DIR)) {
      for (const file of (await port.list(BUILDS_DIR)).sort()) {
        if (!file.endsWith(".json")) continue;
        const m = parseJson(await port.read(BUILDS_DIR, file)) as Partial<BuildArchiveManifest> | null;
        // `readBuildManifest` (build-ledger-store.ts) reads any JSON; a row needs the digest it is keyed by and its entries.
        if (!m || typeof m.manifestDigest !== "string" || typeof m.component !== "string" || !Array.isArray(m.contents)) {
          malformed.builds++;
          continue;
        }
        const contents = m.contents.filter((e) => e && typeof e === "object");
        const legacy = hasLegacyContentDigest([m.manifestDigest, ...contents.map((e) => e.digest)]);
        data.builds.push({ member, manifest_digest: m.manifestDigest, component: m.component, created_at: str(m.createdAt), artifacts: contents.length, legacy_digest: bit(legacy) });
        for (const e of contents) {
          data.build_artifacts.push({ member, manifest_digest: m.manifestDigest, component: m.component, kind: str(e.kind), path: str(e.path), digest: str(e.digest), media_type: str(e.mediaType), subject_digest: str(e.subjectDigest), package_count: typeof e.packageCount === "number" ? e.packageCount : null, generator: str(e.generator) });
        }
      }
    }
    if (trees.includes(CHANGE_SETS_DIR)) {
      for (const file of (await port.list(CHANGE_SETS_DIR)).sort()) {
        if (!file.endsWith(".json")) continue;
        const text = await port.read(CHANGE_SETS_DIR, file);
        // The file is named for its digest (change-set-store.ts changeSetFile), and `parseStoredChangeSet` checks the content hashes to it.
        const named = (parseJson(text) as { digest?: unknown } | null)?.digest;
        const read = text === null || typeof named !== "string" || changeSetFile(named) !== file ? null : parseStoredChangeSet(text, named);
        if (!read || read.status !== "found") {
          malformed.change_sets++;
          continue;
        }
        const doc = read.document;
        const plans = new Map(doc.members.map((m) => [m.member, m.planDigest]));
        data.change_sets.push({ member, digest: doc.digest, release_digest: str(doc.releaseDigest), environment: str(doc.environment), chant: str(doc.chant), plans: json(doc.members.map((m) => ({ member: m.member, lexicon: m.lexicon, planner: m.planner, status: m.status, planDigest: m.planDigest, ...(m.provisional ? { provisional: true } : {}), holes: m.holes.length }))), entries: doc.entries.length, holes: doc.members.reduce((sum, m) => sum + m.holes.length, 0), actions: json(doc.summary?.actions ?? {}), failed: json(doc.summary?.failed ?? []), graph_member: str(doc.graph?.member), graph_at: str(doc.graph?.at) });
        for (const e of doc.entries) {
          data.change_set_entries.push({ member, digest: doc.digest, set_member: e.member, lexicon: e.lexicon, planner: e.planner, address: e.address, type: e.type, name: str(e.name), module: str(e.module), deposed: str(e.deposed), physical_id: str(e.id), action: e.action, importing: bit(e.importing === true), disruption: str(e.disruption), region: str(e.region), scope: str(e.scope), node: str(e.node), source: str(e.source), plan_digest: plans.get(e.member) ?? null, attributes: json(e.attributes) });
        }
      }
    }
    if (trees.includes(LEASES_DIR)) {
      for (const file of (await port.list(LEASES_DIR)).sort()) {
        if (!file.endsWith(".jsonl")) continue;
        const text = await port.read(LEASES_DIR, file);
        if (text === null) continue;
        const { records, malformed: bad } = parseLeaseHistory(text);
        malformed.leases += bad;
        for (const r of records) {
          data.leases.push({ member, item: r.item, event: r.event, holder: r.holder, written_by: r.by, token: r.token, acquired_at: r.acquiredAt, expires_at: r.expiresAt, timestamp: r.timestamp, outcome: str(r.outcome), note: str(r.note) });
        }
      }
    }
  }
  return { data, malformed };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

const NAME = /^[a-z_][a-z0-9_]*$/;
const COLUMN_TYPES: readonly QueryColumnType[] = ["TEXT", "INTEGER", "REAL"];

/** The source tables to create, checked: names that are safe to write unquoted and taken by no chant table or other source. */
function sourceTables(sources: readonly QuerySource[]): Array<{ source: QuerySource; table: string; columns: ReadonlyArray<readonly [string, QueryColumnType]>; rows: readonly QueryRow[] }> {
  const taken = new Set<string>([...TABLE_NAMES, SCHEMA_TABLE]);
  const out: ReturnType<typeof sourceTables> = [];
  for (const source of sources) {
    for (const [table, { columns, rows }] of Object.entries(source.tables)) {
      if (!NAME.test(table)) throw new QueryError(`${source.name}'s table ${JSON.stringify(table)} is not a name chant query takes: lower-case letters, digits and _`);
      if (taken.has(table)) throw new QueryError(`${source.name}'s table ${table} takes the name of ${(TABLE_NAMES as string[]).includes(table) || table === SCHEMA_TABLE ? "a chant table" : "another source's table"}`);
      const seen = new Set<string>();
      for (const [c, t] of columns) {
        if (!NAME.test(c) || seen.has(c)) throw new QueryError(`${source.name}'s table ${table} has a column ${JSON.stringify(c)} that is not a unique name of lower-case letters, digits and _`);
        if (!COLUMN_TYPES.includes(t)) throw new QueryError(`${source.name}'s column ${table}.${c} has type ${String(t)}; a column is TEXT, INTEGER or REAL`);
        seen.add(c);
      }
      if (columns.length === 0) throw new QueryError(`${source.name}'s table ${table} has no columns`);
      taken.add(table);
      out.push({ source, table, columns, rows });
    }
  }
  return out;
}

/** A message for a statement SQLite refused, with a hint when a bare column name is an SQL keyword. */
function refused(e: unknown, columns: ReadonlySet<string>): QueryError {
  const m = (e as Error).message;
  const near = /near "([A-Za-z_]+)": syntax error/.exec(m)?.[1];
  return new QueryError(`the query does not run: ${m}${near && columns.has(near.toLowerCase()) ? `; ${near} is an SQL keyword, so quote the column: "${near.toLowerCase()}"` : ""}`);
}

/**
 * Run one read-only statement over the tables, and over the tables of each
 * source in `options.sources` (#4329).
 */
export async function runQuery(sql: string, load: QueryLoad, options: QueryOptions = {}): Promise<QueryResult> {
  if (sql.trim() === "") throw new QueryError('chant query needs a statement: chant query "SELECT * FROM resources"');
  if (!["select", "with", "values"].includes(firstWord(sql))) throw new QueryError("chant query runs one SELECT (or WITH, or VALUES) statement; it changes nothing");
  const extra = sourceTables(options.sources ?? []);
  const { DatabaseSync } = await sqlite();
  const db = new DatabaseSync(":memory:");
  const columnNames = new Set<string>();
  try {
    // `source` came after `position` (#4329), so a column's place in chant_schema is what it was in #4297.
    db.exec(`CREATE TABLE ${SCHEMA_TABLE} ("version" INTEGER, "table_name" TEXT, "column_name" TEXT, "type" TEXT, "position" INTEGER, "source" TEXT)`);
    const describe = db.prepare(`INSERT INTO ${SCHEMA_TABLE} VALUES (?, ?, ?, ?, ?, ?)`);
    const create = (table: string, cols: ReadonlyArray<readonly [string, ColumnType]>, rows: readonly QueryRow[], version: number, source: string): void => {
      db.exec(`CREATE TABLE ${table} (${cols.map(([c, t]) => `"${c}" ${t}`).join(", ")})`);
      cols.forEach(([c, t], i) => {
        describe.run(version, table, c, t, i + 1, source);
        columnNames.add(c);
      });
      const insert = db.prepare(`INSERT INTO ${table} VALUES (${cols.map(() => "?").join(", ")})`);
      db.exec("BEGIN");
      for (const row of rows) insert.run(...cols.map(([c]) => row[c] ?? null));
      db.exec("COMMIT");
    };
    for (const table of TABLE_NAMES) create(table, QUERY_TABLES[table] as ReadonlyArray<readonly [string, ColumnType]>, load.data[table], QUERY_SCHEMA_VERSION, "chant");
    for (const t of extra) create(t.table, t.columns, t.rows, t.source.version, t.source.name);
    db.exec("PRAGMA query_only = ON");
    let stmt: SqliteStatement;
    try {
      stmt = db.prepare(sql);
    } catch (e) {
      throw refused(e, columnNames);
    }
    let rows: QueryRow[];
    try {
      rows = stmt.all() as QueryRow[];
    } catch (e) {
      throw refused(e, columnNames);
    }
    const columns = typeof stmt.columns === "function" ? stmt.columns().map((c) => c.name) : Object.keys(rows[0] ?? {});
    const tables: Record<string, number> = Object.fromEntries(TABLE_NAMES.map((t) => [t, load.data[t].length]));
    for (const t of extra) tables[t.table] = t.rows.length;
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
