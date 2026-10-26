/**
 * Taking a set of state locks in one order, each the way its backend takes
 * it, with lock info that names the operation and the run. A lock another
 * run holds stops the take: every lock taken so far is released, and the
 * error names the holder from the lock info it left.
 *
 * A run can also hold the lock of a workspace a state is read from, which
 * no backend block of the root names (a Terraform Cloud or Enterprise
 * workspace a state migration moves from, terragucci#1274): the workspace's
 * own lock, taken through its API before any state lock (`takeSourceLocks`,
 * `takeLocksWithSources`).
 *
 * Lifted from terragucci's `migrate.ts` (c493e0e): `lockInfo`,
 * `LockOperation`, `HeldLock` and `takeLocks`, and the source-workspace lock
 * of its `takeLocks` (lines 1045 to 1056).
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { LockHolder, StateStore } from "./store";

/** What a lock says holds it: the operation and a line of info, as the binary prints them when it finds the lock held. */
export interface LockOperation {
  operation: string;
  info: string;
}

/** The lock info a run writes, in the shape the binary writes and prints when it finds a lock held. */
export function lockInfo(path: string, now: string, op: LockOperation, who = `chant@${hostname()}`): string {
  return JSON.stringify({ ID: randomUUID(), Operation: op.operation, Info: op.info, Who: who, Version: "", Created: now, Path: path });
}

/** Who holds a lock, from the lock info it left: what is there of it. */
export interface LockHolderInfo {
  id: string;
  who?: string;
  operation?: string;
  info?: string;
  created?: string;
}

/** The holder a lock info names. */
export function holderOf(held: LockHolder): LockHolderInfo {
  let v: Record<string, unknown> = {};
  try {
    v = JSON.parse(held.info) as Record<string, unknown>;
  } catch {
    // Lock info that is not JSON names no one.
  }
  const s = (k: string): string | undefined => (typeof v[k] === "string" && v[k] !== "" ? (v[k] as string) : undefined);
  return { id: held.id, ...(s("Who") ? { who: s("Who") } : {}), ...(s("Operation") ? { operation: s("Operation") } : {}), ...(s("Info") ? { info: s("Info") } : {}), ...(s("Created") ? { created: s("Created") } : {}) };
}

/** A lock held by another run stopped the take; nothing was pulled. */
export class StateLockedError extends Error {
  constructor(
    readonly root: string,
    readonly lockLocation: string,
    readonly holder?: LockHolderInfo,
  ) {
    const by = holder ? [holder.who && `by ${holder.who}`, holder.operation, holder.info && `(${holder.info})`, holder.created && `since ${holder.created}`].filter(Boolean).join(" ") : "";
    super(`${root}: its state is locked at ${lockLocation}${by ? ` ${by}` : ""}, so nothing was pulled`);
    this.name = "StateLockedError";
  }
}

/** What taking a lock needs of a store: a caller with a store of its own (terragucci's, which also reads versions) passes that. */
export type LockStore = Pick<StateStore, "location" | "lockLocation" | "heldLock" | "lock" | "unlock" | "adopt">;

/** A lock taken, on one root's state. */
export interface HeldLock<S extends LockStore = StateStore> {
  root: string;
  store: S;
  /** The lock was another run's, kept on purpose with a state it could not write, and this take took it over. */
  adopted: boolean;
  release: () => Promise<void>;
}

/**
 * Take the lock of each state, in the order given. Releases what it took and
 * throws StateLockedError when one is held and `adopt` does not take it over.
 * `adopt` sees a held lock and says whether this take takes it over (a lock
 * an earlier run of the same operation left held on purpose).
 */
export async function takeLocks<S extends LockStore = StateStore>(
  stores: readonly { root: string; store: S }[],
  now: string,
  op: LockOperation,
  adopt?: (root: string, store: S, held: LockHolder) => Promise<boolean>,
  who?: string,
): Promise<HeldLock<S>[]> {
  const held: HeldLock<S>[] = [];
  const releaseAll = async (): Promise<void> => {
    for (const h of held.reverse()) await h.release().catch(() => {});
  };
  for (const { root, store } of stores) {
    let got: boolean;
    try {
      got = await store.lock(lockInfo(store.location.replace(/^[a-z0-9]+:\/\//, ""), now, op, who));
    } catch (e) {
      await releaseAll();
      throw new Error(`${root}: the lock ${store.lockLocation} could not be taken: ${(e as Error).message}`);
    }
    if (got) {
      held.push({ root, store, adopted: false, release: () => store.unlock() });
      continue;
    }
    const info = await store.heldLock().catch(() => undefined);
    if (info && adopt && (await adopt(root, store, info).catch(() => false))) {
      store.adopt(info);
      held.push({ root, store, adopted: true, release: () => store.unlock() });
      continue;
    }
    await releaseAll();
    throw new StateLockedError(root, store.lockLocation, info ? holderOf(info) : undefined);
  }
  return held;
}

/**
 * The lock of a workspace a state is read from, taken through the
 * workspace's own API (Terraform Cloud's `actions/lock`), not a lock object
 * beside a state. `lock` takes it with a reason the workspace shows, and
 * returns its release; it throws when another run holds it.
 */
export interface SourceLock {
  root: string;
  /** The workspace, for messages. */
  location: string;
  lock(reason: string): Promise<() => Promise<void>>;
}

/** A source workspace's lock, taken. */
export interface HeldSourceLock {
  root: string;
  location: string;
  release: () => Promise<void>;
}

/** A source workspace's lock could not be taken: another run holds it, or the API refused. Nothing was read. */
export class SourceLockedError extends Error {
  constructor(
    readonly root: string,
    readonly location: string,
    readonly reason: string,
  ) {
    super(`${root}: the lock of the workspace it is read from (${location}) could not be taken: ${reason}`);
    this.name = "SourceLockedError";
  }
}

/** The reason a source workspace's lock shows: the operation and its info, as a state lock's info names them. */
export const sourceLockReason = (op: LockOperation): string => `${op.operation}: ${op.info}`;

/**
 * Take each source workspace's lock, in the order given, so no run writes a
 * state while it is read. Releases what it took and throws SourceLockedError
 * when one cannot be taken.
 */
export async function takeSourceLocks(sources: readonly SourceLock[], op: LockOperation): Promise<HeldSourceLock[]> {
  const held: HeldSourceLock[] = [];
  for (const s of sources) {
    try {
      held.push({ root: s.root, location: s.location, release: await s.lock(sourceLockReason(op)) });
    } catch (e) {
      for (const h of held.reverse()) await h.release().catch(() => {});
      throw new SourceLockedError(s.root, s.location, (e as Error).message);
    }
  }
  return held;
}

export interface LocksWithSourcesInput<S extends LockStore> {
  /** The workspaces states are read from, locked first. */
  sources: readonly SourceLock[];
  /** The states written, locked after the sources, in the order given. */
  stores: readonly { root: string; store: S }[];
  now: string;
  /** What the state locks name. */
  op: LockOperation;
  /** What a source workspace's lock names; default `op`. A run that only reads the source says so here. */
  sourceOp?: LockOperation;
  adopt?: (root: string, store: S, held: LockHolder) => Promise<boolean>;
  who?: string;
}

/**
 * Every lock a run that reads from source workspaces and writes states
 * holds: the source workspaces' first, then the states'. When any cannot be
 * taken, every lock taken so far is released, and the error is
 * SourceLockedError or StateLockedError.
 */
export async function takeLocksWithSources<S extends LockStore = StateStore>(input: LocksWithSourcesInput<S>): Promise<{ sources: HeldSourceLock[]; locks: HeldLock<S>[] }> {
  const sources = await takeSourceLocks(input.sources, input.sourceOp ?? input.op);
  try {
    const locks = await takeLocks(input.stores, input.now, input.op, input.adopt, input.who);
    return { sources, locks };
  } catch (e) {
    for (const h of sources.reverse()) await h.release().catch(() => {});
    throw e;
  }
}
