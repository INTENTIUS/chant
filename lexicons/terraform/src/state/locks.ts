/**
 * Taking a set of state locks in one order, each the way its backend takes
 * it, with lock info that names the operation and the run. A lock another
 * run holds stops the take: every lock taken so far is released, and the
 * error names the holder from the lock info it left.
 *
 * Lifted from terragucci's `migrate.ts` (c493e0e): `lockInfo`,
 * `LockOperation`, `HeldLock` and `takeLocks`.
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

/** A lock taken, on one root's state. */
export interface HeldLock {
  root: string;
  store: StateStore;
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
export async function takeLocks(
  stores: readonly { root: string; store: StateStore }[],
  now: string,
  op: LockOperation,
  adopt?: (root: string, store: StateStore, held: LockHolder) => Promise<boolean>,
  who?: string,
): Promise<HeldLock[]> {
  const held: HeldLock[] = [];
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
