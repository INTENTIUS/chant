/**
 * Operator lease (#1485, epic #1487) — single-writer coordination for a
 * `ConvergeOp`'s tick loop, entirely over git. No new state store: the lease
 * lives on a dedicated ref namespace (`refs/chant/lease/<op>`), separate
 * from the `chant/lifecycle` orphan branch's own commit history, whose
 * value IS a lease-record blob — no tree, no commit (./git.ts's
 * `writeBlob`/`readBlobBySha`). Acquiring or renewing a lease is one
 * `updateRefCAS` call (./git.ts): the caller reads the ref's current SHA,
 * and the write only lands if the ref still points there. No `flock` file
 * either — `git update-ref` is already an atomic local mutex (its own
 * lockfile-then-rename), so a second local process racing the same acquire
 * loses outright without any second locking mechanism to reason about.
 *
 * Cross-machine contention is settled by pushing/fetching this one ref
 * through the project's remote (best-effort — see `acquireLease`). A
 * project with no remote is single-machine by construction: the local CAS
 * above is then the *entire* coordination story, which is exactly what
 * issue #1485's open question 5 asks be stated loudly — `chant operator`'s
 * own docs page says so explicitly; nothing here silently upgrades a
 * remote-less lease to team-visible durability.
 *
 * The record's `token` is the fencing token the issue asks for: a fresh
 * value is minted only when the lease actually changes hands (first
 * acquire, or a re-acquire after the previous holder's lease expired or was
 * released) — never on a same-holder renewal, so an in-flight tick's token
 * stays valid across the operator loop's own heartbeats. `stillHoldsLease`
 * is what a caller uses, right before trusting a finished tick's own work,
 * to notice its token has since changed (the lease was stolen mid-tick,
 * e.g. the process stalled past its TTL) — see `../op/operator.ts`'s tick
 * loop for how that's handled: never a hard failure, since a converge tick
 * is idempotent by design (it re-observes and re-derives everything), so a
 * late, fenced-out write is redundant, not corrupting.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readRefSha, updateRefCAS, deleteRefCAS, writeBlob, readBlobBySha, pushRef, fetchRef, RefCASConflictError } from "./git";

export const LEASE_REF_PREFIX = "refs/chant/lease/";

/**
 * Default lease TTL — long enough that a normal tick (observe, classify,
 * a budget-bounded number of dispatches) finishes well inside it; short
 * enough that a crashed operator's environment resumes converging soon
 * after, without a human intervening. The operator loop renews well before
 * this elapses (every round it still owns the lease for), so under normal
 * operation the TTL is never actually reached.
 */
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

export function leaseRef(opName: string): string {
  return `${LEASE_REF_PREFIX}${opName}`;
}

/** One lease's live state — the entire durable record; there is no history, only the current holder (see this module's doc on why no separate ledger). */
export interface LeaseRecord {
  op: string;
  /** `<hostname>:<pid>:<random>` — a diagnostic identity, not itself the fencing mechanism (`token` is). */
  holder: string;
  /** Fencing token — new only when the lease actually changes hands; see module doc. */
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

/** A stable-enough identity for "who holds this lease", for logs and `chant operator status` — hostname:pid, plus a short random suffix so two processes started in the same pid-reuse window never read as the same holder. */
export function currentHolderId(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

function isExpired(record: LeaseRecord, now: Date): boolean {
  return new Date(record.expiresAt).getTime() <= now.getTime();
}

function parseLease(raw: string): LeaseRecord | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LeaseRecord>;
    if (
      typeof v.op === "string" &&
      typeof v.holder === "string" &&
      typeof v.token === "string" &&
      typeof v.acquiredAt === "string" &&
      typeof v.expiresAt === "string"
    ) {
      return v as LeaseRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface ReadLeaseResult {
  /** The ref's current SHA (the CAS anchor for the next write), or `null` if no lease has ever been written. */
  sha: string | null;
  record?: LeaseRecord;
}

/** Read the live lease for `opName`, fetching the remote ref first (best-effort — see `fetchRef`) so a lease held by another machine is visible before deciding whether to acquire. */
export async function readLease(opName: string, opts?: { cwd?: string }): Promise<ReadLeaseResult> {
  await fetchRef(leaseRef(opName), opts).catch(() => undefined);
  const sha = await readRefSha(leaseRef(opName), opts);
  if (!sha) return { sha: null };
  const raw = await readBlobBySha(sha, opts);
  return { sha, record: raw ? parseLease(raw) : undefined };
}

export interface AcquireLeaseResult {
  acquired: boolean;
  lease?: LeaseRecord;
  /** Present when not acquired: the lease record currently held by someone else. */
  heldBy?: LeaseRecord;
}

/**
 * Acquire or renew the lease for `opName` as `holder`. Succeeds (never
 * throws) when the ref doesn't exist yet, is expired, or is already held by
 * `holder` (a renewal: same token, pushed-out expiry). Fails — returns
 * `acquired: false`, still never throws — when it's live-held by someone
 * else, or when a concurrent CAS write is lost to a race that happened
 * between this call's read and its write; both read identically to a
 * caller deciding whether to tick this round ("someone else has it right
 * now, skip").
 */
export async function acquireLease(
  opName: string,
  holder: string,
  opts?: { cwd?: string; ttlMs?: number; now?: () => Date },
): Promise<AcquireLeaseResult> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = opts?.now?.() ?? new Date();

  const { sha, record: current } = await readLease(opName, opts);
  const expired = !current || isExpired(current, now);
  const ownedByUs = current?.holder === holder;

  if (current && !expired && !ownedByUs) {
    return { acquired: false, heldBy: current };
  }

  const renewing = !!current && ownedByUs && !expired;
  const record: LeaseRecord = {
    op: opName,
    holder,
    token: renewing ? current.token : randomUUID(),
    acquiredAt: renewing ? current.acquiredAt : now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };

  const blobSha = await writeBlob(JSON.stringify(record), opts);
  try {
    await updateRefCAS(leaseRef(opName), blobSha, sha, opts);
  } catch (err) {
    if (err instanceof RefCASConflictError) {
      const retry = await readLease(opName, opts);
      return { acquired: false, heldBy: retry.record };
    }
    throw err;
  }
  await pushRef(leaseRef(opName), opts).catch(() => undefined);
  return { acquired: true, lease: record };
}

/**
 * Release the lease, but only when `holder`/`token` still match the live
 * value — releasing a lease this caller no longer actually holds would
 * silently drop someone else's. Best-effort courtesy: a lease nobody
 * releases is reclaimed anyway once its TTL passes, so a failed release
 * (returns `false`, never throws) is not itself a correctness problem.
 */
export async function releaseLease(
  opName: string,
  holder: string,
  token: string,
  opts?: { cwd?: string },
): Promise<boolean> {
  const { sha, record } = await readLease(opName, opts);
  if (!sha || !record || record.holder !== holder || record.token !== token) return false;
  try {
    await deleteRefCAS(leaseRef(opName), sha, opts);
  } catch {
    return false;
  }
  await pushRef(leaseRef(opName), opts).catch(() => undefined);
  return true;
}

/**
 * Does `holder`/`token` still match the live lease? The fencing check a
 * tick uses right before trusting its own work as authoritative (see
 * `../op/operator.ts`). Fetches first, so a lease stolen by another machine
 * is detected, not just a stale local read.
 */
export async function stillHoldsLease(
  opName: string,
  holder: string,
  token: string,
  opts?: { cwd?: string },
): Promise<boolean> {
  const { record } = await readLease(opName, opts);
  return record?.holder === holder && record?.token === token;
}
