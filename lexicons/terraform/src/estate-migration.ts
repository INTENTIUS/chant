/**
 * Migrations into and between choudoufu estates (#4806), for chant core's
 * gated migration (`@intentius/chant/state-migration`). A root whose
 * `terraform` block holds a `live` block keeps no state file, so `state
 * pull` and `state push` have nothing to read or write. Ownership is a
 * marker on each live resource (the `tofu-estate` and `tofu-address` tags,
 * `./live-ownership.ts`), so:
 *
 *   moves     between two estates is a retag: `choudoufu live-mv
 *             -from-estate` rewrites the markers of each resource, run in
 *             the root it moves to
 *   backends  from an s3 or local state into an estate is an adoption:
 *             `choudoufu live-import` reads the old state once and stamps
 *             the markers on every resource it verifies; the old state is
 *             left where it was. When the state is the one the root's own
 *             backend block names and the binary's live-import reads that
 *             backend itself, no state is read here: live-import gets no
 *             `-state`, and the proof binds its ratification and the
 *             state's version id
 *
 * The proof is read-only.
 *
 *   moves     `live-mv -dry-run -json` of each retag, run in the root the
 *             resource joins: each one must find the live resource in the
 *             estate it leaves, and a refusal stops the migration. A root
 *             that resources join is not planned first (until the retag
 *             its resources carry another estate's markers, and choudoufu
 *             refuses to plan it). A root they only leave is planned, which
 *             names the instances that leave (its destroys), and every
 *             change it plans must be one of those destroys. The digest
 *             covers the planned changes of each planned root and the live
 *             id of each resource.
 *   backends  `live-import` without `-approve`: its ratification of every
 *             resource instance the old state holds. The root is not
 *             planned first, since choudoufu refuses to plan a root with an
 *             unmarked live object at a resource's identity. Each instance
 *             that does not verify (or is not outside the taggable subset)
 *             is a change of the proof. The root's `source` binds the old
 *             state's location, version and digest; under the lock of that
 *             state the engine reads it again.
 *
 * After the write every root plans and must show no change, which for an
 * adoption is the first plan its root makes. A retag takes no lock: the
 * markers are on the live resources, which no state lock covers.
 *
 * The product resolves each root's estate (choudoufu's `live-check`) and
 * passes it with the root, and keeps its own report of the write: each
 * `-progress-json` line of a write goes to `progress`, and each root's plan
 * after the write to `verified`.
 *
 * Lifted from terragucci's `migrate-estate.ts` (`planEstateMigration`,
 * `planRetag`, `planAdopt`, `planAdoptFromBackend`, `readsOwnBackend`,
 * `liveImportReadsBackend`, `readSource`, `applyEstateMigration`,
 * `writeEstate`, `liveMv`, `writeRetag`, `liveImport`, `parseRatification`,
 * `stampFailures`) and `takesProgressJson` of its `migrate-progress.ts`, so
 * terragucci deletes them.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { mapLimited } from "@intentius/chant/parallelism";
import type { MigrationCheck, MigrationRootPlan, MigrationStateAt, StateMigrationEngine } from "@intentius/chant/state-migration";
import { DEFAULT_MIGRATE_LOCK, MigrationError, resourceChanges, stateDigest, type BackendMove, type Move } from "./state-migration";
import { planStateCheck, type RootRun } from "./state-ops";
import { declaredBackend, isRefused, isStored, readableStateObject, stateLocation, type LockableState } from "./state/backend";
import { lastLines, runBinary, type BinaryExec, type BinaryIo, type StateFile } from "./state/exec";
import { StateLockedError, takeLocks, type LockOperation } from "./state/locks";
import type { StoreFetch } from "./state/object-store";
import { S3Client } from "./state/s3";
import { stateStore } from "./state/store";
import { stateVersionSource } from "./state/versions";

/** One resource instance a retag moves: its address in both roots, the estates, and the live resource the markers are on. */
export interface Retag {
  address: string;
  from: string;
  to: string;
  from_estate: string;
  to_estate: string;
  live_id: string;
  /** Instances whose identity composes from this one and follow it with no write of their own. */
  followers: string[];
}

/** One resource instance of an adopted state, as `live-import` verified it. */
export interface Stamp {
  root: string;
  estate: string;
  address: string;
  type: string;
  status: string;
  live_id?: string;
}

/**
 * How many roots of an estate migration plan at once, and how many roots
 * take their live-mv dry runs at once. Each root's dry runs go one at a
 * time in its own directory, and every result keeps its place in the order
 * the roots and addresses were given.
 */
export const ESTATE_PARALLELISM = 4;

/** The flag that makes choudoufu's `live-mv` and `live-import` write a JSON line per resource to stderr as each write lands. */
export const PROGRESS_FLAG = "-progress-json";

/** Whether the binary is choudoufu: the one that reads and writes ownership markers. */
export const isEstateBinary = (binary: string): boolean => /(^|\/)choudoufu[^/]*$/.test(binary);

/** One estate root a migration names. */
export interface EstateRootRun extends Omit<RootRun, "exec"> {
  /** The estate choudoufu resolves for the root (its `live-check`, else the live block's own). */
  estate: string;
  /** Run `init` first (default), in `initEnv` when given; false for a root another tool initialised. choudoufu refuses `-reconfigure` under a live block, so none is passed. */
  init?: boolean;
  initEnv?: NodeJS.ProcessEnv;
}

export interface EstateMigrationInput {
  /** The migration's name: what its gate is called. */
  name: string;
  /** Resources retagged from one estate to another. */
  moves?: Move[];
  /** States adopted into the estate each root's live block names. */
  backends?: BackendMove[];
  /** Every root the moves or adoptions name. */
  roots: EstateRootRun[];
  /** Where an adoption's copy of the old state and the plans are kept. The caller removes it. */
  work: string;
  exec?: BinaryExec;
  fetch?: StoreFetch;
  /** What the lock of an adopted state says. */
  lock?: LockOperation;
  who?: string;
  log?: (line: string) => void;
  /** Each `-progress-json` line of a write, when the binary takes the flag; answers whether it took the line, which then stays out of the run's output. */
  progress?: (line: string) => boolean;
  /** Each root's plan JSON after the write: the estate as it stands. */
  verified?: (root: string, plan: unknown) => void;
}

/** A planned estate migration: each root's plan for core, the engine that writes it, and what it writes. */
export interface EstateMigrationPlan {
  change: "retag" | "adopt";
  roots: MigrationRootPlan[];
  engine: StateMigrationEngine;
  /** A retag: each resource instance that changes estate, and the live resource its markers are on. */
  retags: Retag[];
  /** An adoption: each resource instance of the old state, as the live system verified it. */
  stamps: Stamp[];
  /** How many resources the write touches: each address once, a follower of two leaders too. */
  resources: number;
}

const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

type Run = EstateRootRun & { env: NodeJS.ProcessEnv };

/** Run the binary in a root, in its environment, and answer what it printed. */
async function inRoot(exec: BinaryExec, r: Run, args: string[], io?: BinaryIo) {
  return exec(r.binary, args, r.dir, r.env, ...(io ? [io] : []));
}

const helpBy = new WeakMap<BinaryExec, Map<string, Promise<string>>>();

/** A subcommand's `-help`, read once per binary. */
function helpOf(exec: BinaryExec, r: Run, sub: string): Promise<string> {
  let byBinary = helpBy.get(exec);
  if (!byBinary) helpBy.set(exec, (byBinary = new Map()));
  const k = `${r.binary}\u0000${sub}`;
  let got = byBinary.get(k);
  if (!got) {
    got = inRoot(exec, r, [sub, "-help"]).then(
      (x) => x.out,
      () => "",
    );
    byBinary.set(k, got);
  }
  return got;
}

/** Whether the binary's writes take `-progress-json`, from `live-mv -help`. */
export async function takesProgressJson(exec: BinaryExec, r: Pick<Run, "binary" | "dir" | "env" | "root" | "estate">): Promise<boolean> {
  return new RegExp(`(^|\\s)${PROGRESS_FLAG}(\\s|=|$)`, "m").test(await helpOf(exec, r as Run, "live-mv"));
}

/** live-import's help line for `-state` when the command reads the backend block's state with no `-state`. */
const READS_BACKEND = /Defaults to the state the backend\s+block names/;

/** `<address>: <actions>` split back into its parts. */
const parseChange = (c: string): { address: string; actions: string } => {
  const i = c.lastIndexOf(": ");
  return { address: c.slice(0, i), actions: c.slice(i + 2) };
};

/** The instances of a resource address among a plan's changes: the address itself, or it with an instance key. */
const instancesOf = (address: string, changes: string[], actions: string): string[] =>
  changes
    .map(parseChange)
    .filter((c) => c.actions === actions && (c.address === address || c.address.startsWith(`${address}[`)))
    .map((c) => c.address)
    .sort();

// ── live-mv ──────────────────────────────────────────────────────────────

/** What `live-mv -json` prints: the parts a retag reads. */
interface MoveDoc {
  resource?: { live_id?: string };
  followers?: { address?: string }[];
  written?: boolean;
  refusal?: { code?: string; summary?: string; detail?: string } | null;
}

/** `live-mv -json -from-estate` for one instance in the root it moves to; a dry run writes nothing. */
async function liveMv(exec: BinaryExec, r: Run, fromEstate: string, address: string, dry: boolean, io?: BinaryIo): Promise<MoveDoc> {
  const ran = await inRoot(exec, r, ["live-mv", "-no-color", "-json", ...(dry ? ["-dry-run"] : []), ...(io ? [PROGRESS_FLAG] : []), `-from-estate=${fromEstate}`, address, address], io);
  let doc: MoveDoc | undefined;
  try {
    doc = JSON.parse(ran.stdout) as MoveDoc;
  } catch {
    doc = undefined;
  }
  const refused = doc?.refusal ? [doc.refusal.summary, doc.refusal.detail].filter(Boolean).join(": ") : undefined;
  if (ran.code !== 0 || !doc || refused) throw new MigrationError(`live-mv ${dry ? "-dry-run " : ""}refuses ${address}: ${refused ?? lastLines(ran.out)}`);
  return doc;
}

// ── live-import ──────────────────────────────────────────────────────────

/** `live-import`'s ratification report: one entry per resource instance, by status. */
export function parseRatification(text: string): { address: string; type: string; status: string; live_id?: string }[] {
  const out: { address: string; type: string; status: string; live_id?: string }[] = [];
  let status: string | undefined;
  for (const line of text.split("\n")) {
    const head = /^([A-Z_]+) \(\d+\) - /.exec(line);
    if (head) {
      status = ["VERIFIED", "DRIFTED", "MISSING", "UNTAGGABLE", "UNADMITTED_TYPE"].includes(head[1]!) ? head[1] : undefined;
      continue;
    }
    if (!line.trim()) continue;
    const row = /^ {2}(\S+)\s+(\S+)\s+live id: (\S+)\s*$/.exec(line);
    if (status && row) out.push({ address: row[1]!, type: row[2]!, status, ...(row[3] !== "-" ? { live_id: row[3]! } : {}) });
    if (/eligible for stamping/.test(line)) status = undefined;
  }
  return out;
}

/** Statuses a stamp makes plan with no change: verified and stamped, or outside the taggable subset and composed from a stamped parent. */
const ADOPTED = ["VERIFIED", "UNTAGGABLE"];

/** `live-import -approve`'s last count line: how many failed. */
export function stampFailures(text: string): number | undefined {
  const m = /(\d+) failed, \d+ skipped\./.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** live-import in a root: of the state file `state`, or with none, of the state the root's backend block names. `-approve` with `write`. */
async function liveImport(exec: BinaryExec, r: Run, state: string | undefined, write: boolean, io?: BinaryIo): Promise<string> {
  const ran = await inRoot(exec, r, ["live-import", "-no-color", ...(state ? [`-state=${resolve(state)}`] : []), `-estate=${r.estate}`, ...(write ? ["-approve"] : []), ...(io ? [PROGRESS_FLAG] : [])], io);
  if (ran.code !== 0) throw new MigrationError(`live-import ${write ? "could not stamp" : "could not verify"} ${state ? state.replace(/^.*\//, "") : "the state its backend block names"}: ${lastLines(ran.out)}`);
  return ran.stdout;
}

const ratificationSummary = (entries: { status: string }[]): string => {
  const verified = entries.filter((e) => ADOPTED.includes(e.status)).length;
  return `live-import: ${verified} of ${entries.length} resource instance${entries.length === 1 ? "" : "s"} verified`;
};

/** The digest an adoption read from the backend binds: the ratification's entries, each with its live id, and the state's version id. */
const ratificationDigest = (entries: ReturnType<typeof parseRatification>, version?: string): string => sha(JSON.stringify({ entries, ...(version ? { version } : {}) }));

/** An adopted state's version id now, when its store keeps versions. */
async function versionOf(o: LockableState, fetchFn: StoreFetch | undefined): Promise<string | undefined> {
  if (o.backend === "local") return undefined;
  const src = stateVersionSource(o, fetchFn, { pin: false });
  if ("refused" in src) return undefined;
  return (await src.current()).versionId;
}

/** An adopted state now: its text, parsed, and its version id when the bucket keeps versions. s3 and local are read; another backend holds none here. */
async function readAdopted(o: LockableState, dir: string, fetchFn: StoreFetch | undefined): Promise<{ text: string; state: StateFile; version?: string } | undefined> {
  let text: string | undefined;
  let version: string | undefined;
  if (o.backend === "s3") {
    version = await versionOf(o, fetchFn);
    const client = new S3Client(o.target, fetchFn);
    text = version ? await client.readVersion(o.key, version) : await client.get(o.key);
  } else if (o.backend === "local") {
    try {
      text = readFileSync(resolve(dir, o.path), "utf-8");
    } catch {
      text = undefined;
    }
  }
  if (!text?.trim()) return undefined;
  let state: StateFile;
  try {
    state = JSON.parse(text) as StateFile;
  } catch {
    throw new MigrationError(`${stateLocation(o)} is not a state`);
  }
  if (!Array.isArray(state.resources)) state.resources = [];
  return { text, state, ...(version ? { version } : {}) };
}

// ── planning ─────────────────────────────────────────────────────────────

interface Adopt {
  root: string;
  /** The copy of the old state handed to live-import as `-state`; absent when live-import reads the root's backend itself. */
  state?: string;
  source: LockableState;
}

/**
 * Plan a migration whose roots are choudoufu estates: a retag for `moves`,
 * an adoption for `backends`. Throws MigrationError for a binary that is not
 * choudoufu, a retag a dry run refuses, and a state that cannot be adopted.
 */
export async function planEstateMigration(input: EstateMigrationInput): Promise<EstateMigrationPlan> {
  const exec = input.exec ?? runBinary;
  const log = input.log ?? (() => {});
  if (!!input.moves?.length === !!input.backends?.length) throw new MigrationError(`migration ${input.name}: give it moves or backends, one of the two`);
  const byName = new Map(input.roots.map((r) => [r.root, { ...r, env: r.env ?? process.env }] as const));
  const named = [...new Set(input.moves ? input.moves.flatMap((x) => [x.from, x.to]) : input.backends!.map((b) => b.root))].sort();
  const missing = named.filter((n) => !byName.has(n));
  if (missing.length > 0) throw new MigrationError(`migration ${input.name}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not among its roots`);
  const runs = new Map(named.map((n) => [n, byName.get(n)!] as const));
  for (const r of runs.values()) {
    if (!isEstateBinary(r.binary)) throw new MigrationError(`migration ${input.name} cannot run: its roots keep their resources under live markers, which only choudoufu reads, and ${r.root} runs ${r.binary}`);
    if (r.init === false) continue;
    const init = await exec(r.binary, ["init", "-input=false", "-no-color"], r.dir, r.initEnv ?? r.env);
    if (init.code !== 0) throw new MigrationError(`init in ${r.root} failed: ${lastLines(init.out)}`);
  }
  const plan = (r: Run, tag: string): Promise<{ check: MigrationCheck; json: unknown }> =>
    planStateCheck({ ...r, exec, planFile: join(input.work, `${tag}.tfplan`) }).then((read) => ({ check: { changes: resourceChanges(read.json), summary: read.summary }, json: read.json }));

  if (input.backends) return planAdopt(input, runs, exec, log, plan);

  // A root resources join is not planned before the retag: their live objects carry another estate's markers until then.
  const joining = new Set(input.moves!.map((x) => x.to));
  const planned = named.filter((r) => !joining.has(r));
  const got = await mapLimited(planned, ESTATE_PARALLELISM, (root) => plan(runs.get(root)!, `estate-${named.indexOf(root)}`));
  const plans = new Map(planned.map((r, i) => [r, got[i]!.check] as const));

  type Slot = { problem: string } | { mv: Move; inst: string; fromEstate: string; toEstate: string; result?: { doc: MoveDoc } | { problem: string } };
  const slots: Slot[] = [];
  for (const mv of input.moves!) {
    const fromEstate = runs.get(mv.from)!.estate;
    const toEstate = runs.get(mv.to)!.estate;
    if (fromEstate === toEstate) {
      slots.push({ problem: `${mv.from} and ${mv.to} are both estate ${fromEstate}; a move inside one estate is a moved block` });
      continue;
    }
    for (const address of mv.addresses) {
      if (/(^|\.)module\.[A-Za-z_][\w-]*$/.test(address)) {
        slots.push({ problem: `${address} is a module call; a retag names each resource in it` });
        continue;
      }
      // A root that is not planned (it takes resources too) names no instances: the address moves as the file names it.
      const source = plans.get(mv.from);
      const instances = source ? instancesOf(address, source.changes, "delete") : [address];
      if (instances.length === 0) {
        slots.push({ problem: `${address}: the plan of ${mv.from} does not destroy it, so estate ${fromEstate} holds no live resource it leaves` });
        continue;
      }
      for (const inst of instances) slots.push({ mv, inst, fromEstate, toEstate });
    }
  }
  const runsOf = slots.filter((x): x is Extract<Slot, { inst: string }> => "inst" in x);
  const byRoot = new Map<string, typeof runsOf>();
  for (const r of runsOf) byRoot.set(r.mv.to, [...(byRoot.get(r.mv.to) ?? []), r]);
  await mapLimited([...byRoot.entries()], ESTATE_PARALLELISM, async ([to, theirs]) => {
    for (const r of theirs) {
      try {
        r.result = { doc: await liveMv(exec, runs.get(to)!, r.fromEstate, r.inst, true) };
      } catch (e) {
        r.result = { problem: (e as Error).message };
      }
    }
  });
  const problems: string[] = [];
  const retags: Retag[] = [];
  for (const x of slots) {
    if ("problem" in x) {
      problems.push(x.problem);
      continue;
    }
    const result = x.result!;
    if ("problem" in result) {
      problems.push(result.problem);
      continue;
    }
    if (!result.doc.resource?.live_id) {
      problems.push(`live-mv -dry-run names no live resource for ${x.inst}`);
      continue;
    }
    const followers = (result.doc.followers ?? []).map((f) => f.address).filter((a): a is string => typeof a === "string").sort();
    retags.push({ address: x.inst, from: x.mv.from, to: x.mv.to, from_estate: x.fromEstate, to_estate: x.toEstate, live_id: result.doc.resource.live_id, followers });
    log(`${x.inst}: ${result.doc.resource.live_id} moves from estate ${x.fromEstate} to estate ${x.toEstate}${followers.length ? `, with ${followers.join(", ")}` : ""}`);
  }
  if (problems.length > 0) throw new MigrationError(`migration ${input.name}:\n  ${problems.join("\n  ")}`);
  const roots: MigrationRootPlan[] = [];
  for (const root of named) {
    const estate = runs.get(root)!.estate;
    const leaving = retags.filter((t) => t.from === root);
    const joins = retags.filter((t) => t.to === root);
    const accounted = new Set(leaving.flatMap((t) => [t.address, ...t.followers].map((a) => `${a}: delete`)));
    const p = plans.get(root);
    const ids = (ts: Retag[]) => ts.map((t) => ({ address: t.address, live_id: t.live_id, followers: t.followers }));
    roots.push({
      root,
      location: `estate ${estate}`,
      before: { digest: sha(JSON.stringify({ estate, ...(p ? { changes: [...p.changes].sort() } : {}), leaving: ids(leaving), joining: ids(joins) })) },
      after: { digest: sha(JSON.stringify({ estate, changes: [] })) },
      // A joining root has no plan before the retag: its dry runs are its proof, and each one that refused stopped the migration above.
      proof: p ? { changes: p.changes.filter((c) => !accounted.has(c)), summary: p.summary } : { changes: [], summary: `live-mv -dry-run: ${joins.length === 1 ? "1 resource found in the estate it leaves" : `${joins.length} resources found in the estates they leave`}` },
    });
  }
  const resources = new Set(retags.flatMap((t) => [t.address, ...t.followers])).size;
  return { change: "retag", roots, retags, stamps: [], resources, engine: estateEngine(input, runs, exec, plan, roots, { retags, adopts: [] }) };
}

async function planAdopt(input: EstateMigrationInput, runs: Map<string, Run>, exec: BinaryExec, log: (line: string) => void, plan: (r: Run, tag: string) => Promise<{ check: MigrationCheck; json: unknown }>): Promise<EstateMigrationPlan> {
  const roots: MigrationRootPlan[] = [];
  const stamps: Stamp[] = [];
  const adopts: Adopt[] = [];
  for (const [i, b] of input.backends!.entries()) {
    const r = runs.get(b.root)!;
    const o = readableStateObject(r.dir, r.env, { type: b.from.backend, config: b.from.config });
    if (isRefused(o)) throw new MigrationError(`migration ${input.name} cannot run: the backend ${b.root} adopts from: ${o.reason}`);
    if (o.backend === "s3" && !o.lockfile) throw new MigrationError(`migration ${input.name} cannot run: the backend ${b.root} adopts from: its s3 backend takes no lock file (use_lockfile = true), so a migration could not hold its lock`);
    if (o.backend !== "s3" && o.backend !== "local") throw new MigrationError(`migration ${input.name} cannot run: the backend ${b.root} adopts from is ${o.backend}; an adoption reads s3 and local states`);
    const location = stateLocation(o)!;
    let entries: ReturnType<typeof parseRatification>;
    let source: { version_id?: string; digest: string };
    if (await readsOwnBackend(o, r, exec)) {
      const version = await versionOf(o, input.fetch).catch(() => undefined);
      entries = parseRatification(await liveImport(exec, r, undefined, false));
      source = { ...(version ? { version_id: version } : {}), digest: ratificationDigest(entries, version) };
      adopts.push({ root: b.root, source: o });
      log(`${b.root}: live-import read ${location} through the root's backend block`);
    } else {
      const read = await readAdopted(o, r.dir, input.fetch);
      if (!read) throw new MigrationError(`migration ${input.name}: ${location} holds no state of ${b.root} to adopt`);
      const path = join(input.work, `adopt-${i}.tfstate`);
      writeFileSync(path, read.text);
      const report = await liveImport(exec, r, path, false);
      entries = parseRatification(report);
      if (entries.length === 0 && read.state.resources.some((x) => x.mode === "managed")) throw new MigrationError(`migration ${input.name}: live-import printed no ratification for ${b.root}: ${lastLines(report)}`);
      source = { ...(read.version ? { version_id: read.version } : {}), digest: stateDigest(read.state) };
      adopts.push({ root: b.root, state: path, source: o });
    }
    const unverified = entries.filter((e) => !ADOPTED.includes(e.status)).map((e) => `${e.address}: ${e.status.toLowerCase().replace("_", " ")}`);
    for (const e of entries) stamps.push({ root: b.root, estate: r.estate, ...e });
    roots.push({
      root: b.root,
      location: `estate ${r.estate}`,
      before: { digest: sha(JSON.stringify({ estate: r.estate, entries })) },
      after: { digest: sha(JSON.stringify({ estate: r.estate, changes: [] })) },
      source: { location, ...source },
      proof: { changes: unverified, summary: ratificationSummary(entries) },
    });
    log(`${b.root}: ${entries.length - unverified.length} of ${entries.length} resource instances in ${location} verify against the live system${unverified.length ? `; ${unverified.length} do${unverified.length === 1 ? "es" : ""} not: ${unverified.join(", ")}` : ", so the stamp adopts each one"}`);
  }
  return { change: "adopt", roots, retags: [], stamps, resources: stamps.length, engine: estateEngine(input, runs, exec, plan, roots, { retags: [], adopts }) };
}

/**
 * Whether live-import reads the adopted state itself: the migration adopts
 * from the backend the root's own backend block names (ignored under the
 * live block), and the binary's live-import reads that backend.
 */
async function readsOwnBackend(source: LockableState, r: Run, exec: BinaryExec): Promise<boolean> {
  const own = declaredBackend(r.dir, { env: r.env, binary: r.binary });
  if (!own || own.type === "cloud") return false;
  const at = readableStateObject(r.dir, r.env, own);
  if (isRefused(at) || stateLocation(at) !== stateLocation(source)) return false;
  return READS_BACKEND.test(await helpOf(exec, r, "live-import"));
}

// ── the write ────────────────────────────────────────────────────────────

function estateEngine(
  input: EstateMigrationInput,
  runs: Map<string, Run>,
  exec: BinaryExec,
  plan: (r: Run, tag: string) => Promise<{ check: MigrationCheck; json: unknown }>,
  roots: MigrationRootPlan[],
  e: { retags: Retag[]; adopts: Adopt[] },
): StateMigrationEngine {
  const log = input.log ?? (() => {});
  const planned = new Map(roots.map((r) => [r.root, r] as const));
  let afterPlans: Promise<Map<string, MigrationCheck>> | undefined;
  /** Every root's plan after the write, ESTATE_PARALLELISM at once; `verified` sees them in the roots' order. */
  const planAll = (): Promise<Map<string, MigrationCheck>> =>
    (afterPlans ??= mapLimited(roots, ESTATE_PARALLELISM, (r, i) => plan(runs.get(r.root)!, `estate-${i}-verify`)).then((got) => {
      const out = new Map<string, MigrationCheck>();
      for (const [i, r] of roots.entries()) {
        input.verified?.(r.root, got[i]!.json);
        out.set(r.root, got[i]!.check);
      }
      return out;
    }));
  const io = async (r: Run): Promise<BinaryIo | undefined> => (input.progress && (await takesProgressJson(exec, r)) ? { stderr: input.progress } : undefined);
  return {
    async lock() {
      // An adoption holds the old state's lock while it stamps; the markers of a retag are on live resources, which no state lock covers.
      const stores = e.adopts.filter((a) => isStored(a.source)).map((a) => ({ root: a.root, store: stateStore(a.source, runs.get(a.root)!.dir, input.fetch) }));
      let held: Awaited<ReturnType<typeof takeLocks>>;
      try {
        held = await takeLocks(stores, new Date().toISOString(), input.lock ?? DEFAULT_MIGRATE_LOCK, undefined, input.who ?? `chant@${hostname()}`);
      } catch (err) {
        if (err instanceof StateLockedError) throw new MigrationError(`${err.root}: the state it adopts is locked (${err.lockLocation}${err.holder?.who ? `: by ${err.holder.who}` : ""}), so nothing was written`);
        throw err;
      }
      return async () => {
        for (const l of held.reverse()) await l.release().catch((x: unknown) => log(`${l.root}: the lock could not be released: ${(x as Error).message}`));
      };
    },
    // An estate keeps no state: what the plan bound is its proof, which `source` reads again for an adoption.
    async current(root): Promise<MigrationStateAt> {
      return planned.get(root)!.before;
    },
    async source(root): Promise<MigrationStateAt> {
      const a = e.adopts.find((x) => x.root === root);
      if (!a) return { digest: null };
      const r = runs.get(root)!;
      if (a.state === undefined) {
        const version = await versionOf(a.source, input.fetch).catch(() => undefined);
        const again = parseRatification(await liveImport(exec, r, undefined, false));
        return { ...(version ? { version_id: version } : {}), digest: ratificationDigest(again, version) };
      }
      const now = await readAdopted(a.source, r.dir, input.fetch);
      return now ? { ...(now.version ? { version_id: now.version } : {}), digest: stateDigest(now.state) } : { digest: null };
    },
    async write() {
      const done: string[] = [];
      for (const t of e.retags) {
        const r = runs.get(t.to)!;
        try {
          const doc = await liveMv(exec, r, t.from_estate, t.address, false, await io(r));
          if (doc.written !== true) throw new MigrationError(`live-mv wrote nothing on ${t.address}`);
          if (doc.resource?.live_id !== t.live_id) throw new MigrationError(`live-mv rewrote ${doc.resource?.live_id ?? "an unnamed resource"} for ${t.address}, not ${t.live_id}`);
        } catch (err) {
          throw new MigrationError(`${(err as Error).message}${done.length ? `; already retagged: ${done.join(", ")}` : "; nothing was retagged"}`);
        }
        done.push(t.address);
        log(`${t.address}: retagged from estate ${t.from_estate} to estate ${t.to_estate}`);
      }
      for (const a of e.adopts) {
        const r = runs.get(a.root)!;
        const out = await liveImport(exec, r, a.state, true, await io(r));
        const failed = stampFailures(out);
        if (failed === undefined || failed > 0) throw new MigrationError(`live-import ${failed === undefined ? "printed no stamp report" : `failed to stamp ${failed} resource${failed === 1 ? "" : "s"}`} in ${a.root}: ${lastLines(out)}`);
        log(`${a.root}: stamped estate ${r.estate} on the resources of ${stateLocation(a.source)}, which is left where it was`);
      }
    },
    async verify(root) {
      return (await planAll()).get(root)!;
    },
  };
}
