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
 *   backends  a root's state moved to the backend its code names now, from
 *             the backend it was in (read through the root with an
 *             override file naming that backend, in a data dir of its own),
 *             from a TFE-API workspace or from an exported state file
 *             (`./state/source.ts`), #4806. The backend the code names must
 *             hold no state; the state read is left where it was
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
 * A backend that keeps no versions (pg, kubernetes, consul, an http backend
 * other than GitLab's) takes the general path, for each kind (#4806): the
 * binary reads it with `state pull` and writes it with `state push` under
 * the backend's own lock, which refuses a state of another lineage or an
 * older serial, and the digest binds the state's contents, since there is
 * no version id to bind. A backend move into one replaces the empty state a
 * backend writes at init (kubernetes does) with `-force`; the digest bound
 * that it was empty.
 *
 * A backend move's root names its source (`MigrationRootPlan.source`): the
 * request binds it, under the locks the engine reads it again, and the lock
 * of a workspace it is read from is taken first, through the workspace's
 * API.
 *
 * State contents never leave the work dir. The record holds version ids and
 * digests.
 *
 * Lifted from terragucci's `migrate.ts` (`moveResources`, `addressMatches`,
 * `derivedLineage`, `stateDigest`, `resourceChanges`, `backendBlock`,
 * `proofPlan`, `planMigration`, `applyMigration`, `movedSince`, `takeLocks`,
 * `readSource`, `withBackend`, `isPulled`, `PULLED_BACKENDS`,
 * `backendRefusal`, `parseBackends`, `pulledProblems`, `locationOf`), so
 * terragucci deletes its copy. A migration of choudoufu's live estates is
 * `./estate-migration.ts`.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { MigrationCheck, MigrationRootPlan, MigrationSource, MigrationStateAt, StateMigrationEngine } from "@intentius/chant/state-migration";
import { initRoot, planStateCheck, pushStateFile, type RootRun } from "./state-ops";
import { initialisedBackend, isRefused, isStored, readableStateObject, stateLocation, stateObject, type InitialisedBackend, type LockableState, type StateObject } from "./state/backend";
import { pullState, runBinary, type BinaryExec, type StateFile, type StateResource } from "./state/exec";
import { SourceLockedError, StateLockedError, takeLocksWithSources, type LockOperation, type SourceLock } from "./state/locks";
import type { StoreFetch } from "./state/object-store";
import { EXTERNAL_BACKENDS, externalProblems, externalSource, type ExternalSource } from "./state/source";
import { stateStore, type StateStore } from "./state/store";
import { keepsHistory, NO_HISTORY, recordedAddress, stateVersionSource } from "./state/versions";

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

/** A root's state moving to the backend its code now names, from the backend it was in (#4806). */
export interface BackendMove {
  root: string;
  /** Where the state is now: a backend's type and configuration, as a backend block gives them; `remote` or `cloud` for a TFE-API workspace; `file` with `config.path` for an exported state file. */
  from: { backend: string; config: Record<string, unknown> };
}

/** The backends a migration reads and writes through the binary, under the backend's own lock: those that keep no versions (#4806). */
export const PULLED_BACKENDS: readonly string[] = Object.keys(NO_HISTORY);

/** The backends a migration locks and writes itself. */
export const MIGRATED_BACKENDS: readonly string[] = ["s3", "gcs", "azurerm", "local", "http"];

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

/** A state with no resources and no outputs: what a backend writes at init before anything is applied. */
const isEmptyState = (s: StateFile): boolean => s.resources.length === 0 && Object.keys(s.outputs ?? {}).length === 0;

/** A state the binary reads and writes for a migration, under its backend's own lock: one that keeps no versions (pg, kubernetes, consul, an http backend other than GitLab's). */
export interface PulledState {
  backend: string;
  pulled: true;
  /** Its address, credentials left out, when the configuration names one. */
  location?: string;
}

/** The backend as a pulled state, or undefined when it is not one that keeps no versions. */
export function pulledState(b: InitialisedBackend, env: NodeJS.ProcessEnv = {}): PulledState | undefined {
  if (!PULLED_BACKENDS.includes(b.type) || keepsHistory(b, env) !== false) return undefined;
  const location = recordedAddress(b);
  return { backend: b.type, pulled: true, ...(location ? { location } : {}) };
}

/** A state a migration writes or reads: one chant locks, or one the binary reads and writes under its own lock. */
export type MigratedState = LockableState | PulledState;

const isPulledState = (o: MigratedState): o is PulledState => "pulled" in o;

/** Where a migrated state is, as the record names it. */
export const migratedLocation = (o: MigratedState): string | undefined => (isPulledState(o) ? o.location : stateLocation(o));

/** Settings of a pulled backend that hold a credential, which the job gives in the backend's own variables instead. */
const SECRET_KEYS: Record<string, string> = { password: "the backend's password variable", token: "the backend's token variable", client_key: "KUBE_CLIENT_KEY_DATA", access_token: "CONSUL_HTTP_TOKEN" };

/** The settings a backend move's `from.config` must give, by backend: where the state is. */
const FROM_NEEDS: Record<string, string[]> = { s3: ["bucket", "key"], gcs: ["bucket"], azurerm: ["storage_account_name", "container_name", "key"], kubernetes: ["secret_suffix"], consul: ["path"], http: ["address"] };

/**
 * Problems with backend moves as a migration file gives them, one line each,
 * headed `backends[<i>]`: a root that moves twice, a source backend chant
 * does not read, a config that does not say where the state is, a
 * credential written in the repo. None: the moves can be planned.
 */
export function backendMoveProblems(moves: readonly BackendMove[]): string[] {
  const p: string[] = [];
  const seen = new Set<string>();
  const kinds = [...MIGRATED_BACKENDS, ...PULLED_BACKENDS.filter((b) => !MIGRATED_BACKENDS.includes(b)), ...EXTERNAL_BACKENDS];
  for (const [i, b] of moves.entries()) {
    const at = `backends[${i}]`;
    if (seen.has(b.root)) p.push(`${at}: ${b.root} moves twice`);
    seen.add(b.root);
    if (!kinds.includes(b.from.backend)) {
      p.push(`${at}.from.backend must be ${kinds.join(", ")}`);
      continue;
    }
    const config = b.from.config;
    if (EXTERNAL_BACKENDS.includes(b.from.backend)) p.push(...externalProblems(at, b.from.backend, config));
    if (PULLED_BACKENDS.includes(b.from.backend)) {
      for (const k of Object.keys(config)) if (k in SECRET_KEYS) p.push(`${at}.from.config.${k}: a credential does not belong in the repo; the job gives it in ${SECRET_KEYS[k]}`);
      const conn = config.conn_str;
      if (b.from.backend === "pg" && typeof conn === "string" && (/^postgres(ql)?:\/\/[^/@]*:[^/@]*@/i.test(conn) || /(^|\s)password\s*=/.test(conn))) p.push(`${at}.from.config.conn_str holds a password, which does not belong in the repo; the job gives it in PGPASSWORD`);
    }
    const needs = FROM_NEEDS[b.from.backend];
    if (needs && needs.some((k) => typeof config[k] !== "string")) p.push(`${at}.from.config must name the ${needs.join(", ").replace(/, ([^,]*)$/, " and $1")} of the state`);
  }
  return p;
}

/** An HCL value from the JSON of a backend's configuration. */
function hcl(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v)) return `{ ${Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => `${k} = ${hcl(x)}`).join(", ")} }`;
  if (Array.isArray(v)) return `[${v.map(hcl).join(", ")}]`;
  return JSON.stringify(v);
}

/** A terraform block whose backend is `type` with `config`, for an override file. */
export function backendBlock(type: string, config: Record<string, unknown>): string {
  const body = Object.entries(config).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `    ${k} = ${hcl(v)}\n`).join("");
  return `terraform {\n  backend ${JSON.stringify(type)} {\n${body}  }\n}\n`;
}

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
  /** States moved to the backend each root's code names now (#4806). */
  backends?: BackendMove[];
  /** Every root the moves, restores or backend moves name. */
  roots: MigrationRootRun[];
  /** What a `file` source's relative path is read from. Default the working directory. */
  repo?: string;
  /** The work dir: new states, plans and data dirs. The caller removes it. */
  work: string;
  exec?: BinaryExec;
  fetch?: StoreFetch;
  /** What the migration's lock says. */
  lock?: LockOperation;
  /** What the lock of a workspace a backend move reads from says. Default the migration's operation, reading. */
  sourceLock?: LockOperation;
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

/** Where a backend move's state is now: a backend read through the root with an override file, or a source read without the binary. */
type Source = { object: MigratedState; block: string; data: string } | { external: ExternalSource };

interface Planned {
  run: MigrationRootRun & { env: NodeJS.ProcessEnv };
  object: MigratedState;
  file: string;
  gained: number;
  source?: Source;
  /** The state the root's backend holds is the empty one it wrote at init: the push is forced over it. */
  replacesEmpty?: boolean;
}

/** A root's version id now, when its store keeps versions. `pin` lets an azurerm blob with snapshots only take one to name it. */
async function versionNow(o: MigratedState, fetchFn: StoreFetch | undefined, pin: boolean): Promise<string | undefined> {
  if (isPulledState(o)) return undefined;
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
  const kinds = [input.moves?.length && "moves", input.restores?.length && "restores", input.backends?.length && "backends"].filter(Boolean);
  if (kinds.length !== 1) throw new MigrationError(`migration ${input.name}: give it moves, restores or backends, one of the three`);
  if (input.backends) {
    const problems = backendMoveProblems(input.backends);
    if (problems.length > 0) throw new MigrationError(`migration ${input.name}:\n  ${problems.join("\n  ")}`);
  }
  mkdirSync(input.work, { recursive: true });
  const named = [...new Set(input.moves ? input.moves.flatMap((m) => [m.from, m.to]) : input.restores ? input.restores.map((r) => r.root) : input.backends!.map((b) => b.root))].sort();
  const byName = new Map(input.roots.map((r) => [r.root, r]));
  const missing = named.filter((n) => !byName.has(n));
  if (missing.length > 0) throw new MigrationError(`migration ${input.name}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not among its roots`);

  const runs = new Map<string, Planned["run"]>();
  const objects = new Map<string, MigratedState>();
  const versions = new Map<string, string | undefined>();
  const before = new Map<string, StateFile | null>();
  for (const [i, name] of named.entries()) {
    const r = byName.get(name)!;
    let env = r.env ?? process.env;
    if (r.init !== false) {
      env = { ...env, TF_DATA_DIR: join(input.work, `data-${i}`) };
      await initRoot({ ...r, env, exec, reconfigure: true });
    }
    const found = stateObject(r.dir, env, undefined, r.binary);
    const recorded = initialisedBackend(r.dir, env);
    const o: MigratedState | undefined = !isRefused(found) ? found : found.refused === "backend" && recorded ? pulledState(recorded, env) : undefined;
    if (!o) throw new MigrationError(`migration ${input.name} cannot run: ${name}: ${(found as { reason: string }).reason}`);
    runs.set(name, { ...r, env });
    objects.set(name, o);
    versions.set(name, await versionNow(o, input.fetch, false));
    before.set(name, await pullState(exec, r.binary, name, r.dir, env));
  }

  const after = new Map<string, StateFile>();
  const sources = new Map<string, { source: Source; at: MigrationSource }>();
  const replaces = new Set<string>();
  if (input.moves) {
    for (const [root, s] of moveResources(input.name, input.moves, before)) after.set(root, s);
  } else if (input.backends) {
    for (const [i, b] of input.backends.entries()) {
      const run = runs.get(b.root)!;
      const target = objects.get(b.root)!;
      const source = sourceOf(input, b, run, target, i);
      // A backend that writes an empty state of its own lineage at init (kubernetes) has it replaced; the digest binds that it was empty.
      const held = before.get(b.root);
      if (held && isPulledState(target) && isEmptyState(held)) replaces.add(b.root);
      else if (held) throw new MigrationError(`migration ${input.name}: the backend ${b.root}'s code names, ${migratedLocation(target) ?? target.backend}, already holds a state, so a move would overwrite it`);
      const read = await readSource(source, run, exec, input.fetch, override);
      const where = "external" in source ? source.external.location : (migratedLocation(source.object) ?? b.from.backend);
      if (!read.state) throw new MigrationError(`migration ${input.name}: ${where} holds no state of ${b.root} to move`);
      sources.set(b.root, { source, at: { ...(where ? { location: where } : {}), ...(read.version ? { version_id: read.version } : {}), digest: stateDigest(read.state) } });
      after.set(b.root, read.state);
    }
  } else {
    for (const r of input.restores!) {
      const o = objects.get(r.root)!;
      const location = migratedLocation(o);
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
      if (isPulledState(o)) throw new MigrationError(`migration ${input.name}: ${r.root}'s ${o.backend} backend keeps no versions to put back`);
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
    const src = sources.get(name);
    planned.set(name, { run, object: objects.get(name)!, file, gained: state.resources.length - (before.get(name)?.resources.length ?? 0), ...(src ? { source: src.source } : {}), ...(replaces.has(name) ? { replacesEmpty: true } : {}) });
    const proof = await proofPlan(run, exec, file, join(input.work, `proof-${i}`), override);
    log(`${name}: ${proof.changes.length === 0 ? "no changes against its new state" : `${proof.changes.length} change${proof.changes.length === 1 ? "" : "s"} against its new state: ${proof.changes.join(", ")}`}`);
    const was = before.get(name) ?? null;
    const v = versions.get(name);
    const location = migratedLocation(objects.get(name)!);
    roots.push({ root: name, ...(location ? { location } : {}), before: { ...(v ? { version_id: v } : {}), digest: was ? stateDigest(was) : null }, after: { digest: stateDigest(state) }, proof, ...(src ? { source: src.at } : {}) });
  }
  return { roots, engine: migrationEngine(planned, input, exec, lockOp) };
}

/**
 * Where a backend move reads its state from: an external source (a TFE-API
 * workspace, a state file), or the backend `from` names, read through the
 * root. Throws MigrationError for a backend chant does not read, an s3
 * backend that takes no lock file, and a source the root's code names
 * already.
 */
function sourceOf(input: TerraformMigrationInput, b: BackendMove, run: Planned["run"], target: MigratedState, i: number): Source {
  const external = externalSource(input.repo ?? process.cwd(), b.from.backend, b.from.config, run.env, input.fetch);
  if (external) return { external };
  const from = { type: b.from.backend, config: b.from.config };
  const pulled = pulledState(from, run.env);
  let object: MigratedState;
  if (pulled) object = pulled;
  else {
    const o = readableStateObject(run.dir, run.env, from);
    if (isRefused(o)) throw new MigrationError(`migration ${input.name} cannot run: the backend ${b.root} moves from: ${o.reason}`);
    if (o.backend === "s3" && !o.lockfile) throw new MigrationError(`migration ${input.name} cannot run: the backend ${b.root} moves from: its s3 backend takes no lock file (use_lockfile = true), so a migration could not hold its lock`);
    object = o;
  }
  const at = migratedLocation(object);
  if (at !== undefined && at === migratedLocation(target)) throw new MigrationError(`migration ${input.name}: ${b.root}'s code names the backend it moves from, ${at}; change the backend block in the same change`);
  return { object, block: backendBlock(b.from.backend, b.from.config), data: join(input.work, `source-${i}`) };
}

/** A source's state and version id now: an external source read directly, a backend through the root with an override file naming it, in its own data dir. */
async function readSource(s: Source, run: Planned["run"], exec: BinaryExec, fetchFn: StoreFetch | undefined, override: string): Promise<{ state: StateFile | null; version?: string }> {
  if ("external" in s) {
    const got = await s.external.read();
    if (!got) return { state: null };
    let state: StateFile;
    try {
      state = JSON.parse(got.text) as StateFile;
    } catch {
      throw new MigrationError(`${s.external.location} holds something that is not a state`);
    }
    if (!Array.isArray(state.resources)) state.resources = [];
    return { state, ...(got.version ? { version: got.version } : {}) };
  }
  const at = join(run.dir, override);
  const env = { ...run.env, TF_DATA_DIR: s.data };
  writeFileSync(at, s.block);
  let state: StateFile | null;
  try {
    await initRoot({ ...run, env, exec, reconfigure: true });
    state = await pullState(exec, run.binary, run.root, run.dir, env);
  } finally {
    rmSync(at, { force: true });
  }
  const version = await versionNow(s.object, fetchFn, false);
  return { state, ...(version ? { version } : {}) };
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

const stored = (o: MigratedState): o is Exclude<LockableState, { backend: "local" }> & StateObject => !isPulledState(o) && isStored(o);

function migrationEngine(planned: Map<string, Planned>, input: TerraformMigrationInput, exec: BinaryExec, lockOp: LockOperation): StateMigrationEngine {
  const log = input.log ?? (() => {});
  const override = input.overrideFile ?? DEFAULT_OVERRIDE_FILE;
  const stores = new Map<string, StateStore>();
  for (const [root, p] of planned) if (stored(p.object)) stores.set(root, stateStore(p.object, p.run.dir, input.fetch));
  // A backend move holds the lock of the state it reads too, after the states it writes, and a source workspace's lock before any.
  const sourceStores: { root: string; store: StateStore }[] = [];
  const sourceLocks: SourceLock[] = [];
  for (const [root, p] of planned) {
    if (!p.source) continue;
    if ("external" in p.source) {
      const ext = p.source.external;
      if (ext.lock) sourceLocks.push({ root, location: ext.location, lock: (reason) => ext.lock!(reason) });
    } else if (stored(p.source.object)) sourceStores.push({ root, store: stateStore(p.source.object, p.run.dir, input.fetch) });
  }
  const pinned = new Map<string, string>();
  return {
    async lock() {
      let got: Awaited<ReturnType<typeof takeLocksWithSources>>;
      try {
        got = await takeLocksWithSources({
          sources: sourceLocks,
          stores: [...[...stores].map(([root, store]) => ({ root, store })), ...sourceStores],
          now: new Date().toISOString(),
          op: lockOp,
          sourceOp: input.sourceLock ?? { operation: lockOp.operation, info: "a state migration is reading this state" },
          who: input.who ?? `chant@${hostname()}`,
        });
      } catch (e) {
        if (e instanceof SourceLockedError) throw new MigrationError(`${e.root}: ${e.reason}`);
        if (e instanceof StateLockedError) {
          const h = e.holder;
          const by = h ? [h.who && `by ${h.who}`, h.operation, h.info, h.created && `since ${h.created}`].filter(Boolean).join(", ") : "";
          throw new MigrationError(`${e.root}: its state is locked (${e.lockLocation}${by ? `: ${by}` : ""}), so nothing was written`);
        }
        throw e;
      }
      return async () => {
        for (const l of got.locks.reverse()) await l.release().catch((e: unknown) => log(`${l.root}: the lock could not be released: ${(e as Error).message}`));
        for (const l of got.sources.reverse()) await l.release().catch((e: unknown) => log(`${l.root}: the lock of ${l.location} could not be released: ${(e as Error).message}`));
      };
    },
    async source(root): Promise<MigrationStateAt> {
      const p = planned.get(root)!;
      if (!p.source) return { digest: null };
      const read = await readSource(p.source, p.run, exec, input.fetch, override);
      return { ...(read.version ? { version_id: read.version } : {}), digest: read.state ? stateDigest(read.state) : null };
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
        // Over the empty state a backend wrote at init, of another lineage, the push is forced; under the locks its digest was found still empty.
        if (store?.write) await store.write(readFileSync(p.file, "utf-8"));
        else await pushStateFile({ ...p.run, exec, file: p.file, ...(store ? { lock: false } : p.replacesEmpty ? { force: true } : {}) });
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
