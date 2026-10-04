/**
 * The working tree's write lock and write journal (#3173, ws-089).
 *
 * The repo is the database (ws-074), and one working tree is written by
 * several principals at once: people through hud, the coding agent, the
 * steward and builders. chant's working-tree writes (records new, amend,
 * review and close, points ask and answer, box listing set) each read the
 * records, build the file they write, validate it and write it. Two of them
 * running at once could each read the same record and the second write would
 * drop the first's change, or two `records new` could hand out the same id.
 * So every such write holds this lock from its first read to its last write:
 * writes to one working tree are serialised, and each one reads what the one
 * before it wrote.
 *
 * The lock is a directory, `chant-write.lock`, in the working tree's git
 * directory (`.git`, or `.git/worktrees/<name>` for a linked worktree, so two
 * worktrees of one repository never wait on each other), made with `mkdir`,
 * which either creates it or fails. `owner.json` inside it says who holds it.
 * Outside git it lives in the system's temporary directory, keyed by the
 * working directory's real path, so nothing is added to the files a person
 * reviews. A holder that died leaves its lock behind: one whose process is
 * gone on this host, or whose `expiresAt` has passed, is broken by the next
 * writer. A writer waits for the lock up to `CHANT_WRITE_LOCK_WAIT_MS`
 * (default {@link DEFAULT_WAIT_MS}) and is then refused with
 * `write-lock-timeout`, naming the holder.
 *
 * A caller can hold the lock across several chant calls, for a batch of
 * writes nobody else interleaves with (`chant workspace lock acquire`, hud#819):
 * each call of the batch runs with `CHANT_WRITE_LOCK=<token>` in its
 * environment, and goes ahead without waiting while the lock is held under
 * that token. A token that no longer holds the lock (released, or broken
 * after it expired) is refused with `write-lock-not-held`, so a batch never
 * runs on unlocked.
 *
 * The journal, `chant-writes.json` beside the lock, notes the last chant
 * write of each record file: the verb, who it named and when, keyed by the
 * file's SHA-256 after the write. The read contract reports it as a record's
 * `lastWrite` while the file still has those bytes, and a conflict refusal
 * names it. It is a cache in the git directory (ws-074's exceptions), never
 * a fact: lost, every record's `lastWrite` is null, and nothing else changes.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The environment variable that names a lock token a batch holds across chant calls. */
export const WRITE_LOCK_ENV = "CHANT_WRITE_LOCK";
/** The environment variable that sets how long a write waits for the lock, in milliseconds. */
export const WRITE_LOCK_WAIT_ENV = "CHANT_WRITE_LOCK_WAIT_MS";
/** How long a write waits for the lock by default. */
export const DEFAULT_WAIT_MS = 15_000;
/** How long one command's lock is good for, should its process be unable to say it died. */
export const COMMAND_TTL_MS = 2 * 60_000;
/** The longest a batch may hold the lock with `lock acquire --ttl`. */
export const MAX_BATCH_TTL_MS = 10 * 60_000;
/** The default `--ttl` of `lock acquire`. */
export const DEFAULT_BATCH_TTL_MS = 60_000;

/** The lock directory's name in the git directory. */
export const WRITE_LOCK_NAME = "chant-write.lock";
/** The journal's name in the git directory. */
export const WRITE_JOURNAL_NAME = "chant-writes.json";

export const WRITE_LOCK_CODES = ["write-lock-timeout", "write-lock-not-held"] as const;
export type WriteLockCode = (typeof WRITE_LOCK_CODES)[number];

/** Who holds the lock, as `owner.json` holds it. */
export interface WriteLockHolder {
  token: string;
  /** The process holding it, or null for a batch held across calls by `lock acquire`. */
  pid: number | null;
  host: string;
  /** What holds it: a write verb, such as `records amend`, or `batch`. */
  verb: string;
  by: string | null;
  agent: string | null;
  acquiredAt: string;
  expiresAt: string;
}

/** Who is writing: the verb, and the principal and agent session the write names. */
export interface WriteLockWho {
  verb: string;
  by?: string | null;
  agent?: string | null;
}

export class WriteLockError extends Error {
  constructor(
    readonly code: WriteLockCode,
    message: string,
    readonly holder: WriteLockHolder | null,
  ) {
    super(message);
    this.name = "WriteLockError";
  }
}

// ── Where ────────────────────────────────────────────────────────────────────

/**
 * The git directory of the working tree `start` is in: `.git`, or the
 * directory a linked worktree's `.git` file names. Null outside git.
 */
export function gitDirOf(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const dotGit = join(dir, ".git");
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) return dotGit;
      if (st.isFile()) {
        const m = readFileSync(dotGit, "utf-8").match(/^gitdir:\s*(.+?)\s*$/m);
        if (m) return isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]);
      }
    } catch {
      // No .git here: go up.
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The lock directory for the working tree `start` is in. */
export function writeLockPath(start: string): string {
  const git = gitDirOf(real(start));
  if (git) return join(git, WRITE_LOCK_NAME);
  return join(tmpdir(), `chant-write-${createHash("sha256").update(real(start)).digest("hex").slice(0, 16)}.lock`);
}

/** The journal for the working tree `start` is in, or null outside git. */
export function writeJournalPath(start: string): string | null {
  const git = gitDirOf(real(start));
  return git ? join(git, WRITE_JOURNAL_NAME) : null;
}

// ── The lock ─────────────────────────────────────────────────────────────────

const HOST = hostname();

/**
 * The locks the running write holds, through every await inside it, so a
 * write inside a write (work evidence's amend) goes ahead and two writes this
 * process runs at once (two requests to chant serve mcp) still wait on each
 * other.
 */
const context = new AsyncLocalStorage<ReadonlySet<string>>();
/** Every lock some write in this process holds now. */
const heldHere = new Set<string>();

function readHolder(lock: string): WriteLockHolder | null {
  try {
    return JSON.parse(readFileSync(join(lock, "owner.json"), "utf-8")) as WriteLockHolder;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Why a lock someone else holds can be broken, or null while it holds. */
function staleness(lock: string, holder: WriteLockHolder | null, now: number): string | null {
  if (holder === null) {
    // Made and not yet given its owner file, or left that way by a crash: give the maker a moment.
    try {
      return now - statSync(lock).mtimeMs > 5_000 ? "it names no holder" : null;
    } catch {
      return null;
    }
  }
  if (Date.parse(holder.expiresAt) < now) return `it expired at ${holder.expiresAt}`;
  if (holder.pid !== null && holder.host === HOST && !alive(holder.pid)) return `its process ${holder.pid} has exited`;
  return null;
}

function describe(h: WriteLockHolder | null): string {
  if (!h) return "a writer that has not said who it is";
  const who = [h.by, h.agent ? `agent ${h.agent}` : null].filter(Boolean).join(", ");
  return `${h.verb}${who ? ` (${who})` : ""}, since ${h.acquiredAt}, until ${h.expiresAt}`;
}

/** Move a stale lock aside and remove it. Puts it back when another writer took the lock in between. */
function breakLock(lock: string, stale: WriteLockHolder | null): void {
  const aside = `${lock}.broken-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lock, aside);
  } catch {
    return; // Gone already: someone else broke or released it.
  }
  const moved = readHolder(aside);
  if (moved !== null && stale !== null && moved.token !== stale.token) {
    // A fresh lock was moved aside: give it back if nobody has taken the path since.
    try {
      renameSync(aside, lock);
      return;
    } catch {
      // The path was taken again; the fresh holder's release finds its lock gone, which it tolerates.
    }
  }
  rmSync(aside, { recursive: true, force: true });
}

/** Try once to take the lock. Returns the holder written, or the holder in the way. */
function tryTake(lock: string, holder: WriteLockHolder, mayBreak = true): { ok: true } | { ok: false; holder: WriteLockHolder | null } {
  try {
    mkdirSync(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const current = readHolder(lock);
    if (mayBreak && staleness(lock, current, Date.now()) !== null) {
      breakLock(lock, current);
      return tryTake(lock, holder, false);
    }
    return { ok: false, holder: current };
  }
  const tmp = join(lock, `owner.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(holder, null, 2)}\n`);
  renameSync(tmp, join(lock, "owner.json"));
  return { ok: true };
}

function waitMs(): number {
  const raw = process.env[WRITE_LOCK_WAIT_ENV];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_MS;
}

function newHolder(who: WriteLockWho, ttlMs: number, pid: number | null): WriteLockHolder {
  const now = Date.now();
  return {
    token: randomBytes(16).toString("hex"),
    pid,
    host: HOST,
    verb: who.verb,
    by: who.by ?? null,
    agent: who.agent ?? null,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

/**
 * Whether this call needs no lock of its own: the write it runs inside holds
 * it, or the environment names the token of a batch holding it. Throws
 * write-lock-not-held when the token named no longer holds it.
 */
function alreadyHeld(lock: string): boolean {
  if (context.getStore()?.has(lock)) return true;
  const token = process.env[WRITE_LOCK_ENV];
  if (token === undefined || token === "") return false;
  const current = readHolder(lock);
  if (current?.token !== token || staleness(lock, current, Date.now()) !== null) {
    throw new WriteLockError(
      "write-lock-not-held",
      `${WRITE_LOCK_ENV} names a lock token that no longer holds this working tree's write lock (${current ? `it is held by ${describe(current)}` : "nobody holds it"}): the batch's lock was released or expired, so take it again with chant workspace lock acquire and re-read what the batch writes`,
      current,
    );
  }
  return true;
}

/** Remove the lock at `lock` when `token` holds it. Returns whether it did. */
export function releaseLock(lock: string, token: string): boolean {
  const current = readHolder(lock);
  if (current?.token !== token) return false;
  try {
    unlinkSync(join(lock, "owner.json"));
  } catch {
    // Already gone.
  }
  rmSync(lock, { recursive: true, force: true });
  return true;
}

function timeout(lock: string, current: WriteLockHolder | null, ms: number): WriteLockError {
  return new WriteLockError(
    "write-lock-timeout",
    `another write holds this working tree's write lock (${lock}): ${describe(current)}. Waited ${ms}ms; run the write again once it is done, or raise ${WRITE_LOCK_WAIT_ENV}`,
    current,
  );
}

const pause = (): number => 20 + Math.floor(Math.random() * 40);

/** Take the lock at `lock` as `holder`, waiting up to the wait limit. */
async function takeWaiting(lock: string, holder: WriteLockHolder): Promise<void> {
  const limit = waitMs();
  const begun = Date.now();
  for (;;) {
    const got = tryTake(lock, holder);
    if (got.ok) return;
    if (Date.now() - begun >= limit) throw timeout(lock, got.holder, limit);
    await new Promise((r) => setTimeout(r, pause()));
  }
}

/**
 * Run `fn` holding the working tree's write lock, taken for this one write
 * and released when `fn` settles. With `dryRun`, without it, since a dry run
 * writes nothing. Throws a {@link WriteLockError} when the lock can't be had.
 */
export async function withWriteLock<T>(start: string, who: WriteLockWho, dryRun: boolean | undefined, fn: () => Promise<T>): Promise<T> {
  if (dryRun) return fn();
  const lock = writeLockPath(start);
  if (alreadyHeld(lock)) return fn();
  const holder = newHolder(who, COMMAND_TTL_MS, process.pid);
  await takeWaiting(lock, holder);
  heldHere.add(lock);
  try {
    return await context.run(new Set([...(context.getStore() ?? []), lock]), fn);
  } finally {
    heldHere.delete(lock);
    releaseLock(lock, holder.token);
  }
}

/**
 * {@link withWriteLock} for a write that is synchronous throughout: it
 * blocks while it waits. When another write in this same process holds the
 * lock, blocking would keep that write from ever finishing, so it is refused
 * with write-lock-timeout at once.
 */
export function withWriteLockSync<T>(start: string, who: WriteLockWho, dryRun: boolean | undefined, fn: () => T): T {
  if (dryRun) return fn();
  const lock = writeLockPath(start);
  if (alreadyHeld(lock)) return fn();
  if (heldHere.has(lock)) throw timeout(lock, readHolder(lock), 0);
  const holder = newHolder(who, COMMAND_TTL_MS, process.pid);
  const limit = waitMs();
  const begun = Date.now();
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const got = tryTake(lock, holder);
    if (got.ok) break;
    if (Date.now() - begun >= limit) throw timeout(lock, got.holder, limit);
    Atomics.wait(cell, 0, 0, pause());
  }
  heldHere.add(lock);
  try {
    return context.run(new Set([...(context.getStore() ?? []), lock]), fn);
  } finally {
    heldHere.delete(lock);
    releaseLock(lock, holder.token);
  }
}

/**
 * Take the lock for a batch held across chant calls (`lock acquire`): no
 * process holds it, so it lasts until it is released or `ttlMs` passes.
 * Waits like a write does.
 */
export async function acquireBatchLock(start: string, who: WriteLockWho, ttlMs: number): Promise<{ path: string; holder: WriteLockHolder }> {
  const lock = writeLockPath(start);
  const holder = newHolder({ ...who, verb: "batch" }, ttlMs, null);
  await takeWaiting(lock, holder);
  return { path: lock, holder };
}

/** Who holds the working tree's write lock now, or null when nobody does (a stale lock counts as nobody). */
export function writeLockHolder(start: string): { path: string; holder: WriteLockHolder | null } {
  const lock = writeLockPath(start);
  if (!existsSync(lock)) return { path: lock, holder: null };
  const current = readHolder(lock);
  return { path: lock, holder: staleness(lock, current, Date.now()) === null ? current : null };
}

// ── Writing a file ───────────────────────────────────────────────────────────

/** Write `text` to `file` through a sibling temporary file, so a reader never sees half of it. */
export function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.chant-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ── The journal ──────────────────────────────────────────────────────────────

/** The last chant write of a record file, as the read contract reports it. */
export interface LastWrite {
  /** The write command, such as `records amend` or `points answer`. */
  verb: string;
  /** The principal the write named (--by, or the channel's author), or null when it named none. */
  by: string | null;
  /** The agent session it was made in (CHANT_AGENT), or null. */
  agent: string | null;
  /** When, as an ISO 8601 time. */
  at: string;
}

interface Journal {
  version: 1;
  /** By record path from the repository root: the file's SHA-256 after the write, and the write. */
  files: Record<string, LastWrite & { sha256: string }>;
}

/** How many files the journal remembers; the oldest are forgotten first. */
const JOURNAL_LIMIT = 2_000;

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function readJournal(file: string): Journal {
  try {
    const j = JSON.parse(readFileSync(file, "utf-8")) as Journal;
    if (j && j.version === 1 && j.files && typeof j.files === "object") return j;
  } catch {
    // Missing or unreadable: start again. It is a cache.
  }
  return { version: 1, files: {} };
}

/**
 * Note in the journal that `who` wrote each file, with the text it now
 * holds. Called holding the lock, after the write. Best effort: a journal
 * that can't be written never fails the write it notes.
 */
export function noteWrites(start: string, writes: readonly { path: string; text: string }[], who: WriteLockWho): void {
  const file = writeJournalPath(start);
  if (file === null || writes.length === 0) return;
  try {
    const journal = readJournal(file);
    const at = new Date().toISOString();
    for (const w of writes) {
      delete journal.files[w.path];
      journal.files[w.path] = { sha256: sha256Text(w.text), verb: who.verb, by: who.by ?? null, agent: who.agent ?? null, at };
    }
    const keys = Object.keys(journal.files);
    for (const k of keys.slice(0, Math.max(0, keys.length - JOURNAL_LIMIT))) delete journal.files[k];
    writeFileAtomic(file, `${JSON.stringify(journal)}\n`);
  } catch {
    // A cache: never fail the write over it.
  }
}

/**
 * A reader of the journal for the working tree `start` is in: the last chant
 * write of a record file, while the file still holds the text that write
 * left, and null otherwise (written by something else since, or never by
 * chant here).
 */
export function lastWriteReader(start: string): (path: string, text: string | null) => LastWrite | null {
  const file = writeJournalPath(start);
  const journal = file !== null && existsSync(file) ? readJournal(file) : null;
  return (path, text) => {
    const e = journal?.files[path];
    if (!e || text === null || e.sha256 !== sha256Text(text)) return null;
    return { verb: e.verb, by: e.by, agent: e.agent, at: e.at };
  };
}
