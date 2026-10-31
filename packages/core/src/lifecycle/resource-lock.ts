/**
 * Row leases (#4552): the rows an apply on the resource lock grain holds
 * while it applies. The grain, the row keys and the rule of cover are in
 * ./lock-rows.ts; this module reads and writes the rows file.
 *
 * The format, the lease and the stale takeover are terragucci's apply rows
 * (`packages/terragucci/src/apply-rows.ts` in INTENTIUS/terragucci at
 * 18f6431), moved into chant so both products share them:
 *
 * - One file per gate for the whole workspace, `_locks/rows/<gate>.json` on
 *   `chant/lifecycle` at the ledger root, never under a member's prefix
 *   (ruling B): `object` rows and choudoufu estates span members, and a file
 *   per member would miss two members meeting on one object. A gate name has
 *   no `/`, so `rows/` never collides with a gate's target-lock file
 *   (./target-lock.ts). The gate is the pull-request loop's, `pr-apply`
 *   unless the pipeline names another, so the apply before merge and the
 *   apply on merge read one file.
 * - `{ version: 1, holders: { <run>: { run, at, url?, sha? } }, rows: { <key>: <run> } }`.
 * - A take is all or nothing, in one commit: a row a live run holds refuses
 *   the whole take and nothing is written. The rows of a run that is gone
 *   are dropped in the same commit, all of them. A run is gone when the forge
 *   says its run finished, when its lease is older than `CHANT_LOCK_STALE`
 *   seconds (default 7200; terragucci's `TG_LOCK_STALE` is read as an alias
 *   for one release), or, for a run on this host outside CI, when its
 *   process is. Anything nobody can answer counts as alive.
 * - A release never throws: a row left held is taken over once its run is gone.
 * - A take may wait (ruling for ci-products 2026-10-28, "Ledger lock"): the
 *   `target` and `repo` grains, a stock Pulumi stack's `stack` row, a
 *   Terraform root's `root` row or the `repo` row. A waiting run adds itself
 *   to `waiting` in the file, and takes its rows only once no live run holds
 *   any of them and no live waiter for a row that meets one of them comes
 *   first. First is the older commit (`commitAt`, the commit time of the
 *   commit the run applies), then the lower run id (both numbers, else by
 *   text), then the commit sha: the run that started first among runs of one
 *   commit. A waiter that is gone is dropped by the next writer, as a holder
 *   is. A wait that reaches its deadline (`CHANT_LOCK_WAIT` seconds, which
 *   the waves pipelines set from the job's timeout) leaves the queue and
 *   fails with {@link LockWaitTimeoutError}, the table's `held`, exit 5. A
 *   take on the resource grain never waits: a held row refuses it at once.
 *
 * The writes go through chant's ledger code (./git.ts) with the same
 * read-then-CAS and push the target locks use, in place of terragucci's raw
 * git: a push refused because another writer moved the branch drops the
 * local commit, reads the branch again and decides again.
 *
 * The staleness of a plan stays the engine's: choudoufu's moved refusal and
 * plunge's exit 40, both `moved` (#4553). A held row is the table's `held`,
 * exit 5, and names the run that holds it.
 */
import { hostname } from "node:os";
import { getRuntime } from "../runtime-adapter";
import { pushLifecycleStatus, readBlobBySha, readPathSha, RefCASConflictError, writeBlobToPath } from "./git";
import { ownBeatStarter } from "./lock-beat";
import { lockRowsConflict, sortedLockRows, type LockRow } from "./lock-rows";
import { dropRefusedWrite, fetchForLocks, localTip, LOCKS_DIR, targetLockGateProblem } from "./target-lock";

/** The directory of the row files, under {@link LOCKS_DIR}, at the ledger root. */
export const LOCK_ROWS_DIR = `${LOCKS_DIR}/rows`;

/** A lease older than this many seconds is taken over (`CHANT_LOCK_STALE`). */
export const DEFAULT_LOCK_STALE_SECONDS = 7200;

/** A hold whose beat is older than this many seconds is gone (`CHANT_LOCK_BEAT_STALE`, #4660). */
export const DEFAULT_LOCK_BEAT_STALE_SECONDS = 600;

/** How often a live apply touches its hold, in seconds (`CHANT_LOCK_BEAT`, #4660). */
export const DEFAULT_LOCK_BEAT_SECONDS = 60;

/** A queued run that has not refreshed its entry for this many seconds is gone (`CHANT_LOCK_WAITER_STALE`, #4660). */
export const DEFAULT_LOCK_WAITER_STALE_SECONDS = 300;

const STATE_BRANCH = "chant/lifecycle";
const ATTEMPTS = 30;

/** The run holding rows: the forge's run id, or this host and process outside CI. */
export interface LockRowHolder {
  run: string;
  at: string;
  /** The run's page, for a refusal that names it. */
  url?: string;
  sha?: string;
  /**
   * The liveness token (#4660): the last time a heartbeat of the run's own
   * process touched its hold. A holder with a beat is judged by the beat
   * alone, so a job that is cancelled or killed without running its cleanup
   * frees its rows once the beat is {@link lockBeatStaleSeconds} old, while a
   * job that still beats keeps them however long its apply runs. A holder
   * without one (an older chant, terragucci) keeps the rules below.
   */
  beat?: string;
}

/** A run waiting for rows: who it is, the rows it waits for, and the commit time that orders it. */
export interface LockRowWaiter extends LockRowHolder {
  keys: string[];
  /** The commit time (ISO 8601) of the commit the run applies. Absent sorts after every waiter that has one. */
  commitAt?: string;
}

/** `_locks/rows/<gate>.json`. */
export interface LockRowsFile {
  version: 1;
  holders: Record<string, LockRowHolder>;
  /** Row key to the run that holds it. */
  rows: Record<string, string>;
  /** The runs waiting for rows (ruling for ci-products 2026-10-28), by run. Left out of the file when empty. */
  waiting?: Record<string, LockRowWaiter>;
}

/** A row another run holds, conflicting with `wanted`. */
export interface HeldLockRow {
  /** The row as the file holds it. */
  key: string;
  /** The row the take asked for that meets it (the same key, or one that covers it). */
  wanted: string;
  holder: LockRowHolder;
}

/** Whether a holder is still running: `dead` when it is gone, `alive` when it runs or nobody can say. */
export type LockLiveness = (holder: LockRowHolder) => Promise<"alive" | "dead">;

/** The path of `gate`'s rows file on `chant/lifecycle`, at the ledger root. */
export function lockRowsPath(gate: string): string {
  return `${LOCK_ROWS_DIR}/${gate}.json`;
}

/** The lease length in seconds: `CHANT_LOCK_STALE`, else `TG_LOCK_STALE`, else {@link DEFAULT_LOCK_STALE_SECONDS}. */
export function lockStaleSeconds(env: Record<string, string | undefined>): number {
  for (const name of ["CHANT_LOCK_STALE", "TG_LOCK_STALE"]) {
    const n = Number(env[name]);
    if (env[name] !== undefined && Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_LOCK_STALE_SECONDS;
}

function positiveSeconds(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const n = Number(env[name]);
  return env[name] !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How old a hold's beat may be before the hold is gone, in seconds: `CHANT_LOCK_BEAT_STALE`, else {@link DEFAULT_LOCK_BEAT_STALE_SECONDS}. */
export function lockBeatStaleSeconds(env: Record<string, string | undefined>): number {
  return positiveSeconds(env, "CHANT_LOCK_BEAT_STALE", DEFAULT_LOCK_BEAT_STALE_SECONDS);
}

/** Seconds between beats: `CHANT_LOCK_BEAT`, else {@link DEFAULT_LOCK_BEAT_SECONDS}. */
export function lockBeatSeconds(env: Record<string, string | undefined>): number {
  return positiveSeconds(env, "CHANT_LOCK_BEAT", DEFAULT_LOCK_BEAT_SECONDS);
}

/** How old a queued run's entry may be before it is gone, in seconds: `CHANT_LOCK_WAITER_STALE`, else {@link DEFAULT_LOCK_WAITER_STALE_SECONDS}. */
export function lockWaiterStaleSeconds(env: Record<string, string | undefined>): number {
  return positiveSeconds(env, "CHANT_LOCK_WAITER_STALE", DEFAULT_LOCK_WAITER_STALE_SECONDS);
}

/** Who this apply is, as the rows name it: the forge's run, or this host and process outside CI. */
export function lockRowHolder(env: Record<string, string | undefined>, now: Date = new Date()): LockRowHolder {
  const gitlab = Boolean(env.CI_PIPELINE_ID);
  const run = env.GITHUB_RUN_ID || env.CI_PIPELINE_ID || `local:${hostname()}:${process.pid}`;
  const url = gitlab
    ? env.CI_PIPELINE_URL
    : env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  const sha = env.GITHUB_SHA || env.CI_COMMIT_SHA;
  return { run, at: now.toISOString(), ...(url ? { url } : {}), ...(sha ? { sha } : {}) };
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Ask the forge whether a holder's run is gone, with `CHANT_FORGE_TOKEN`
 * (else terragucci's `TG_TOKEN`). A lease older than {@link lockStaleSeconds}
 * is gone. A local holder on this host is gone when its process is. Anything
 * nobody can answer counts as alive.
 */
export function forgeLockLiveness(env: Record<string, string | undefined>, fetch: Fetch = globalThis.fetch as unknown as Fetch, now: () => number = Date.now): LockLiveness {
  const stale = lockStaleSeconds(env);
  const beatStale = lockBeatStaleSeconds(env);
  return async (h) => {
    // #4660: a hold that carries a beat is judged by it alone. The forge may call a cancelled run finished while its process still applies, and an apply may outlast the lease; the beat says whether the process is there.
    if (h.beat !== undefined) {
      const beat = new Date(h.beat).getTime();
      if (Number.isFinite(beat)) return now() - beat >= beatStale * 1000 ? "dead" : "alive";
    }
    const since = new Date(h.at).getTime();
    if (Number.isFinite(since) && now() - since >= stale * 1000) return "dead";
    const local = /^local:(.*):(\d+)$/.exec(h.run);
    if (local) {
      if (local[1] !== hostname()) return "alive";
      try {
        process.kill(Number(local[2]), 0);
        return "alive";
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
      }
    }
    const token = env.CHANT_FORGE_TOKEN || env.TG_TOKEN;
    if (!token) return "alive";
    try {
      if (env.CI_API_V4_URL && env.CI_PROJECT_ID) {
        const r = await fetch(`${env.CI_API_V4_URL}/projects/${env.CI_PROJECT_ID}/pipelines/${h.run}`, { headers: { "private-token": token } });
        if (!r.ok) return "alive";
        const status = String(((await r.json()) as { status?: string }).status ?? "");
        return ["success", "failed", "canceled", "skipped"].includes(status) ? "dead" : "alive";
      }
      const api = env.GITHUB_API_URL || (env.GITHUB_SERVER_URL ? `${env.GITHUB_SERVER_URL}/api/v1` : "");
      if (!api || !env.GITHUB_REPOSITORY) return "alive";
      const r = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${h.run}`, { headers: { authorization: `token ${token}` } });
      if (!r.ok) return "alive";
      const status = String(((await r.json()) as { status?: string }).status ?? "");
      return ["success", "failure", "cancelled", "skipped", "completed"].includes(status) ? "dead" : "alive";
    } catch {
      return "alive";
    }
  };
}

/** The rows file's text: anything that is not a version 1 file reads as no rows; a row naming no holder is dropped. */
export function parseLockRows(text: string | null): LockRowsFile {
  if (!text) return { version: 1, holders: {}, rows: {} };
  try {
    const doc = JSON.parse(text) as { version?: unknown; holders?: unknown; rows?: unknown };
    if (doc?.version === 1 && doc.rows && typeof doc.rows === "object" && doc.holders && typeof doc.holders === "object") {
      const holders: Record<string, LockRowHolder> = {};
      for (const [id, raw] of Object.entries(doc.holders as Record<string, Record<string, unknown>>)) {
        if (typeof raw?.run !== "string" || typeof raw.at !== "string") continue;
        holders[id] = { run: raw.run, at: raw.at, ...(typeof raw.url === "string" ? { url: raw.url } : {}), ...(typeof raw.sha === "string" ? { sha: raw.sha } : {}), ...(typeof raw.beat === "string" ? { beat: raw.beat } : {}) };
      }
      const rows: Record<string, string> = {};
      for (const [k, id] of Object.entries(doc.rows as Record<string, unknown>)) if (typeof id === "string" && holders[id]) rows[k] = id;
      const waiting: Record<string, LockRowWaiter> = {};
      const rawWaiting = (doc as { waiting?: unknown }).waiting;
      if (rawWaiting && typeof rawWaiting === "object") {
        for (const [id, raw] of Object.entries(rawWaiting as Record<string, Record<string, unknown>>)) {
          if (typeof raw?.run !== "string" || typeof raw.at !== "string" || !Array.isArray(raw.keys)) continue;
          const keys = (raw.keys as unknown[]).filter((k): k is string => typeof k === "string");
          if (keys.length === 0) continue;
          waiting[id] = {
            run: raw.run,
            at: raw.at,
            keys,
            ...(typeof raw.url === "string" ? { url: raw.url } : {}),
            ...(typeof raw.sha === "string" ? { sha: raw.sha } : {}),
            ...(typeof raw.commitAt === "string" ? { commitAt: raw.commitAt } : {}),
          };
        }
      }
      return { version: 1, holders, rows, ...(Object.keys(waiting).length > 0 ? { waiting } : {}) };
    }
  } catch {
    // An unreadable file holds no rows.
  }
  return { version: 1, holders: {}, rows: {} };
}

/** The file's text, keys sorted, so two writes of the same rows are the same blob. */
export function renderLockRows(file: LockRowsFile): string {
  const sort = <T>(r: Record<string, T>) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
  const waiting = file.waiting && Object.keys(file.waiting).length > 0 ? { waiting: sort(file.waiting) } : {};
  return `${JSON.stringify({ version: 1, holders: sort(file.holders), rows: sort(file.rows), ...waiting }, null, 2)}\n`;
}

/** Who else holds a row that meets any of `keys`, split into runs still going and runs that are gone. */
export async function heldLockRowsIn(file: LockRowsFile, keys: readonly string[], me: string, alive: LockLiveness): Promise<{ live: HeldLockRow[]; gone: string[] }> {
  const verdict = new Map<string, "alive" | "dead">();
  const live: HeldLockRow[] = [];
  const gone = new Set<string>();
  for (const wanted of [...new Set(keys)].sort()) {
    for (const [key, id] of Object.entries(file.rows)) {
      if (id === me || !lockRowsConflict(wanted, key)) continue;
      const holder = file.holders[id]!;
      if (!verdict.has(id)) verdict.set(id, await alive(holder));
      if (verdict.get(id) === "dead") gone.add(id);
      else live.push({ key, wanted, holder });
    }
  }
  return { live, gone: [...gone].sort() };
}

/**
 * The rows file after `me` takes `keys`, dropping every row of the runs in
 * `gone`. Pure, so the decision can be checked without git.
 */
export function withRowsTaken(file: LockRowsFile, keys: readonly string[], me: LockRowHolder, gone: readonly string[]): LockRowsFile {
  const next = copyRows(file);
  for (const id of gone) {
    delete next.holders[id];
    for (const [k, h] of Object.entries(next.rows)) if (h === id) delete next.rows[k];
    delete next.waiting?.[id];
  }
  delete next.waiting?.[me.run];
  next.holders[me.run] = { run: me.run, at: me.at, ...(me.url ? { url: me.url } : {}), ...(me.sha ? { sha: me.sha } : {}) };
  for (const k of keys) next.rows[k] = me.run;
  return tidyWaiting(next);
}

function copyRows(file: LockRowsFile): LockRowsFile {
  return { version: 1, holders: { ...file.holders }, rows: { ...file.rows }, ...(file.waiting ? { waiting: { ...file.waiting } } : {}) };
}

function tidyWaiting(file: LockRowsFile): LockRowsFile {
  if (file.waiting && Object.keys(file.waiting).length === 0) delete file.waiting;
  return file;
}

/** The rows file with `me` in the queue for `keys`, less the waiters in `gone`. Pure. */
export function withWaiter(file: LockRowsFile, me: LockRowWaiter, gone: readonly string[] = []): LockRowsFile {
  const next = copyRows(file);
  next.waiting = { ...(next.waiting ?? {}) };
  for (const id of gone) delete next.waiting[id];
  next.waiting[me.run] = { ...me, keys: [...new Set(me.keys)].sort() };
  return next;
}

/** The rows file with `me` out of the queue. Pure. */
export function withoutWaiter(file: LockRowsFile, me: string): LockRowsFile {
  const next = copyRows(file);
  delete next.waiting?.[me];
  return tidyWaiting(next);
}

/**
 * Whether waiter `a` goes before waiter `b`: the older commit first, then the
 * lower run id (as numbers when both are, else as text), then the commit
 * sha. A waiter with no commit time goes after every one that has one.
 */
export function waiterBefore(a: Pick<LockRowWaiter, "run" | "commitAt" | "sha">, b: Pick<LockRowWaiter, "run" | "commitAt" | "sha">): boolean {
  const time = (w: { commitAt?: string }) => {
    const t = w.commitAt ? new Date(w.commitAt).getTime() : NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const ta = time(a);
  const tb = time(b);
  if (ta !== tb) return ta < tb;
  if (a.run !== b.run) {
    const na = Number(a.run);
    const nb = Number(b.run);
    if (/^\d+$/.test(a.run) && /^\d+$/.test(b.run) && na !== nb) return na < nb;
    return a.run < b.run;
  }
  return (a.sha ?? "") < (b.sha ?? "");
}

/** The rows file after `me` lets go of `keys`; its holder entry goes once it holds no row. */
export function withRowsReleased(file: LockRowsFile, keys: readonly string[], me: string): LockRowsFile {
  const next = copyRows(file);
  for (const k of keys) if (next.rows[k] === me) delete next.rows[k];
  if (!Object.values(next.rows).includes(me)) delete next.holders[me];
  return next;
}

export interface LockRowsOptions {
  cwd?: string;
  /** Whether a holder still runs. Default {@link forgeLockLiveness} over `process.env`. */
  alive?: LockLiveness;
}

async function readCurrent(gate: string, cwd?: string): Promise<{ sha: string | null; file: LockRowsFile }> {
  const sha = await readPathSha(LOCK_ROWS_DIR, `${gate}.json`, { cwd, ledgerPrefix: "" });
  return { sha, file: parseLockRows(sha ? await readBlobBySha(sha, { cwd }) : null) };
}

/** Write `next` over the file read at `sha`, then push. Null when the branch moved under the write. */
async function writeAndPush(gate: string, sha: string | null, next: LockRowsFile, message: string, cwd?: string): Promise<{ pushed: boolean } | null> {
  const parent = await localTip(cwd);
  let commit: string;
  try {
    commit = await writeBlobToPath(LOCK_ROWS_DIR, `${gate}.json`, renderLockRows(next), message, { cwd, ledgerPrefix: "", expectPriorPathSha: sha });
  } catch (err) {
    if (err instanceof RefCASConflictError) return null;
    throw err;
  }
  const push = await pushLifecycleStatus({ cwd });
  switch (push.status) {
    case "pushed":
      return { pushed: true };
    case "no-remote":
    case "not-recorded":
      return { pushed: false };
    case "stale":
      await dropRefusedWrite(push.remote, commit, parent, cwd);
      await fetchForLocks(cwd);
      return null;
    case "failed":
      throw new Error(`the rows were written but the push of ${STATE_BRANCH} to ${push.remote} failed, so they are not held: ${push.stderr}`);
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function checkGate(gate: string): void {
  const problem = targetLockGateProblem(gate);
  if (problem) throw new Error(problem);
}

/** The rows of `gate` as the remote holds them now, fetched first. */
export async function readLockRows(gate: string, opts: { cwd?: string } = {}): Promise<LockRowsFile> {
  checkGate(gate);
  await fetchForLocks(opts.cwd);
  return (await readCurrent(gate, opts.cwd)).file;
}

export type TakeLockRowsResult = { ok: true; tookOver: LockRowHolder[]; pushed: boolean } | { ok: false; held: HeldLockRow[] };

/**
 * Take `rows` for `me` in one commit. A row a live run holds, or one a held
 * row covers, refuses the whole take and nothing is written. The rows of a
 * run that is gone are dropped in the same commit.
 */
export async function takeLockRows(gate: string, rows: readonly LockRow[], me: LockRowHolder, opts: LockRowsOptions = {}): Promise<TakeLockRowsResult> {
  checkGate(gate);
  const keys = sortedLockRows(rows).map((r) => r.key);
  if (keys.length === 0) return { ok: true, tookOver: [], pushed: false };
  const alive = opts.alive ?? forgeLockLiveness(process.env);
  await fetchForLocks(opts.cwd);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { sha, file } = await readCurrent(gate, opts.cwd);
    const { live, gone } = await heldLockRowsIn(file, keys, me.run, alive);
    if (live.length > 0) return { ok: false, held: live };
    const tookOver = gone.map((id) => file.holders[id]!);
    const took = gone.length ? `, taken over from run ${gone.join(", ")}` : "";
    const wrote = await writeAndPush(gate, sha, withRowsTaken(file, keys, me, gone), `Hold ${keys.length} row${keys.length === 1 ? "" : "s"} of ${gate} for run ${me.run}${took}`, opts.cwd);
    if (wrote) return { ok: true, tookOver, pushed: wrote.pushed };
    await pause(200 + Math.floor(Math.random() * 800));
  }
  throw new Error(`could not hold the rows of ${gate}: ${STATE_BRANCH} kept moving; check that the job may push to it`);
}

/** A wait for rows reached its deadline (ruling for ci-products 2026-10-28): nothing applied. Exit 5, as a held row is. */
export class LockWaitTimeoutError extends Error {
  readonly lockRowsHeld = true;
  constructor(
    message: string,
    public readonly held: HeldLockRow[],
    public readonly ahead: LockRowWaiter[],
    public readonly waitedSeconds: number,
  ) {
    super(message);
    this.name = "LockWaitTimeoutError";
  }
}

/** How a take waits for its rows. */
export interface LockRowsWait {
  /** When the wait gives up, in ms since the epoch. */
  deadline: number;
  /** The commit time (ISO 8601) of the commit the run applies, which orders the queue. */
  commitAt?: string;
  /** How long between reads of the rows file, in ms. Default `CHANT_LOCK_POLL` seconds, else 10 s. */
  pollMs?: number;
  /** Where the wait's lines go. Default: none. */
  log?: (line: string) => void;
  /** The clock and the pause, for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The default wait when a job names no timeout: just under three hours, a Forgejo runner's default job timeout. */
export const DEFAULT_LOCK_WAIT_SECONDS = 3 * 3600 - 300;

/** How long a take waits, in seconds: `CHANT_LOCK_WAIT`, else {@link DEFAULT_LOCK_WAIT_SECONDS}. */
export function lockWaitSeconds(env: Record<string, string | undefined>): number {
  const n = Number(env.CHANT_LOCK_WAIT);
  return env.CHANT_LOCK_WAIT !== undefined && Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOCK_WAIT_SECONDS;
}

/** The poll interval in ms: `CHANT_LOCK_POLL` seconds, else 10 s. */
export function lockPollMs(env: Record<string, string | undefined>): number {
  const n = Number(env.CHANT_LOCK_POLL);
  return env.CHANT_LOCK_POLL !== undefined && Number.isFinite(n) && n > 0 ? n * 1000 : 10_000;
}

/** The commit time of `rev` in `cwd` (ISO 8601), or undefined when git cannot say. */
export async function commitTimeOf(rev: string, cwd?: string): Promise<string | undefined> {
  const out = await getRuntime().spawn(["git", "show", "-s", "--format=%cI", rev], { cwd });
  const t = out.exitCode === 0 ? out.stdout.trim() : "";
  return t && Number.isFinite(new Date(t).getTime()) ? t : undefined;
}

/** The live waiters for a row that meets one of `keys` who go before `me`, and the waiters that are gone. */
export async function waitersAhead(file: LockRowsFile, keys: readonly string[], me: LockRowWaiter, alive: LockLiveness, now: () => number = Date.now): Promise<{ ahead: LockRowWaiter[]; gone: string[] }> {
  const ahead: LockRowWaiter[] = [];
  const gone: string[] = [];
  const waiterStale = lockWaiterStaleSeconds(process.env) * 1000;
  for (const [id, w] of Object.entries(file.waiting ?? {})) {
    if (id === me.run || w.run === me.run) continue;
    if (!w.keys.some((k) => keys.some((mine) => lockRowsConflict(k, mine)))) continue;
    // #4660: a waiter refreshes its entry every few poll rounds, so one that has not is gone (cancelled or killed), whatever the forge says.
    const entered = new Date(w.at).getTime();
    const verdict = Number.isFinite(entered) && now() - entered >= waiterStale ? "dead" : await alive(w);
    if (verdict === "dead") {
      gone.push(id);
      continue;
    }
    if (waiterBefore(w, me)) ahead.push(w);
  }
  return { ahead: ahead.sort((a, b) => (waiterBefore(a, b) ? -1 : 1)), gone: gone.sort() };
}

/** When each live holder took its rows and last beat, for a wait that gave up (#4660). */
function holdAges(held: readonly HeldLockRow[]): string {
  const runs = [...new Map(held.map((h) => [h.holder.run, h.holder])).values()];
  if (runs.length === 0) return "";
  return ` (${runs.map((h) => `run ${h.run} took its rows at ${h.at}${h.beat ? `, last beat ${h.beat}` : ", no beat"}`).join("; ")})`;
}

function describeWait(held: readonly HeldLockRow[], ahead: readonly LockRowWaiter[], rows: readonly LockRow[]): string {
  const parts: string[] = [];
  if (held.length > 0) parts.push(describeHeldLockRows(held, rows));
  if (ahead.length > 0) parts.push(`${ahead.map((w) => `run ${w.run}${w.url ? ` (${w.url})` : ""}`).join(", ")} ${ahead.length === 1 ? "waits" : "wait"} ahead of it with an older commit`);
  return parts.join("; ");
}

/**
 * Take `rows` for `me`, waiting in the queue until no live run holds any of
 * them and no live waiter that goes first ({@link waiterBefore}) waits for a
 * row that meets one of them. Throws {@link LockWaitTimeoutError} at the
 * deadline, after leaving the queue.
 */
export async function waitLockRows(gate: string, rows: readonly LockRow[], me: LockRowHolder, wait: LockRowsWait, opts: LockRowsOptions = {}): Promise<{ ok: true; tookOver: LockRowHolder[]; pushed: boolean; waitedSeconds: number; waited: boolean }> {
  checkGate(gate);
  const keys = sortedLockRows(rows).map((r) => r.key);
  if (keys.length === 0) return { ok: true, tookOver: [], pushed: false, waitedSeconds: 0, waited: false };
  const alive = opts.alive ?? forgeLockLiveness(process.env);
  const now = wait.now ?? Date.now;
  const sleep = wait.sleep ?? pause;
  const poll = wait.pollMs ?? lockPollMs(process.env);
  const stale = lockStaleSeconds(process.env) * 1000;
  const started = now();
  const waiter = (): LockRowWaiter => ({ ...me, keys, ...(wait.commitAt ? { commitAt: wait.commitAt } : {}) });
  let queued: LockRowWaiter | undefined;
  let said = "";
  await fetchForLocks(opts.cwd);
  for (let raced = 0; ; ) {
    const { sha, file } = await readCurrent(gate, opts.cwd);
    const mine = queued ?? waiter();
    const { live, gone } = await heldLockRowsIn(file, keys, me.run, alive);
    const { ahead, gone: goneWaiters } = await waitersAhead(file, keys, mine, alive, now);
    if (live.length === 0 && ahead.length === 0) {
      const next = withRowsTaken(file, keys, me, gone);
      for (const id of goneWaiters) delete next.waiting?.[id];
      const took = gone.length ? `, taken over from run ${gone.join(", ")}` : "";
      const wrote = await writeAndPush(gate, sha, tidyWaiting(next), `Hold ${keys.length} row${keys.length === 1 ? "" : "s"} of ${gate} for run ${me.run}${took}`, opts.cwd);
      if (wrote) return { ok: true, tookOver: gone.map((id) => file.holders[id]!), pushed: wrote.pushed, waitedSeconds: Math.round((now() - started) / 1000), waited: queued !== undefined };
      if (++raced >= ATTEMPTS) throw new Error(`could not hold the rows of ${gate}: ${STATE_BRANCH} kept moving; check that the job may push to it`);
      await sleep(200 + Math.floor(Math.random() * 800));
      continue;
    }
    const why = describeWait(live, ahead, rows);
    if (now() >= wait.deadline) {
      await leaveQueue(gate, me.run, opts.cwd);
      const waited = Math.round((now() - started) / 1000);
      throw new LockWaitTimeoutError(`waited ${waited}s for ${keys.join(", ")} of ${gate} and gave up at the job's deadline: ${why}${holdAges(live)}. If a run named here is gone, chant unlock --run <id> --gate ${gate} frees its rows`, live, ahead, waited);
    }
    const inFile = file.waiting?.[me.run];
    const refresh = inFile ? now() - new Date(inFile.at).getTime() > Math.min(stale / 2, (lockWaiterStaleSeconds(process.env) * 1000) / 3) : true;
    if (!inFile || refresh || goneWaiters.length > 0) {
      const entry: LockRowWaiter = { ...waiter(), at: new Date(now()).toISOString() };
      const wrote = await writeAndPush(gate, sha, withWaiter(file, entry, goneWaiters), `Run ${me.run} waits for ${keys.length} row${keys.length === 1 ? "" : "s"} of ${gate}`, opts.cwd);
      if (!wrote) {
        if (++raced >= ATTEMPTS) throw new Error(`could not join the queue for the rows of ${gate}: ${STATE_BRANCH} kept moving; check that the job may push to it`);
        await sleep(200 + Math.floor(Math.random() * 800));
        continue;
      }
      queued = entry;
    } else {
      queued ??= inFile;
    }
    raced = 0;
    if (why !== said) {
      wait.log?.(`waits for ${keys.join(", ")} of ${gate}: ${why}`);
      said = why;
    }
    await sleep(Math.max(0, Math.min(poll, wait.deadline - now())));
    await fetchForLocks(opts.cwd);
  }
}

/** Take run `me` out of `gate`'s queue. Never throws. */
async function leaveQueue(gate: string, me: string, cwd?: string): Promise<void> {
  try {
    await fetchForLocks(cwd);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { sha, file } = await readCurrent(gate, cwd);
      if (!file.waiting?.[me]) return;
      if (await writeAndPush(gate, sha, withoutWaiter(file, me), `Run ${me} stops waiting for rows of ${gate}`, cwd)) return;
      await pause(200 + Math.floor(Math.random() * 800));
    }
  } catch {
    // A waiter left behind is dropped once its run is gone.
  }
}

/** Let go of `keys` where run `me` still holds them. Never throws: a row left held is taken over once the run is gone. */
export async function releaseLockRows(gate: string, keys: readonly string[], me: string, opts: { cwd?: string } = {}): Promise<boolean> {
  try {
    checkGate(gate);
    await fetchForLocks(opts.cwd);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { sha, file } = await readCurrent(gate, opts.cwd);
      const mine = keys.filter((k) => file.rows[k] === me);
      if (mine.length === 0) return true;
      const wrote = await writeAndPush(gate, sha, withRowsReleased(file, mine, me), `Release ${mine.length} row${mine.length === 1 ? "" : "s"} of ${gate} held by run ${me}`, opts.cwd);
      if (wrote) return true;
      await pause(200 + Math.floor(Math.random() * 800));
    }
  } catch {
    // Falls through: the rows stay until a later apply takes them over.
  }
  return false;
}

/** The rows file after run `run`'s beat is set to `at`. Unchanged when the run holds no row. */
export function withRowsBeat(file: LockRowsFile, run: string, at: string): LockRowsFile {
  const holder = file.holders[run];
  if (!holder || !Object.values(file.rows).includes(run)) return file;
  const next = copyRows(file);
  next.holders[run] = { ...holder, beat: at };
  return next;
}

/**
 * Touch run `run`'s hold (#4660): the heartbeat of a live apply. `held` while
 * the run still holds a row, `gone` once it holds none (released, or taken
 * over after its beat went stale), so the heartbeat stops.
 */
export async function beatLockRows(gate: string, run: string, at: string, opts: { cwd?: string } = {}): Promise<"held" | "gone"> {
  checkGate(gate);
  await fetchForLocks(opts.cwd);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { sha, file } = await readCurrent(gate, opts.cwd);
    if (!Object.values(file.rows).includes(run)) return "gone";
    const wrote = await writeAndPush(gate, sha, withRowsBeat(file, run, at), `Run ${run} still holds its rows of ${gate}`, opts.cwd);
    if (wrote) return "held";
    await pause(200 + Math.floor(Math.random() * 800));
  }
  throw new Error(`could not touch the hold of run ${run} on ${gate}: ${STATE_BRANCH} kept moving`);
}

/** The rows file after every hold and queue entry of `run` is dropped, whether or not the run is gone. */
export function withRunCleared(file: LockRowsFile, run: string): LockRowsFile {
  const next = copyRows(file);
  delete next.holders[run];
  for (const [k, id] of Object.entries(next.rows)) if (id === run) delete next.rows[k];
  delete next.waiting?.[run];
  return tidyWaiting(next);
}

/**
 * Let go of everything run `run` holds or waits for on `gate`, by hand
 * (#4660, `chant unlock --run`). It does not ask whether the run is alive:
 * the person who runs it says so. Throws when the branch cannot be read or
 * pushed, so a hold that is still there is never reported as cleared.
 */
export async function clearRunLockRows(gate: string, run: string, opts: { cwd?: string } = {}): Promise<{ released: string[]; waited: boolean; pushed: boolean }> {
  checkGate(gate);
  await fetchForLocks(opts.cwd);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { sha, file } = await readCurrent(gate, opts.cwd);
    const released = Object.entries(file.rows).filter(([, id]) => id === run).map(([k]) => k).sort();
    const waited = file.waiting?.[run] !== undefined;
    if (released.length === 0 && !file.holders[run] && !waited) return { released, waited, pushed: false };
    const wrote = await writeAndPush(gate, sha, withRunCleared(file, run), `Clear the hold of run ${run} on ${gate}`, opts.cwd);
    if (wrote) return { released, waited, pushed: wrote.pushed };
    await pause(200 + Math.floor(Math.random() * 800));
  }
  throw new Error(`could not clear run ${run} from ${gate}: ${STATE_BRANCH} kept moving; check that the job may push to it`);
}

/** One line naming the runs that hold rows, and what of this apply they hold, for a log line and a refusal. */
export function describeHeldLockRows(held: readonly HeldLockRow[], rows: readonly LockRow[]): string {
  const address = new Map(rows.map((r) => [r.key, `${r.target}: ${r.address}`]));
  const byRun = new Map<string, { holder: LockRowHolder; what: Set<string> }>();
  for (const h of held) {
    const e = byRun.get(h.holder.run) ?? { holder: h.holder, what: new Set<string>() };
    e.what.add(address.get(h.wanted) ?? h.wanted);
    byRun.set(h.holder.run, e);
  }
  return [...byRun.values()]
    .map(({ holder, what }) => `run ${holder.run}${holder.url ? ` (${holder.url})` : ""} is applying ${[...what].sort().join(", ")}`)
    .join("; ");
}

/** A lease an apply holds: its rows and holder, and how to let go of it. */
export interface LockRowsLease {
  gate: string;
  holder: LockRowHolder;
  keys: string[];
  release(): Promise<boolean>;
}

/** Starts the heartbeat of a hold (#4660) and returns how to stop it. */
export type LockBeatStarter = (hold: { gate: string; holder: LockRowHolder; cwd?: string }) => () => void;

/**
 * Lease `rows` for the apply about to run (#4552): take them, or say who
 * holds them. With no rows, a lease that holds nothing. Throws when the
 * rows file cannot be read or written, so an apply that cannot hold its
 * rows applies nothing.
 */
export async function leaseLockRows(
  gate: string,
  rows: readonly LockRow[],
  opts: LockRowsOptions & { holder?: LockRowHolder; wait?: LockRowsWait; beat?: LockBeatStarter } = {},
): Promise<{ ok: true; lease: LockRowsLease; tookOver: LockRowHolder[]; waitedSeconds?: number; waited?: boolean } | { ok: false; held: HeldLockRow[]; message: string; timedOut?: true }> {
  const holder = opts.holder ?? lockRowHolder(process.env);
  const keys = sortedLockRows(rows).map((r) => r.key);
  let stopBeat: (() => void) | undefined;
  const lease: LockRowsLease = {
    gate,
    holder,
    keys,
    release: () => {
      // The beat stops first, so it cannot touch a hold that is being let go.
      stopBeat?.();
      stopBeat = undefined;
      return keys.length === 0 ? Promise.resolve(true) : releaseLockRows(gate, keys, holder.run, { ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    },
  };
  if (keys.length === 0) return { ok: true, lease, tookOver: [] };
  const startBeat = () => {
    try {
      stopBeat = (opts.beat ?? ownBeatStarter())?.({ gate, holder, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    } catch {
      // No beat: the hold keeps the forge and lease rules.
    }
  };
  if (opts.wait) {
    try {
      const waited = await waitLockRows(gate, rows, holder, opts.wait, opts);
      startBeat();
      return { ok: true, lease, tookOver: waited.tookOver, ...(waited.waited ? { waited: true, waitedSeconds: waited.waitedSeconds } : {}) };
    } catch (err) {
      if (err instanceof LockWaitTimeoutError) return { ok: false, held: err.held, message: err.message, timedOut: true };
      throw err;
    }
  }
  const taken = await takeLockRows(gate, rows, holder, opts);
  if (!taken.ok) return { ok: false, held: taken.held, message: describeHeldLockRows(taken.held, rows) };
  startBeat();
  return { ok: true, lease, tookOver: taken.tookOver };
}
