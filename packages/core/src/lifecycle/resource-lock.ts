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
import { pushLifecycleStatus, readBlobBySha, readPathSha, RefCASConflictError, writeBlobToPath } from "./git";
import { lockRowsConflict, sortedLockRows, type LockRow } from "./lock-rows";
import { dropRefusedWrite, fetchForLocks, localTip, LOCKS_DIR, targetLockGateProblem } from "./target-lock";

/** The directory of the row files, under {@link LOCKS_DIR}, at the ledger root. */
export const LOCK_ROWS_DIR = `${LOCKS_DIR}/rows`;

/** A lease older than this many seconds is taken over (`CHANT_LOCK_STALE`). */
export const DEFAULT_LOCK_STALE_SECONDS = 7200;

const STATE_BRANCH = "chant/lifecycle";
const ATTEMPTS = 30;

/** The run holding rows: the forge's run id, or this host and process outside CI. */
export interface LockRowHolder {
  run: string;
  at: string;
  /** The run's page, for a refusal that names it. */
  url?: string;
  sha?: string;
}

/** `_locks/rows/<gate>.json`. */
export interface LockRowsFile {
  version: 1;
  holders: Record<string, LockRowHolder>;
  /** Row key to the run that holds it. */
  rows: Record<string, string>;
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
  return async (h) => {
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
        holders[id] = { run: raw.run, at: raw.at, ...(typeof raw.url === "string" ? { url: raw.url } : {}), ...(typeof raw.sha === "string" ? { sha: raw.sha } : {}) };
      }
      const rows: Record<string, string> = {};
      for (const [k, id] of Object.entries(doc.rows as Record<string, unknown>)) if (typeof id === "string" && holders[id]) rows[k] = id;
      return { version: 1, holders, rows };
    }
  } catch {
    // An unreadable file holds no rows.
  }
  return { version: 1, holders: {}, rows: {} };
}

/** The file's text, keys sorted, so two writes of the same rows are the same blob. */
export function renderLockRows(file: LockRowsFile): string {
  const sort = <T>(r: Record<string, T>) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
  return `${JSON.stringify({ version: 1, holders: sort(file.holders), rows: sort(file.rows) }, null, 2)}\n`;
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
  const next: LockRowsFile = { version: 1, holders: { ...file.holders }, rows: { ...file.rows } };
  for (const id of gone) {
    delete next.holders[id];
    for (const [k, h] of Object.entries(next.rows)) if (h === id) delete next.rows[k];
  }
  next.holders[me.run] = me;
  for (const k of keys) next.rows[k] = me.run;
  return next;
}

/** The rows file after `me` lets go of `keys`; its holder entry goes once it holds no row. */
export function withRowsReleased(file: LockRowsFile, keys: readonly string[], me: string): LockRowsFile {
  const next: LockRowsFile = { version: 1, holders: { ...file.holders }, rows: { ...file.rows } };
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

/**
 * Lease `rows` for the apply about to run (#4552): take them, or say who
 * holds them. With no rows, a lease that holds nothing. Throws when the
 * rows file cannot be read or written, so an apply that cannot hold its
 * rows applies nothing.
 */
export async function leaseLockRows(
  gate: string,
  rows: readonly LockRow[],
  opts: LockRowsOptions & { holder?: LockRowHolder } = {},
): Promise<{ ok: true; lease: LockRowsLease; tookOver: LockRowHolder[] } | { ok: false; held: HeldLockRow[]; message: string }> {
  const holder = opts.holder ?? lockRowHolder(process.env);
  const keys = sortedLockRows(rows).map((r) => r.key);
  const lease: LockRowsLease = { gate, holder, keys, release: () => (keys.length === 0 ? Promise.resolve(true) : releaseLockRows(gate, keys, holder.run, { ...(opts.cwd ? { cwd: opts.cwd } : {}) })) };
  if (keys.length === 0) return { ok: true, lease, tookOver: [] };
  const taken = await takeLockRows(gate, rows, holder, opts);
  if (!taken.ok) return { ok: false, held: taken.held, message: describeHeldLockRows(taken.held, rows) };
  return { ok: true, lease, tookOver: taken.tookOver };
}
