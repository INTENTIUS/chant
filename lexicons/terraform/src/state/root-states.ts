/**
 * The states of a set of roots, held for one run: take every lock (in the
 * order given), pull each state, write each state back with retries, and
 * release each lock.
 *
 * A state whose write still fails after the retries is kept beside the state
 * in its own backend as `<key>.chant-unwritten`, and its lock stays held,
 * naming the run. The next take of that lock finds the kept state, takes
 * the lock over, writes the kept state, removes it, and only then returns.
 * When the backend cannot take the kept copy either, it goes under the job's
 * report directory (`<reportDir>/unwritten/<root>.tfstate`), never the
 * reports bucket.
 *
 * A take also reads a state terragucci kept as `<key>.terragucci-unwritten`
 * under a terragucci composed run's lock, so a repo that moves to chant
 * mid-incident keeps it. That name is read and removed, never written.
 *
 * Lifted from terragucci's `compose.ts` (c493e0e): `ComposedRun.plan`'s lock
 * take and kept write, `writeState`, `writeWithRetries`, `keep`,
 * `releaseOne` and `release`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRefused, stateObject, type LockableState, type StateObject, type StateRefusalKind } from "./backend";
import { lastLines, pullState, runBinary, type BinaryExec, type StateFile } from "./exec";
import { takeLocks, type HeldLock, type LockOperation } from "./locks";
import type { StoreFetch } from "./object-store";
import { stateStore, type StateStore } from "./store";

/** The suffix of the object beside a root's state that holds a state a run could not write. */
export const UNWRITTEN_SUFFIX = ".chant-unwritten";
/** The suffix terragucci keeps an unwritten state under: read and removed, never written. */
export const LEGACY_UNWRITTEN_SUFFIX = ".terragucci-unwritten";
/** The operation terragucci's composed run names in its locks. */
export const LEGACY_COMPOSE_OPERATION = "terragucci compose";
/** Where a kept state goes under the job's report directory when its own backend could not take it. */
export const UNWRITTEN_DIR = "unwritten";

/** The operation a composed run's locks name. */
export const COMPOSE_LOCK: LockOperation = { operation: "chant terraform.compose", info: "a composed run holds this state while it plans, applies and writes it" };

/** How long to wait before each retry of a state's write: five retries, inside the lock timeout of 5 minutes. */
export const DEFAULT_RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000];

/** One root whose state the run holds. */
export interface RootState {
  root: string;
  /** The root's directory, where the binary runs. */
  dir: string;
  /** The root's environment for the binary. */
  env: NodeJS.ProcessEnv;
  /** Where its state is; read from what `init` recorded, compared with the root's code, when absent. */
  object?: StateObject;
  /** `terraform.roots.<name>.backendConfig`, which the comparison with what init recorded reads (chant#4478). */
  backendConfig?: Readonly<Record<string, string>>;
  /** `terraform.roots.<name>.backendConfigFiles`, whose keys the same comparison reads (chant#4459). */
  backendConfigFiles?: readonly string[];
}

export interface RootStatesOptions {
  /** The roots, in the order their locks are taken. */
  roots: RootState[];
  /** The binary's path. */
  binary: string;
  exec?: BinaryExec;
  /** The operation the locks name. Default COMPOSE_LOCK. */
  op?: LockOperation;
  /** Names the run in the locks it takes. */
  runId?: string;
  /** A directory of the job's own for the state files `state push` reads. */
  work: string;
  /** The job's report directory, where a kept state goes when its backend cannot take it. */
  reportDir: string;
  retryDelays?: number[];
  sleep?: (ms: number) => Promise<void>;
  fetch?: StoreFetch;
  /** Opens a root's store; a test's fake stands in here. */
  openStore?: (root: RootState, object: LockableState) => StateStore;
  now?: () => string;
  /** Who the lock info names. */
  who?: string;
  log?: (line: string) => void;
}

/** Why a root's state is not locked. */
export interface RootRefusal {
  root: string;
  backend: string;
  refused: StateRefusalKind;
  reason: string;
}

/** The roots whose state chant does not lock: the take stops before any lock. */
export class StateRefusedError extends Error {
  constructor(readonly refusals: RootRefusal[]) {
    super(refusals.map((r) => `${r.root}: ${r.reason}`).join("\n"));
    this.name = "StateRefusedError";
  }
}

/** How a write ended: written, or kept with the lock held. */
export type WriteOutcome = { written: true; attempts: number } | { written: false; attempts: number; error: string; kept: string; lockHeld: true };

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const safeName = (root: string): string => (root === "." ? "root" : root.replace(/[^\w.-]/g, "_"));
const body = (s: StateFile): string => JSON.stringify(s, null, 2) + "\n";

export class RootStates {
  private readonly exec: BinaryExec;
  private readonly op: LockOperation;
  private readonly objects = new Map<string, StateObject>();
  private locks: HeldLock[] = [];
  private readonly heldOnPurpose = new Set<string>();

  constructor(private readonly o: RootStatesOptions) {
    this.exec = o.exec ?? runBinary;
    this.op = o.op ?? COMPOSE_LOCK;
    if (o.runId) this.op = { operation: this.op.operation, info: `${this.op.info} (run ${o.runId})` };
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  private rootOf(root: string): RootState {
    const r = this.o.roots.find((x) => x.root === root);
    if (!r) throw new Error(`${root} is not one of this run's roots`);
    return r;
  }

  /** Where a root's state is, or why it is not locked. */
  object(root: string): StateObject {
    let o = this.objects.get(root);
    if (!o) {
      const r = this.rootOf(root);
      o = r.object ?? stateObject(r.dir, r.env, undefined, this.o.binary, {
        ...(r.backendConfig ? { backendConfig: r.backendConfig } : {}),
        ...(r.backendConfigFiles ? { backendConfigFiles: r.backendConfigFiles } : {}),
      });
      this.objects.set(root, o);
    }
    return o;
  }

  /** Every root whose state chant does not lock, with why. */
  refusals(): RootRefusal[] {
    return this.o.roots.flatMap((r) => {
      const o = this.object(r.root);
      return isRefused(o) ? [{ root: r.root, backend: o.backend, refused: o.refused, reason: o.reason }] : [];
    });
  }

  /** The locks held now, by root. */
  held(): string[] {
    return this.locks.map((l) => l.root);
  }

  private lockOf(root: string): HeldLock | undefined {
    return this.locks.find((l) => l.root === root);
  }

  /**
   * Take every root's lock, in order. A root chant does not lock stops the
   * take before any lock (StateRefusedError); a lock another run holds
   * releases what was taken and throws StateLockedError, naming the holder.
   * A lock an earlier run of this operation left held with a kept state is
   * taken over, and every kept state is written before this returns.
   */
  async take(): Promise<void> {
    const refused = this.refusals();
    if (refused.length) throw new StateRefusedError(refused);
    const stores = this.o.roots.map((r) => {
      const object = this.object(r.root) as LockableState;
      return { root: r.root, store: this.o.openStore ? this.o.openStore(r, object) : stateStore(object, r.dir, this.o.fetch) };
    });
    const now = this.o.now?.() ?? new Date().toISOString();
    this.locks = await takeLocks(
      stores,
      now,
      this.op,
      async (root, store, held) => {
        // A lock an earlier composed run left held for a state it could not write: this run writes that state first.
        const ours = held.info.includes(this.op.operation) || held.info.includes(LEGACY_COMPOSE_OPERATION);
        if (!ours || !(await this.kept(store))) return false;
        this.log(`${root}: its lock is held by an earlier run that kept a state it could not write; this run takes the lock over and writes that state first`);
        return true;
      },
      this.o.who,
    );
    for (const l of this.locks) {
      try {
        await this.writeKept(l);
      } catch (e) {
        // The kept state is still unwritten: its lock stays held, the others are released.
        this.heldOnPurpose.add(l.root);
        await this.release();
        throw new Error(`${l.root}: the state an earlier run kept for it could not be written: ${(e as Error).message}`);
      }
    }
  }

  /** The state kept beside a store's state and the suffix it is under, chant's name first; undefined when none is kept. */
  private async kept(store: StateStore): Promise<{ suffix: string; text: string } | undefined> {
    for (const suffix of [UNWRITTEN_SUFFIX, LEGACY_UNWRITTEN_SUFFIX]) {
      const text = await store.readBeside(suffix).catch(() => undefined);
      if (text?.trim()) return { suffix, text };
    }
    return undefined;
  }

  /** A state an earlier run kept beside a root's state: write it, then remove what was kept. */
  private async writeKept(lock: HeldLock): Promise<void> {
    const kept = await this.kept(lock.store);
    if (!kept) return;
    await this.writeState(lock.root, JSON.parse(kept.text) as StateFile);
    await lock.store.removeBeside(kept.suffix);
    this.log(`${lock.root}: wrote the state an earlier run kept at ${lock.store.besideLocation(kept.suffix)}`);
  }

  /** A root's state as `state pull` gives it, or null when it has none. */
  pull(root: string): Promise<StateFile | null> {
    const r = this.rootOf(root);
    return pullState(this.exec, this.o.binary, root, r.dir, r.env);
  }

  /** Write one root's state under its lock: the store's own write (azurerm's lease), else `state push -lock=false`. */
  private async writeState(root: string, state: StateFile): Promise<void> {
    const lock = this.lockOf(root);
    if (!lock) throw new Error(`${root}: its state is written under its lock, and none is held`);
    if (lock.store.write) {
      await lock.store.write(body(state));
      return;
    }
    const r = this.rootOf(root);
    const file = join(this.o.work, `${safeName(root)}.tfstate`);
    mkdirSync(this.o.work, { recursive: true });
    writeFileSync(file, body(state));
    const push = await this.exec(this.o.binary, ["state", "push", "-lock=false", file], r.dir, r.env);
    if (push.code !== 0) throw new Error(`state push failed: ${lastLines(push.out, 3)}`);
  }

  /**
   * Write one root's state, retrying after each delay while the lock is
   * held. A state still unwritten after the last retry is kept, and its lock
   * stays held: `release` leaves it.
   */
  async write(root: string, state: StateFile): Promise<WriteOutcome> {
    const delays = this.o.retryDelays ?? DEFAULT_RETRY_DELAYS;
    const sleep = this.o.sleep ?? sleepMs;
    let last = "";
    for (let i = 0; i <= delays.length; i++) {
      try {
        await this.writeState(root, state);
        return { written: true, attempts: i + 1 };
      } catch (e) {
        last = (e as Error).message;
        if (i < delays.length) {
          this.log(`${root}: the write of its state failed (${last}); trying again in ${Math.round(delays[i]! / 1000)}s`);
          await sleep(delays[i]!);
        }
      }
    }
    const kept = await this.keep(root, state);
    this.heldOnPurpose.add(root);
    this.log(`${root}: its state could not be written (${last}); kept at ${kept}, and its lock stays held until a later run writes it`);
    return { written: false, attempts: delays.length + 1, error: last, kept, lockHeld: true };
  }

  /** Keep a state that could not be written: beside it in its own backend, else as a file of the job's report directory. Returns where. */
  private async keep(root: string, state: StateFile): Promise<string> {
    const lock = this.lockOf(root);
    try {
      if (lock) {
        await lock.store.writeBeside(UNWRITTEN_SUFFIX, body(state));
        return lock.store.besideLocation(UNWRITTEN_SUFFIX);
      }
    } catch (e) {
      this.log(`${root}: the state could not be kept beside its backend's state either (${(e as Error).message}); it is kept under the job's report directory`);
    }
    const file = join(this.o.reportDir, UNWRITTEN_DIR, `${safeName(root)}.tfstate`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body(state));
    return file;
  }

  /**
   * Keep a root's lock held past {@link release}, as a kept state's is: for a
   * root whose state the run could neither write nor keep, so no other run
   * plans against a state that may not hold what applied.
   */
  hold(root: string): void {
    if (this.lockOf(root)) this.heldOnPurpose.add(root);
  }

  /** The roots whose lock stays held past {@link release}. */
  heldOnPurposeRoots(): string[] {
    return [...this.heldOnPurpose].filter((r) => this.lockOf(r)).sort();
  }

  /** Release a root's lock, or every lock but those held on purpose for a kept state. */
  async release(root?: string): Promise<void> {
    const which = root ? [root] : [...new Set(this.locks.map((l) => l.root))].filter((r) => !this.heldOnPurpose.has(r));
    for (const r of which) {
      const mine = this.locks.filter((l) => l.root === r);
      this.locks = this.locks.filter((l) => l.root !== r);
      for (const l of mine) await l.release().catch((e: unknown) => this.log(`${r}: its lock could not be released: ${(e as Error).message}`));
    }
  }
}
