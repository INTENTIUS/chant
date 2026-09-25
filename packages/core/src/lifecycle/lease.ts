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
import { readRefSha, updateRefCAS, deleteRefCAS, writeBlob, readBlobBySha, pushRefStatus, fetchRefIntoStatus, RefCASConflictError, StaleLockError } from "./git";
import { resolveMemberLedger } from "./member-ledger";

export const LEASE_REF_PREFIX = "refs/chant/lease/";

/**
 * Side namespace `readLease` fetches remote lease state into (#1959 finding
 * 3), rather than into `refs/chant/lease/<op>` itself. That ref is the CAS
 * write path's alone (`acquireLease`/`releaseLease`, both via
 * `updateRefCAS`/`deleteRefCAS`); a read path force-fetching directly into
 * it would risk clobbering a just-acquired, not-yet-pushed local lease with
 * the still-stale remote value — the exact race a concurrent `chant operator
 * status` in the same clone could hit during the acquire→push window. See
 * `readLease`'s doc for how the two are reconciled without that risk.
 */
export const LEASE_REMOTE_TRACKING_PREFIX = "refs/chant/lease-remote/";

/**
 * Default lease TTL — long enough that a normal tick (observe, classify,
 * a budget-bounded number of dispatches) finishes well inside it; short
 * enough that a crashed operator's environment resumes converging soon
 * after, without a human intervening. The operator loop renews well before
 * this elapses (every round it still owns the lease for), so under normal
 * operation the TTL is never actually reached.
 */
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

/**
 * The lease ref for `opName`. `memberPrefix` is the project's ledger prefix
 * from ./member-ledger.ts (#2538): empty at level 0 and for the root member
 * `.`, which keeps `refs/chant/lease/<op>`, and `_members/<member>/` for any
 * other workspace member, which gives `refs/chant/lease/_members/<member>/<op>`.
 * Two members may then run Ops of the same name without sharing a lease.
 */
export function leaseRef(opName: string, memberPrefix = ""): string {
  return `${LEASE_REF_PREFIX}${memberPrefix}${opName}`;
}

function leaseRemoteTrackingRef(opName: string, memberPrefix = ""): string {
  return `${LEASE_REMOTE_TRACKING_PREFIX}${memberPrefix}${opName}`;
}

/** The lease refs of `opName` for the project at `opts.cwd` (or the process's directory). */
async function projectLeaseRefs(opName: string, opts?: { cwd?: string }): Promise<{ ref: string; trackingRef: string }> {
  const { prefix } = await resolveMemberLedger(opts?.cwd ?? process.cwd());
  return { ref: leaseRef(opName, prefix), trackingRef: leaseRemoteTrackingRef(opName, prefix) };
}

/**
 * Sort key for "which of two lease records is more current" — a plain
 * string comparison works because `acquiredAt`/`expiresAt` are always
 * `Date.prototype.toISOString()` output (fixed-width, UTC), which sorts
 * lexicographically in time order. Compares `acquiredAt` first (a genuine
 * handoff to a new holder always mints a strictly later one; see
 * `acquireLease`), falling back to `expiresAt` to break a tie between two
 * renewals of the *same* holder/token, which share `acquiredAt` by design.
 * `undefined` sorts before every real record.
 */
function leaseFreshnessKey(record?: LeaseRecord): string {
  return record ? `${record.acquiredAt} ${record.expiresAt}` : "";
}

/** One lease's live state: the current holder only. An operator lease keeps no history; a work lease (./work-lease.ts) appends each change to `_leases/<id>.jsonl` beside it. */
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
  /**
   * The value of the remote-tracking ref (`refs/chant/lease-remote/<op>`)
   * after the fetch: what the remote held when last seen, or `null` when it
   * held nothing. The `--force-with-lease` expectation of the next push
   * (#2732).
   */
  remoteSha: string | null;
}

/** Options every lease read and write takes. `cwd` also picks the ledger, and so the member prefix of the refs (./member-ledger.ts). */
export interface LeaseOptions {
  cwd?: string;
}

async function readRecordAt(ref: string, opts?: { cwd?: string }): Promise<{ sha: string | null; record?: LeaseRecord }> {
  const sha = await readRefSha(ref, opts);
  return { sha, record: sha ? parseLease((await readBlobBySha(sha, opts)) ?? "") : undefined };
}

/**
 * Read the live lease for `opName`, fetching the remote ref first (best-
 * effort) so a lease held by another machine is visible before deciding
 * whether to acquire.
 *
 * The fetch lands in a side tracking ref (`refs/chant/lease-remote/<op>`),
 * never directly into `refs/chant/lease/<op>` itself (#1959 finding 3) — the
 * canonical local ref is written *only* by the CAS path
 * (`acquireLease`/`releaseLease`), so a read (this function is called
 * before every `acquireLease`, and directly by `chant operator status`) can
 * never force it back to a stale remote value out from under a concurrent
 * local acquirer. The returned `record` is whichever of the local/remote
 * views is more current by `leaseFreshnessKey` (ties keep local): this
 * still gives full cross-machine visibility — a genuinely newer remote
 * holder wins — while a just-acquired, not-yet-pushed local lease (freshest
 * by construction) always survives a same-clone concurrent read. `sha`
 * — the CAS anchor a subsequent `acquireLease`/`releaseLease` writes
 * against — is always the local ref's own actual value; only the local
 * canonical ref is ever a valid basis for a `updateRefCAS`/`deleteRefCAS`
 * call against it, regardless of what the comparison decided about `record`.
 *
 * When the remote answers without the ref, the lease was released there, and
 * the tracking ref is dropped so a stale copy of it no longer counts (#2732).
 * A read-only report that must stay off the network reads the refs itself
 * (`./work-lease.ts`'s `listWorkLeases`).
 */
export async function readLease(opName: string, opts?: LeaseOptions): Promise<ReadLeaseResult> {
  const { ref, trackingRef } = await projectLeaseRefs(opName, opts);
  const fetched = await fetchRefIntoStatus(ref, trackingRef, opts).catch(() => "failed" as const);
  if (fetched === "missing") {
    const stale = await readRefSha(trackingRef, opts);
    if (stale) await deleteRefCAS(trackingRef, stale, opts).catch(() => undefined);
  }

  const { sha, record: localRecord } = await readRecordAt(ref, opts);
  const { sha: remoteSha, record: remoteRecord } = await readRecordAt(trackingRef, opts);

  const record = leaseFreshnessKey(remoteRecord) > leaseFreshnessKey(localRecord) ? remoteRecord : localRecord;
  return { sha, record, remoteSha };
}

/** Why {@link acquireLease} did not acquire (#2732). */
export type LeaseRefusal =
  /** Someone holds it live: another holder, or, under `mode: "claim"`, anyone. */
  | "held"
  /** `mode: "renew"` and nobody holds it live any more: it expired or was released. */
  | "not-held"
  /** `mode: "renew"` and the live lease has another token than the one given. */
  | "token-mismatch"
  /** Another writer changed the ref between this call's read and its write. */
  | "race"
  /** `requirePush` and the remote refused the push: another clone got there first, or the remote could not be reached. */
  | "push-rejected";

export interface AcquireLeaseResult {
  acquired: boolean;
  lease?: LeaseRecord;
  /** Present when not acquired: the lease record currently held by someone else. */
  heldBy?: LeaseRecord;
  /** Present when not acquired: why (#2732). */
  reason?: LeaseRefusal;
}

/** Options for {@link acquireLease}. */
export interface AcquireLeaseOptions extends LeaseOptions {
  ttlMs?: number;
  now?: () => Date;
  /**
   * `acquire` (the default, the operator's): take it when free or expired,
   * renew it when `holder` already holds it. `claim`: take it only when free
   * or expired, and refuse even its own holder. `renew`: only move the expiry
   * of a live lease `holder` holds (#2732).
   */
  mode?: "acquire" | "claim" | "renew";
  /** With `mode: "renew"`, the token the caller holds; a live lease with another token is refused. */
  token?: string;
  /**
   * Count the write only once the remote has taken it, when there is a
   * remote. A rejected push undoes the local write and refuses with
   * `push-rejected`, so two clones racing for one lease cannot both hold it.
   * The operator leaves it off: its push is best-effort (#2732).
   */
  requirePush?: boolean;
  /**
   * Wait out a `.lock` another process holds on the ref for up to this long,
   * retrying, before surfacing it as a {@link StaleLockError}. A lock left by
   * a killed process outlives the wait; one held by a racing writer does
   * not. Off (0) by default, as the operator has always had it.
   */
  lockWaitMs?: number;
}

/**
 * Acquire or renew the lease for `opName` as `holder`. Succeeds when the ref
 * doesn't exist yet, is expired, or is already held by `holder` (a renewal:
 * same token, pushed-out expiry). Fails — returns `acquired: false`, without
 * throwing — when it's live-held by someone else, or when a concurrent CAS
 * write is lost to a race that happened between this call's read and its
 * write ({@link RefCASConflictError}); both read identically to a caller
 * deciding whether to tick this round ("someone else has it right now,
 * skip").
 *
 * Deliberately does NOT swallow a `StaleLockError` (./git.ts) into that same
 * "someone else has it" outcome (#1959 finding 2): a leftover `.lock` file
 * from a killed process is not contention, it's wreckage, and treating it as
 * "held by someone else" would make `chant operator` back off forever
 * against a lease nobody can ever actually acquire again without manual
 * intervention. It propagates instead, so the caller (`../op/operator.ts`'s
 * `runOperatorRound`) can surface it as its own distinct, diagnosable event
 * rather than a silent, permanent skip. `lockWaitMs` waits a racing writer's
 * lock out first.
 *
 * `mode`, `token` and `requirePush` are the work lease's (#2732,
 * ./work-lease.ts); the operator uses none of them.
 */
export async function acquireLease(
  opName: string,
  holder: string,
  opts?: AcquireLeaseOptions,
): Promise<AcquireLeaseResult> {
  const deadline = Date.now() + (opts?.lockWaitMs ?? 0);
  for (;;) {
    try {
      return await acquireOnce(opName, holder, opts);
    } catch (err) {
      if (!(err instanceof StaleLockError) || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 60)));
    }
  }
}

async function acquireOnce(opName: string, holder: string, opts?: AcquireLeaseOptions): Promise<AcquireLeaseResult> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = opts?.now?.() ?? new Date();
  const mode = opts?.mode ?? "acquire";

  const { sha, record: current, remoteSha } = await readLease(opName, opts);
  const expired = !current || isExpired(current, now);
  const ownedByUs = current?.holder === holder;

  if (mode === "renew") {
    if (!current || expired || !ownedByUs) return { acquired: false, reason: current && !expired ? "held" : "not-held", ...(current ? { heldBy: current } : {}) };
    if (opts?.token !== undefined && current.token !== opts.token) return { acquired: false, reason: "token-mismatch", heldBy: current };
  } else if (current && !expired && (!ownedByUs || mode === "claim")) {
    return { acquired: false, heldBy: current, reason: "held" };
  }

  const renewing = !!current && ownedByUs && !expired;
  const record: LeaseRecord = {
    op: opName,
    holder,
    token: renewing ? current.token : randomUUID(),
    acquiredAt: renewing ? current.acquiredAt : now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };

  const { ref, trackingRef } = await projectLeaseRefs(opName, opts);
  const blobSha = await writeBlob(JSON.stringify(record), opts);
  try {
    await updateRefCAS(ref, blobSha, sha, opts);
  } catch (err) {
    if (err instanceof RefCASConflictError) {
      const retry = await readLease(opName, opts);
      return { acquired: false, heldBy: retry.record, reason: "race" };
    }
    // A StaleLockError (or any other non-CAS failure) is NOT "someone else
    // has it" — propagate it as its own distinct error rather than folding
    // it into `heldBy`, per this function's doc.
    throw err;
  }
  const pushed = await pushRefStatus(ref, { ...opts, expect: remoteSha }).catch(() => "rejected" as const);
  if (pushed === "pushed") {
    // What the remote holds now; the next push expects it.
    await updateRefCAS(trackingRef, blobSha, remoteSha, opts).catch(() => undefined);
  } else if (pushed === "rejected" && opts?.requirePush) {
    // Undo the local write, which the remote refused, and report who has it there.
    await (sha === null ? deleteRefCAS(ref, blobSha, opts) : updateRefCAS(ref, sha, blobSha, opts)).catch(() => undefined);
    const retry = await readLease(opName, opts);
    const heldBy = retry.record && retry.record.token !== record.token ? retry.record : undefined;
    return { acquired: false, reason: "push-rejected", ...(heldBy ? { heldBy } : {}) };
  }
  return { acquired: true, lease: record };
}

/**
 * Release the lease, but only when `holder`/`token` still match the live
 * value — releasing a lease this caller no longer actually holds would
 * silently drop someone else's. Best-effort courtesy: a lease nobody
 * releases is reclaimed anyway once its TTL passes, so a failed release
 * (returns `false`, never throws) is not itself a correctness problem.
 *
 * The deletion is pushed to the remote, expecting the value last fetched
 * there, so another clone sees the lease free without waiting out its TTL
 * (#2732).
 */
export async function releaseLease(
  opName: string,
  holder: string,
  token: string,
  opts?: LeaseOptions,
): Promise<boolean> {
  const { sha, record, remoteSha } = await readLease(opName, opts);
  if (!record || record.holder !== holder || record.token !== token) return false;
  const { ref, trackingRef } = await projectLeaseRefs(opName, opts);
  if (sha) {
    try {
      await deleteRefCAS(ref, sha, opts);
    } catch {
      return false;
    }
  }
  const pushed = await pushRefStatus(ref, { ...opts, expect: remoteSha }).catch(() => "rejected" as const);
  if (pushed === "pushed" && remoteSha) await deleteRefCAS(trackingRef, remoteSha, opts).catch(() => undefined);
  return sha !== null || pushed === "pushed";
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
  opts?: LeaseOptions,
): Promise<boolean> {
  const { record } = await readLease(opName, opts);
  return record?.holder === holder && record?.token === token;
}
