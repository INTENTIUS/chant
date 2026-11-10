/**
 * The binary runs outside op waves (#4618): the state-lock release, a state
 * migration's writes and an ephemeral copy's plan and apply, as fixed
 * operations of the terraform lexicon, with the gate and the records of
 * #4551 around the ones that change state on their own.
 *
 * Each operation runs a fixed argument list. A caller names the root, the
 * binary and what the operation acts on (a lock ID, a state file, a key
 * suffix's backend settings), never extra arguments, so a product cannot
 * turn an unlock into some other command.
 *
 * - `forceUnlockState` releases one lock by its ID with `force-unlock
 *   -force`. It changes state on its own, so it runs under a gated request:
 *   `gatedStateOp` asks for the request (`requestGate`), spends the approval
 *   (`spendGatedRequest`, pushed before anything runs) and records how it
 *   ended (`finishGatedRequest`, with the product's flat facts in `detail`).
 * - `pushStateFile` writes one state file with `state push`, and
 *   `planStateCheck` plans a root against its state (`-lock=false` while the
 *   caller holds the lock itself) and reads the plan's JSON. A standalone
 *   migration's writes run under one gated request whose attachment is the
 *   proof, so the digest binds it. A migration inside a wave keeps the
 *   wave's hold hook, which chant decides already.
 * - `planCopy` initialises a root under the backend settings of its copy
 *   (`init -reconfigure -backend-config=<k>=<v>`), plans it, a destroy too,
 *   and reads the plan as a change-set part; `applyPlanFile` applies a saved
 *   plan. A copy waits at chant's `pr-env` gate, which
 *   `components/pr-env-run` decides and records (#4551 gap 4), so it takes
 *   no request of its own.
 *
 * The capabilities at the end (`terraform-state-unlock`,
 * `terraform-state-push`, `terraform-copy`) put the same operations in the
 * plugin's registry, so a step names them by kind.
 *
 * The exec is injectable (`./state/exec.ts`), and so is the gated-request
 * ledger, so a test runs no binary and writes no ledger.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, CapabilityPlan } from "@intentius/chant/components/capability";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { gatedRequestDigest, type GatedRequest, type GatedRequestRules } from "@intentius/chant/lifecycle/gated-request";
import { gatedOp } from "@intentius/chant/lifecycle/gated-op";
import { exportStateVersion, StateExportError, type StateExportInput, type StateExportOutcome } from "@intentius/chant/state-export";
import { parseLockInfo, releaseStateLock, StateUnlockError, type LockInfo, type StateLockSource, type StateUnlockInput, type StateUnlockOutcome } from "@intentius/chant/state-unlock";
import { plannerForBinary, terraformChangeSetPart } from "./change-set";
import { DEFAULT_LOCK_TIMEOUT, lockTimeoutArgs } from "./lock-timeout";
import { initialisedBackend, isGitLabState, isRefused, stateObject, type StateObject } from "./state/backend";
import { lastLines, runBinary, type BinaryExec } from "./state/exec";
import { gitlabStore, shownUrl, type GitLabFetch } from "./state/gitlab";
import type { StoreFetch } from "./state/object-store";
import { stateStore } from "./state/store";
import { gitlabVersionSource, stateVersionSource } from "./state/versions";
import { actorFromEnv } from "@intentius/chant/actor";

/** The ops the gated requests of this module wait at, one per kind, as terragucci named them. */
export const STATE_OPS = {
  unlock: "tf-unlock",
  migrate: "tf-migrate",
  export: "tf-state-export",
} as const;

/** The request kinds of #4551's design. */
export const STATE_OP_KINDS = {
  unlock: "unlock",
  migrate: "migrate",
  export: "state-export",
} as const;

/** A binary run that exited non-zero, with the tail of its output. */
export class StateOpError extends Error {
  constructor(
    readonly root: string,
    readonly command: string,
    readonly code: number,
    readonly tail: string,
  ) {
    super(`${root}: ${command} failed (exit ${code})${tail ? `:\n${tail}` : ""}`);
    this.name = "StateOpError";
  }
}

/** A gated operation stopped for a person: its request waits for an approval. The command that ran it exits 3. */
export class StateOpWaitingError extends Error {
  readonly exitCode = CHANT_EXIT.waiting;
  constructor(
    readonly op: string,
    readonly subject: string,
    readonly digest: string,
    readonly command: string,
  ) {
    super(`${op} ${subject} waits for an approval of ${digest}: ${command}`);
    this.name = "StateOpWaitingError";
  }
}

/** Where and how the binary runs for one root. */
export interface RootRun {
  /** The root's name, as messages and records name it. */
  root: string;
  binary: string;
  /** The root's directory. */
  dir: string;
  env?: NodeJS.ProcessEnv;
  exec?: BinaryExec;
}

const ran = async (r: RootRun, args: string[], label: string): Promise<{ stdout: string; out: string }> => {
  const exec = r.exec ?? runBinary;
  const done = await exec(r.binary, args, r.dir, r.env ?? process.env);
  if (done.code !== 0) throw new StateOpError(r.root, `${r.binary} ${label}`, done.code, lastLines(done.out, 10));
  return done;
};

// ── the binary runs ─────────────────────────────────────────────────────────

/** `init -input=false -no-color`, with `-reconfigure` and `-backend-config` pairs when given. */
export async function initRoot(r: RootRun & { backendConfig?: Record<string, string>; reconfigure?: boolean }): Promise<void> {
  const configs = Object.entries(r.backendConfig ?? {}).map(([k, v]) => `-backend-config=${k}=${v}`);
  await ran(r, ["init", "-input=false", "-no-color", ...(r.reconfigure || configs.length > 0 ? ["-reconfigure"] : []), ...configs], "init");
}

/**
 * Release the state lock with this ID: `force-unlock -force -no-color <id>`.
 * Run it under {@link gatedStateOp}; the binary releases whichever lock has
 * the ID, so the approval binds the ID and the lock's location.
 */
export async function forceUnlockState(r: RootRun & { id: string }): Promise<void> {
  if (!r.id || r.id.startsWith("-")) throw new Error(`${r.root}: "${r.id}" is not a lock ID`);
  await ran(r, ["force-unlock", "-force", "-no-color", r.id], `force-unlock ${r.id}`);
}

/**
 * Write a state file with `state push`. `lock: false` passes `-lock=false`,
 * for a caller that holds the state's lock itself; `force` passes `-force`,
 * for a push over an empty state of another lineage the caller checked.
 */
export async function pushStateFile(r: RootRun & { file: string; lock?: boolean; force?: boolean }): Promise<void> {
  if (r.file.startsWith("-")) throw new Error(`${r.root}: "${r.file}" is not a state file`);
  await ran(r, ["state", "push", ...(r.lock === false ? ["-lock=false"] : []), ...(r.force ? ["-force"] : []), r.file], "state push");
}

/** A plan read back: its JSON, and the binary's summary line. */
export interface PlanRead {
  planFile: string;
  json: unknown;
  summary: string;
}

async function planAndShow(r: RootRun, planArgs: string[], planFile: string): Promise<PlanRead> {
  const plan = await ran(r, ["plan", "-input=false", "-no-color", ...planArgs, `-out=${planFile}`], "plan");
  const show = await ran(r, ["show", "-json", planFile], "show -json");
  let json: unknown;
  try {
    json = JSON.parse(show.stdout);
  } catch {
    throw new StateOpError(r.root, `${r.binary} show -json`, 0, `printed no plan: ${lastLines(show.out, 10)}`);
  }
  return { planFile, json, summary: plan.out.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned" };
}

/**
 * Plan a root against its state and read the plan: the check a migration
 * makes before and after it writes. `lock: false` passes `-lock=false`, for a
 * caller that holds the lock itself.
 */
export function planStateCheck(r: RootRun & { planFile: string; lock?: boolean }): Promise<PlanRead> {
  return planAndShow(r, r.lock === false ? ["-lock=false"] : [], r.planFile);
}

/** A copy's plan: the plan read back, and its change-set part with the member's plan digest. */
export interface CopyPlanRead extends PlanRead {
  part: ChangeSetPart;
  planDigest: string;
}

/**
 * Initialise a root under its copy's backend settings and plan it, a destroy
 * with `destroy`. `backendConfig` is what makes it the copy (a state key with
 * the copy's suffix), so it is required and never empty: without it the plan
 * would be of the root's own state. Pass `init: false` for a root another
 * tool initialised (a Terragrunt unit prepared with the suffix set).
 */
export async function planCopy(
  r: RootRun & { backendConfig: Record<string, string>; planFile: string; destroy?: boolean; lockTimeout?: string | false; init?: boolean },
): Promise<CopyPlanRead> {
  if (r.init !== false) {
    if (Object.keys(r.backendConfig).length === 0) throw new Error(`${r.root}: a copy needs the backend settings of its own state`);
    await initRoot({ ...r, reconfigure: true });
  }
  const read = await planAndShow(r, [...lockTimeoutArgs("plan", r.lockTimeout ?? DEFAULT_LOCK_TIMEOUT, r.env ?? process.env), ...(r.destroy ? ["-destroy"] : [])], r.planFile);
  const part = terraformChangeSetPart({ member: r.root, plan: read.json, planner: plannerForBinary(r.binary) });
  return { ...read, part, planDigest: part.member.planDigest ?? "" };
}

/** Apply a saved plan, and nothing else: `apply -input=false -no-color <plan>`. */
export async function applyPlanFile(r: RootRun & { planFile: string; lockTimeout?: string | false }): Promise<void> {
  await ran(r, ["apply", "-input=false", "-no-color", ...lockTimeoutArgs("apply", r.lockTimeout ?? DEFAULT_LOCK_TIMEOUT, r.env ?? process.env), r.planFile], "apply");
}

// ── the gate around them ────────────────────────────────────────────────────

// The walk itself is chant core's since #4762 (`@intentius/chant/lifecycle/gated-op`), engine-neutral; these names stay for the products written against them.
export { attachmentDigest, requestedAt, type GatedRequestLedger } from "@intentius/chant/lifecycle/gated-op";
export type { GatedOpInput as GatedStateOpInput, GatedOpResult as GatedStateOpResult } from "@intentius/chant/lifecycle/gated-op";
/** Run `act` once its request is approved: chant core's {@link gatedOp}. */
export const gatedStateOp = gatedOp;

/** The digest a request binds, for a caller that prints it before it asks. */
export const stateOpDigest = (op: string, request: GatedRequest): string => gatedRequestDigest(op, request);

// ── export and release (#4762) ───────────────────────────────────────────────

/** A root's backend, read the way export and release read it. */
export interface RootBackendRun extends RootRun {
  /**
   * Run `init` in a data dir of its own (a new temp dir as `TF_DATA_DIR`,
   * removed after), so the checkout's `.terraform` is left alone. Default
   * true. Pass false for a root another tool initialised in `dir` with `env`,
   * such as a Terragrunt unit.
   */
  init?: boolean;
  /** The backend's HTTP calls, for tests. */
  fetch?: StoreFetch;
}

/**
 * Where a root's state is: init (in a data dir of its own unless `init` is
 * false), then the backend init recorded. `act` runs while the data dir is
 * there, with the env that names it, so a binary run inside it finds the
 * root initialised; the data dir is removed after.
 */
async function withBackend<T>(r: RootBackendRun, act: (object: RootStateAt, env: NodeJS.ProcessEnv) => Promise<T>, readOnly = false): Promise<T> {
  const env = r.env ?? process.env;
  if (r.init === false) return act(objectOf(r.dir, env, r.binary, readOnly), env);
  const data = mkdtempSync(join(tmpdir(), "chant-state-data-"));
  try {
    const benv = { ...env, TF_DATA_DIR: data };
    await initRoot({ ...r, env: benv });
    return await act(objectOf(r.dir, benv, r.binary, readOnly), benv);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}

/** Where a root's state is: a state object, a GitLab-managed state among them (./state/gitlab.ts, #4793). */
type RootStateAt = StateObject;

const isGitLab = isGitLabState;

/**
 * The root's state. A read needs no lock file, so an s3 backend that locks
 * with DynamoDB is read as one that takes the lock file: the refusal is
 * about holding its lock, which a read never does.
 */
function objectOf(dir: string, env: NodeJS.ProcessEnv, binary: string, readOnly: boolean): RootStateAt {
  const o = stateObject(dir, env, undefined, binary);
  if (!isRefused(o)) return o;
  const recorded = initialisedBackend(dir, env);
  if (!readOnly || o.refused !== "no-lockfile") return o;
  return stateObject(dir, env, recorded ? { ...recorded, config: { ...recorded.config, use_lockfile: true } } : undefined, binary, { backendConfig: { use_lockfile: "true" } });
}

export interface TerraformStateExportInput extends Omit<StateExportInput, "source" | "subject">, RootBackendRun {}

/**
 * chant core's state export (`exportStateVersion`) of one root: its backend
 * read by an init of its own, its versions read from the bucket or container
 * (`./state/versions.ts`). Throws `StateExportError` for a backend that keeps
 * no versions chant reads.
 */
export async function terraformStateExport(input: TerraformStateExportInput): Promise<StateExportOutcome> {
  const source = await withBackend(input, async (object) => (isGitLab(object) ? gitlabVersionSource(gitlabStore(object, input.fetch as GitLabFetch | undefined)) : stateVersionSource(object, input.fetch)), true);
  if ("refused" in source) throw new StateExportError(`${input.root}: ${source.refused}`);
  return exportStateVersion({ ...input, subject: input.root, source });
}

/** What a state lock release reads and releases. */
const RELEASES = "a lock release reads the lock of an s3 backend's lock file, a gcs backend, an azurerm backend and a GitLab-managed state";

/**
 * A root's lock as chant core's lock release reads it: the lock its store
 * holds (`StateStore.heldLock`: the s3 lock file, the gcs lock object, whose
 * generation is the ID the binary takes, the azurerm lease), released with
 * the binary's fixed `force-unlock` of that ID. A GitLab-managed state's lock
 * is read by asking for it and released by its ID on the unlock address,
 * which GitLab refuses for any other lock. A local state's lock goes with
 * the process that took it, so it is refused.
 */
export function terraformLockSource(r: RootRun & { object: RootStateAt; fetch?: StoreFetch }): StateLockSource | { refused: string } {
  const o = r.object;
  const parsed = (text: string, where: string, id?: string): LockInfo => {
    const info = parseLockInfo(text);
    if (!info) throw new StateOpError(r.root, "a lock read", 0, `${where} holds no lock ID the binary wrote; read it, and remove it by hand if it is not a lock`);
    return id ? { ...info, ID: id } : info;
  };
  if (isGitLab(o)) {
    if (!o.lockAddress || !o.unlockAddress) return { refused: `its http backend names no ${o.lockAddress ? "unlock_address (TF_HTTP_UNLOCK_ADDRESS)" : "lock_address (TF_HTTP_LOCK_ADDRESS)"}, so no lock it takes can be read and released` };
    const store = gitlabStore(o, r.fetch as GitLabFetch | undefined);
    const location = shownUrl(o.lockAddress);
    return {
      location,
      read: async () => {
        const text = await store.probeLock();
        return text === undefined ? undefined : parsed(text, location);
      },
      release: (id) => store.releaseLock(id),
    };
  }
  if (isRefused(o)) return { refused: `${o.reason}; ${RELEASES}` };
  if (o.backend === "local") return { refused: `the state is a local file, whose lock goes with the process that took it; ${RELEASES}` };
  const store = stateStore(o, r.dir, r.fetch);
  return {
    location: store.lockLocation,
    async read() {
      const held = await store.heldLock();
      return held ? parsed(held.info, store.lockLocation, held.id || undefined) : undefined;
    },
    release: (id) => forceUnlockState({ ...r, id }),
  };
}

export interface TerraformStateUnlockInput extends Omit<StateUnlockInput, "lock" | "subject">, RootBackendRun {}

/**
 * chant core's lock release (`releaseStateLock`) of one root's state: its
 * backend read by an init of its own, the lock read from the store, released
 * by `force-unlock` in the same data dir. Throws `StateUnlockError` for a
 * backend whose lock chant does not read.
 */
export async function terraformStateUnlock(input: TerraformStateUnlockInput): Promise<StateUnlockOutcome> {
  return withBackend(input, async (object, env) => {
    const lock = terraformLockSource({ ...input, env, object, ...(input.fetch ? { fetch: input.fetch } : {}) });
    if ("refused" in lock) throw new StateUnlockError(`${input.root}: ${lock.refused}`);
    return releaseStateLock({ ...input, subject: input.root, lock });
  });
}

// ── capabilities ────────────────────────────────────────────────────────────

/** The step input the gated capabilities share: the root and the request's rules. */
interface GatedRootInput {
  root: string;
  /** The project's directory, where the ledger is and roots are found. Default the process's. */
  cwd?: string;
  /** The root's directory. Default `root` under the project. */
  dir?: string;
  binary?: string;
  /** Who asks. Default the CI actor, else the user. */
  by?: string;
  /** Which approvals count. Default the ledger's. */
  approval?: GatedRequestRules["mode"];
}

/** `terraform-state-unlock`: release one lock, by ID, under a gated request. */
export interface StateUnlockStepInput extends GatedRootInput {
  id: string;
  /** Where the lock is, as the record names it: the lock file, the lock object, the lease's blob. */
  location: string;
}

/** `terraform-state-push`: write state files to their roots under one gated request whose attachment is the proof. */
export interface StatePushStepInput extends GatedRootInput {
  files: Array<{ root: string; dir?: string; file: string; lock?: boolean; force?: boolean }>;
  /** The proof the approval binds: what the push writes and why it is safe. */
  proof: string;
}

/** `terraform-copy`: plan and apply a root's copy under its own backend settings. */
export interface CopyStepInput {
  root: string;
  cwd?: string;
  dir?: string;
  binary?: string;
  backendConfig: Record<string, string>;
  destroy?: boolean;
  lockTimeout?: string | false;
}

/** Who asks when the caller names nobody: core's actor fallback (#4911). */
const actorOf = (env: NodeJS.ProcessEnv): string => actorFromEnv(env);

const dirOf = (cwd: string | undefined, input: { root: string; dir?: string }): string => input.dir ?? join(cwd ?? process.cwd(), input.root);

async function gatedRun<T>(op: string, input: GatedRootInput, kind: string, fields: Record<string, string>, act: () => Promise<{ output: T; detail?: Record<string, string | number | boolean> }>, attachment?: string): Promise<T> {
  const cwd = input.cwd ?? process.cwd();
  const result = await gatedStateOp<T>(
    { op, request: { kind, subject: input.root, by: input.by ?? actorOf(process.env), fields }, rules: { mode: input.approval ?? "ledger" }, cwd, ...(attachment !== undefined ? { attachment } : {}) },
    act,
  );
  if (result.status === "done") return result.output;
  if (result.status === "failed") throw result.error;
  if (result.status === "spent") throw new Error(`${op} ${input.root}: the request ${result.digest} applied already, and a request applies once`);
  if (result.status === "held") throw new Error(`${op} ${input.root}: ${result.reason}`);
  throw new StateOpWaitingError(op, input.root, result.digest, result.command);
}

/** The plan a gated capability answers: the request's digest is computed when it is asked, so the plan binds the step's facts alone. */
const factsPlan = (member: string, facts: Record<string, string>): CapabilityPlan => ({ member, planDigest: stateOpDigest("plan", { kind: "facts", subject: member, by: "", at: "", fields: facts }) });

export const terraformStateUnlockCapability: Capability<StateUnlockStepInput, { root: string; id: string }> = {
  kind: "terraform-state-unlock",
  rollbackPolicy: "none-by-design",
  targets: { refuse: "a lock release acts on one lock by its ID" },
  async plan(_ctx, input) {
    return factsPlan(input.root, { id: input.id, location: input.location });
  },
  async run(_ctx, input) {
    const dir = dirOf(input.cwd, input);
    const binary = input.binary ?? "terraform";
    return gatedRun(STATE_OPS.unlock, input, STATE_OP_KINDS.unlock, { location: input.location, id: input.id }, async () => {
      await initRoot({ root: input.root, binary, dir });
      await forceUnlockState({ root: input.root, binary, dir, id: input.id });
      return { output: { root: input.root, id: input.id }, detail: { lock: input.id, location: input.location } };
    });
  },
};

export const terraformStatePushCapability: Capability<StatePushStepInput, { roots: string[] }> = {
  kind: "terraform-state-push",
  rollbackPolicy: "needs-opt-out",
  targets: { refuse: "a state push writes whole states" },
  async plan(_ctx, input) {
    return factsPlan(input.root, { roots: input.files.map((f) => f.root).join(",") });
  },
  async run(_ctx, input) {
    const binary = input.binary ?? "terraform";
    return gatedRun(
      STATE_OPS.migrate,
      input,
      STATE_OP_KINDS.migrate,
      { roots: input.files.map((f) => f.root).join(",") },
      async () => {
        for (const f of input.files) await pushStateFile({ root: f.root, binary, dir: dirOf(input.cwd, f), file: f.file, ...(f.lock !== undefined ? { lock: f.lock } : {}), ...(f.force ? { force: true } : {}) });
        return { output: { roots: input.files.map((f) => f.root) }, detail: { roots: input.files.length } };
      },
      input.proof,
    );
  },
};

/** The plan file a copy's plan leaves for its run. */
interface CopyArtifact {
  planFile: string;
  planDigest: string;
}

export const terraformCopyCapability: Capability<CopyStepInput, { root: string; planDigest: string }> = {
  kind: "terraform-copy",
  rollbackPolicy: "needs-opt-out",
  targets: { refuse: "a copy plans the whole root" },
  async plan(_ctx, input) {
    const dir = dirOf(input.cwd, input);
    const planFile = join(dir, input.destroy ? ".chant-copy-destroy.tfplan" : ".chant-copy.tfplan");
    const read = await planCopy({ root: input.root, binary: input.binary ?? "terraform", dir, backendConfig: input.backendConfig, planFile, ...(input.destroy ? { destroy: true } : {}), ...(input.lockTimeout !== undefined ? { lockTimeout: input.lockTimeout } : {}) });
    const artifact: CopyArtifact = { planFile, planDigest: read.planDigest };
    return { member: input.root, planDigest: read.planDigest, artifact, changeSet: read.part };
  },
  async run(ctx, input) {
    const kept = ctx.plans?.[input.root] as CopyArtifact | undefined;
    const planned = kept && typeof kept.planFile === "string" ? kept : await terraformCopyCapability.plan!(ctx, input).then((p) => p.artifact as CopyArtifact);
    await applyPlanFile({ root: input.root, binary: input.binary ?? "terraform", dir: dirOf(input.cwd, input), planFile: planned.planFile, ...(input.lockTimeout !== undefined ? { lockTimeout: input.lockTimeout } : {}) });
    return { root: input.root, planDigest: planned.planDigest };
  },
};

/** The state operations' capabilities, for the plugin's registry. */
export const terraformStateOpCapabilities = [terraformStateUnlockCapability, terraformStatePushCapability, terraformCopyCapability] as const;
