/**
 * A state migration between Terraform roots (#4762), for chant core's
 * gated migration (`@intentius/chant/state-migration`): what `moved`,
 * `import` and `removed` blocks cannot do, because each works inside one
 * root's state.
 *
 *   moves     resources (`[module.<m>.]<type>.<name>`) or module calls
 *             (`module.<m>`), with every instance, from one root's state to
 *             the same address in another's
 *   restores  a root's state put back to a version a migration recorded (a
 *             revert), refused when the state moved past what that
 *             migration left
 *
 * Planning (planTerraformMigration) initialises each root in a data dir of
 * its own, reads its backend version id and pulls its state, keeps only
 * their digests, builds each new state in the work dir, and plans each root
 * against its new state through a local-backend override file and another
 * data dir, so the root's own `.terraform` and its real state are not
 * touched. The engine it returns writes the new states for core under each
 * stored state's lock (s3's lock file, the gcs lock object, the azurerm
 * lease, as `./state/locks.ts` takes them): `state push -lock=false`, or a
 * write under the lease on azurerm, the roots that gain resources first, so
 * a write that stops half way leaves a resource in two states rather than
 * in none. Then each root plans against its real backend.
 *
 * State contents never leave the work dir. The record holds version ids and
 * digests.
 *
 * Lifted from terragucci's `migrate.ts` (`moveResources`, `addressMatches`,
 * `derivedLineage`, `stateDigest`, `resourceChanges`, `backendBlock`,
 * `proofPlan`, `planMigration`'s moves and reverts, `applyMigration`,
 * `movedSince`), so terragucci deletes its copy. A backend move (a state
 * read from another backend, a TFE workspace or an exported file) and a
 * migration of choudoufu's live estates stay terragucci's for now.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { MigrationCheck, MigrationRootPlan, MigrationStateAt, StateMigrationEngine } from "@intentius/chant/state-migration";
import { initRoot, planStateCheck, pushStateFile, type RootRun } from "./state-ops";
import { isRefused, isStored, stateLocation, stateObject, type LockableState } from "./state/backend";
import { pullState, runBinary, type BinaryExec, type StateFile, type StateResource } from "./state/exec";
import { takeLocksWithSources, type LockOperation } from "./state/locks";
import type { StoreFetch } from "./state/object-store";
import { stateStore, type StateStore } from "./state/store";
import { stateVersionSource } from "./state/versions";

/** Resources that move from one root's state to another's. */
export interface Move {
  from: string;
  to: string;
  addresses: string[];
}

/** A root's state put back to a version a migration recorded. */
export interface Restore {
  root: string;
  /** Where the state is, as the migration recorded it. */
  location: string;
  /** The version to put back; null when the root had no state before, so it gets an empty one. */
  version_id: string | null;
  /** The version the migration left: a state that moved past it is refused. */
  from_version_id: string | null;
}

/** A migration that cannot be planned: an address in no state, a root that is refused. Nothing was written. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** A state's digest: sha256 of its JSON as parsed and written back, so whitespace never moves it. */
export const stateDigest = (s: StateFile): string => sha(JSON.stringify(s));

/** A resource entry's address without instance keys: `module.a.module.b.type.name`, module keys dropped. */
const resourceAddress = (r: StateResource): string => `${r.module ? `${r.module.replace(/\[[^\]]*\]/g, "")}.` : ""}${r.mode === "data" ? "data." : ""}${r.type}.${r.name}`;
const moduleOf = (r: StateResource): string => (r.module ?? "").replace(/\[[^\]]*\]/g, "");

/** Whether a migration address names a state entry: the managed resource itself, or a module call it sits in, with its data sources. */
export function addressMatches(address: string, r: StateResource): boolean {
  if (/(^|\.)module\.[A-Za-z_][\w-]*$/.test(address)) return moduleOf(r) === address || moduleOf(r).startsWith(`${address}.`);
  return r.mode === "managed" && resourceAddress(r) === address;
}

/** A lineage that a migration and a root always give the same: a state planned twice has one digest. */
export function derivedLineage(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\n")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const emptyState = (lineage: string, serial: number, terraformVersion = "1.0.0"): StateFile => ({ version: 4, terraform_version: terraformVersion, serial, lineage, outputs: {}, resources: [], check_results: null });

/**
 * The states after the moves. `before` holds each affected root's state, or
 * null when it has none. A changed state keeps its lineage and gets the next
 * serial; a root with no state gets a new one, its lineage derived from the
 * migration and the root. Throws MigrationError naming every address that
 * is in no state, or already in the root it moves to.
 */
export function moveResources(name: string, moves: readonly Move[], before: ReadonlyMap<string, StateFile | null>): Map<string, StateFile> {
  const after = new Map<string, StateFile>();
  const take = (root: string, from?: StateFile | null): StateFile => {
    const held = after.get(root);
    if (held) return held;
    const was = before.get(root) ?? null;
    const s: StateFile = was ? { ...structuredClone(was), serial: was.serial + 1 } : emptyState(derivedLineage(name, root), 1, from?.terraform_version);
    after.set(root, s);
    return s;
  };
  const problems: string[] = [];
  for (const m of moves) {
    const src = before.get(m.from) ?? null;
    if (!src) {
      problems.push(`${m.from} has no state to move ${m.addresses.join(", ")} from`);
      continue;
    }
    const from = take(m.from);
    const to = take(m.to, src);
    for (const address of m.addresses) {
      const found = from.resources.filter((r) => addressMatches(address, r));
      if (found.length === 0) {
        problems.push(`${address} is not in the state of ${m.from}`);
        continue;
      }
      if (to.resources.some((r) => addressMatches(address, r))) {
        problems.push(`${address} is already in the state of ${m.to}`);
        continue;
      }
      from.resources = from.resources.filter((r) => !found.includes(r));
      to.resources.push(...found);
    }
  }
  if (problems.length > 0) throw new MigrationError(`migration ${name}:\n  ${problems.join("\n  ")}`);
  return after;
}

/** The resource changes of a plan's JSON, as `<address>: <actions>`; no-ops and reads are not changes. */
export function resourceChanges(plan: unknown): string[] {
  const rc = (plan as { resource_changes?: { address?: string; change?: { actions?: string[] } }[] } | undefined)?.resource_changes ?? [];
  return rc
    .filter((c) => {
      const a = c.change?.actions ?? [];
      return !(a.length === 1 && (a[0] === "no-op" || a[0] === "read"));
    })
    .map((c) => `${c.address}: ${(c.change?.actions ?? []).join("+")}`);
}

/** A terraform block whose backend is the local file `path`, for the proof plan's override file. Terraform and OpenTofu merge any `*_override.tf` over the root's files. */
export const localBackendOverride = (path: string): string => `terraform {\n  backend "local" {\n    path = ${JSON.stringify(path)}\n  }\n}\n`;

/** The override file a proof plan writes into a root, and removes, unless the product names its own. */
export const DEFAULT_OVERRIDE_FILE = "chant_migrate_override.tf";

/** What a migration's lock says, unless the product names its own. */
export const DEFAULT_MIGRATE_LOCK: LockOperation = { operation: "chant migrate", info: "a state migration is writing this state" };

/** One root a migration reads or writes. */
export interface MigrationRootRun extends Omit<RootRun, "exec"> {
  /** Run `init` in a data dir of the migration's own (default), or false for a root another tool initialised in `dir` with `env`. */
  init?: boolean;
}

export interface TerraformMigrationInput {
  /** The migration's name: what its gate is called, and what a new root's lineage derives from. */
  name: string;
  /** Resources that move between roots. */
  moves?: Move[];
  /** States put back to a version a migration recorded. */
  restores?: Restore[];
  /** Every root the moves or restores name. */
  roots: MigrationRootRun[];
  /** The work dir: new states, plans and data dirs. The caller removes it. */
  work: string;
  exec?: BinaryExec;
  fetch?: StoreFetch;
  /** What the migration's lock says. */
  lock?: LockOperation;
  /** Who the lock names. Default `chant@<host>`. */
  who?: string;
  /** The proof plan's override file. Default {@link DEFAULT_OVERRIDE_FILE}. */
  overrideFile?: string;
  log?: (line: string) => void;
}

/** A planned migration: each root's plan for core, and the engine that writes it. */
export interface TerraformMigrationPlan {
  roots: MigrationRootPlan[];
  engine: StateMigrationEngine;
}

interface Planned {
  run: MigrationRootRun & { env: NodeJS.ProcessEnv };
  object: LockableState;
  file: string;
  gained: number;
}

/** A root's version id now, when its store keeps versions. `pin` lets an azurerm blob with snapshots only take one to name it. */
async function versionNow(o: LockableState, fetchFn: StoreFetch | undefined, pin: boolean): Promise<string | undefined> {
  const src = stateVersionSource(o, fetchFn, { pin });
  if ("refused" in src) return undefined;
  return (await src.current()).versionId;
}

/**
 * Plan a migration: read every affected state and its version, build the new
 * states in `work`, and plan each root against its new state. Throws
 * MigrationError for a root that is refused or a move that does not fit.
 */
export async function planTerraformMigration(input: TerraformMigrationInput): Promise<TerraformMigrationPlan> {
  const exec = input.exec ?? runBinary;
  const log = input.log ?? (() => {});
  const lockOp = input.lock ?? DEFAULT_MIGRATE_LOCK;
  const override = input.overrideFile ?? DEFAULT_OVERRIDE_FILE;
  if (!!input.moves?.length === !!input.restores?.length) throw new MigrationError(`migration ${input.name}: give it moves or restores, one of the two`);
  mkdirSync(input.work, { recursive: true });
  const named = [...new Set(input.moves ? input.moves.flatMap((m) => [m.from, m.to]) : input.restores!.map((r) => r.root))].sort();
  const byName = new Map(input.roots.map((r) => [r.root, r]));
  const missing = named.filter((n) => !byName.has(n));
  if (missing.length > 0) throw new MigrationError(`migration ${input.name}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not among its roots`);

  const runs = new Map<string, Planned["run"]>();
  const objects = new Map<string, LockableState>();
  const versions = new Map<string, string | undefined>();
  const before = new Map<string, StateFile | null>();
  for (const [i, name] of named.entries()) {
    const r = byName.get(name)!;
    let env = r.env ?? process.env;
    if (r.init !== false) {
      env = { ...env, TF_DATA_DIR: join(input.work, `data-${i}`) };
      await initRoot({ ...r, env, exec, reconfigure: true });
    }
    const o = stateObject(r.dir, env, undefined, r.binary);
    if (isRefused(o)) throw new MigrationError(`migration ${input.name} cannot run: ${name}: ${o.reason}`);
    runs.set(name, { ...r, env });
    objects.set(name, o);
    versions.set(name, await versionNow(o, input.fetch, false));
    before.set(name, await pullState(exec, r.binary, name, r.dir, env));
  }

  const after = new Map<string, StateFile>();
  if (input.moves) {
    for (const [root, s] of moveResources(input.name, input.moves, before)) after.set(root, s);
  } else {
    for (const r of input.restores!) {
      const o = objects.get(r.root)!;
      const location = stateLocation(o);
      if (location !== r.location) throw new MigrationError(`migration ${input.name}: ${r.root}'s state is at ${location}, and the revert restores ${r.location}`);
      const v = versions.get(r.root);
      if ((r.from_version_id ?? undefined) !== v) throw new MigrationError(`migration ${input.name}: ${r.root}'s state is at version ${v ?? "none"}, and the migration it reverts left ${r.from_version_id ?? "none"}; it moved since, so putting the older version back would undo that change too`);
      const now = before.get(r.root) ?? null;
      const lineage = now?.lineage || derivedLineage(input.name, r.root);
      const serial = (now?.serial ?? 0) + 1;
      if (r.version_id === null) {
        after.set(r.root, emptyState(lineage, serial, now?.terraform_version));
        continue;
      }
      const src = stateVersionSource(o, input.fetch);
      if ("refused" in src) throw new MigrationError(`migration ${input.name}: ${r.root}: ${src.refused}`);
      const text = await src.readVersion(r.version_id);
      if (text === undefined) throw new MigrationError(`migration ${input.name}: ${r.location} has no version ${r.version_id}; a lifecycle rule may have expired it`);
      const old = JSON.parse(typeof text === "string" ? text : Buffer.from(text).toString("utf-8")) as StateFile;
      after.set(r.root, { ...old, resources: Array.isArray(old.resources) ? old.resources : [], lineage, serial });
    }
  }

  const planned = new Map<string, Planned>();
  const roots: MigrationRootPlan[] = [];
  for (const [i, name] of named.entries()) {
    const state = after.get(name);
    if (!state) continue;
    const run = runs.get(name)!;
    const file = join(input.work, `${i}.tfstate`);
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    planned.set(name, { run, object: objects.get(name)!, file, gained: state.resources.length - (before.get(name)?.resources.length ?? 0) });
    const proof = await proofPlan(run, exec, file, join(input.work, `proof-${i}`), override);
    log(`${name}: ${proof.changes.length === 0 ? "no changes against its new state" : `${proof.changes.length} change${proof.changes.length === 1 ? "" : "s"} against its new state: ${proof.changes.join(", ")}`}`);
    const was = before.get(name) ?? null;
    const v = versions.get(name);
    const location = stateLocation(objects.get(name)!);
    roots.push({ root: name, ...(location ? { location } : {}), before: { ...(v ? { version_id: v } : {}), digest: was ? stateDigest(was) : null }, after: { digest: stateDigest(state) }, proof });
  }
  return { roots, engine: migrationEngine(planned, input, exec, lockOp) };
}

/**
 * Plan a root against a state file: an override file switches its backend to
 * that local file, in a data dir of its own, so the root's `.terraform` and
 * its real state are never touched. The override file is removed whatever
 * happens.
 */
async function proofPlan(run: Planned["run"], exec: BinaryExec, file: string, data: string, override: string): Promise<MigrationCheck> {
  const at = join(run.dir, override);
  const env = { ...run.env, TF_DATA_DIR: data };
  writeFileSync(at, localBackendOverride(resolve(file)));
  try {
    await initRoot({ ...run, env, exec, reconfigure: true });
    const read = await planStateCheck({ ...run, env, exec, planFile: `${data}.tfplan` });
    return { changes: resourceChanges(read.json), summary: read.summary };
  } finally {
    rmSync(at, { force: true });
  }
}

function migrationEngine(planned: Map<string, Planned>, input: TerraformMigrationInput, exec: BinaryExec, lockOp: LockOperation): StateMigrationEngine {
  const log = input.log ?? (() => {});
  const stores = new Map<string, StateStore>();
  for (const [root, p] of planned) if (isStored(p.object)) stores.set(root, stateStore(p.object, p.run.dir, input.fetch));
  const pinned = new Map<string, string>();
  return {
    async lock() {
      const got = await takeLocksWithSources({ sources: [], stores: [...stores].map(([root, store]) => ({ root, store })), now: new Date().toISOString(), op: lockOp, who: input.who ?? `chant@${hostname()}` });
      return async () => {
        for (const l of got.locks.reverse()) await l.release().catch((e: unknown) => log(`${l.root}: the lock could not be released: ${(e as Error).message}`));
      };
    },
    async current(root): Promise<MigrationStateAt> {
      const p = planned.get(root)!;
      const v = await versionNow(p.object, input.fetch, false);
      const s = await pullState(exec, p.run.binary, root, p.run.dir, p.run.env);
      return { ...(v ? { version_id: v } : {}), digest: s ? stateDigest(s) : null };
    },
    async write() {
      // An azurerm state named by no version gets a snapshot first, so the record names what it was.
      for (const [root, p] of planned) {
        if (p.object.backend !== "azurerm") continue;
        if (await versionNow(p.object, input.fetch, false)) continue;
        const v = await versionNow(p.object, input.fetch, true);
        if (v) pinned.set(root, v);
      }
      const order = [...planned].sort(([a, pa], [b, pb]) => pb.gained - pa.gained || (a < b ? -1 : 1));
      for (const [root, p] of order) {
        const store = stores.get(root);
        // A state whose lock keeps the binary out (azurerm's lease) is written under it; the binary writes the others with the lock held for it.
        if (store?.write) await store.write(readFileSync(p.file, "utf-8"));
        else await pushStateFile({ ...p.run, exec, file: p.file, ...(store ? { lock: false } : {}) });
        log(`${root}: wrote its new state`);
      }
    },
    async verify(root) {
      const p = planned.get(root)!;
      const read = await planStateCheck({ ...p.run, exec, planFile: join(input.work, `verify-${root.replace(/[^\w.-]/g, "_")}.tfplan`), ...(stores.has(root) ? { lock: false } : {}) });
      const v = await versionNow(p.object, input.fetch, true);
      const was = pinned.get(root);
      return { changes: resourceChanges(read.json), summary: read.summary, ...(v ? { version_id: v } : {}), ...(was ? { before_version_id: was } : {}) };
    },
  };
}
