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
import { join } from "node:path";
import type { Capability, CapabilityPlan } from "@intentius/chant/components/capability";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import {
  finishGatedRequest,
  gatedRequestDigest,
  readGatedRequests,
  requestGate,
  spendGatedRequest,
  type GatedRequest,
  type GatedRequestRules,
  type RequestGateInput,
  type RequestGateResult,
} from "@intentius/chant/lifecycle/gated-request";
import { plannerForBinary, terraformChangeSetPart } from "./change-set";
import { DEFAULT_LOCK_TIMEOUT, lockTimeoutArgs } from "./lock-timeout";
import { lastLines, runBinary, type BinaryExec } from "./state/exec";

/** The ops the gated requests of this module wait at, one per kind, as terragucci named them. */
export const STATE_OPS = {
  unlock: "tf-unlock",
  migrate: "tf-migrate",
  export: "tf-export",
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

/** The gated-request ledger, injectable for tests. Default chant's on `chant/lifecycle`. */
export interface GatedRequestLedger {
  requestGate: typeof requestGate;
  spendGatedRequest: typeof spendGatedRequest;
  finishGatedRequest: typeof finishGatedRequest;
  readGatedRequests: typeof readGatedRequests;
}

const chantLedger: GatedRequestLedger = { requestGate, spendGatedRequest, finishGatedRequest, readGatedRequests };

/**
 * The time a request was first asked, so asking again binds the same
 * digest: chant's digest covers `at`, and a run that asked anew each time
 * would never meet the approval of the last one. The newest standing,
 * unspent request with the same kind, subject, requester and fields gives
 * its `at`; with none, `now`.
 */
export async function requestedAt(
  op: string,
  request: Omit<GatedRequest, "at">,
  options: { now?: string; cwd?: string; ledger?: Pick<GatedRequestLedger, "readGatedRequests"> } = {},
): Promise<string> {
  const now = options.now ?? new Date().toISOString();
  const read = await (options.ledger ?? chantLedger).readGatedRequests(op, options.cwd ? { cwd: options.cwd } : undefined).catch(() => []);
  const same = JSON.stringify(Object.entries(request.fields).sort());
  const standing = read
    .filter((g) => !g.applied && g.request.kind === request.kind && g.request.subject === request.subject && g.request.by === request.by)
    .filter((g) => JSON.stringify(Object.entries(g.request.fields).sort()) === same)
    .filter((g) => !g.pending.expiresAt || g.pending.expiresAt > now)
    .at(-1);
  return standing?.request.at ?? now;
}

export interface GatedStateOpInput {
  op: string;
  /** The request, less `at`, which {@link requestedAt} fills. */
  request: Omit<GatedRequest, "at"> & { at?: string };
  rules: GatedRequestRules;
  description?: string;
  expiry?: string;
  base?: string;
  /** A document the request carries, such as a migration's proof; its digest joins the request. */
  attachment?: string;
  cwd?: string;
  now?: string;
  runId?: string;
  commit?: string;
  ledger?: GatedRequestLedger;
  gates?: RequestGateInput["gates"];
  /**
   * A last check just before the spend, for a fact that can change while the
   * request waited (a run that may hold the lock came back). A string refuses
   * the operation with that reason, and the approval is not spent.
   */
  beforeSpend?: () => Promise<string | undefined>;
}

/** How a gated operation ended. */
export type GatedStateOpResult<T> =
  | Exclude<RequestGateResult, { status: "approved" }>
  | { status: "held"; digest: string; request: GatedRequest; reason: string }
  | { status: "done"; digest: string; request: GatedRequest; approvedBy: string; output: T; recorded: boolean }
  | { status: "failed"; digest: string; request: GatedRequest; approvedBy: string; error: Error; recorded: boolean };

/**
 * Run `act` once its request is approved: ask (or read) the request, spend
 * the approval, act, and record how it ended. `act` returns its output and
 * the flat facts that go on the finished line. A spend that cannot be pushed
 * throws before `act` runs, so no approval acts twice. A finished line that
 * cannot be written is reported as `recorded: false`; the act already ran.
 */
export async function gatedStateOp<T>(
  input: GatedStateOpInput,
  act: (approved: { digest: string; request: GatedRequest; approvedBy: string }) => Promise<{ output: T; detail?: Record<string, string | number | boolean> }>,
): Promise<GatedStateOpResult<T>> {
  const ledger = input.ledger ?? chantLedger;
  const at = input.request.at ?? (await requestedAt(input.op, input.request, { ...(input.now ? { now: input.now } : {}), ...(input.cwd ? { cwd: input.cwd } : {}), ledger }));
  const request: GatedRequest = { kind: input.request.kind, subject: input.request.subject, by: input.request.by, at, fields: input.request.fields };
  const asked = await ledger.requestGate({
    op: input.op,
    request,
    rules: input.rules,
    ...(input.description ? { description: input.description } : {}),
    ...(input.expiry ? { expiry: input.expiry } : {}),
    ...(input.base ? { base: input.base } : {}),
    ...(input.attachment !== undefined ? { attachment: input.attachment } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.gates ? { gates: input.gates } : {}),
  });
  if (asked.status !== "approved") return asked;
  const { digest } = asked;
  const approvedBy = asked.approval.resolvedBy;
  const held = await input.beforeSpend?.();
  if (held) return { status: "held", digest, request: asked.request, reason: held };
  const spent = await ledger.spendGatedRequest({
    op: input.op,
    gate: request.subject,
    digest,
    approval: asked.approval,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const finish = async (result: "applied" | "failed", detail?: Record<string, string | number | boolean>): Promise<boolean> => {
    try {
      const f = await ledger.finishGatedRequest({ op: input.op, gate: request.subject, digest, applied: spent.timestamp, result, ...(detail ? { detail } : {}), ...(input.cwd ? { cwd: input.cwd } : {}) });
      return f.pushed;
    } catch {
      return false;
    }
  };
  try {
    const { output, detail } = await act({ digest, request: asked.request, approvedBy });
    return { status: "done", digest, request: asked.request, approvedBy, output, recorded: await finish("applied", detail) };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { status: "failed", digest, request: asked.request, approvedBy, error, recorded: await finish("failed", { error: error.message.slice(0, 400) }) };
  }
}

/** The digest a request binds, for a caller that prints it before it asks. */
export const stateOpDigest = (op: string, request: GatedRequest): string => gatedRequestDigest(op, request);

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

const actorOf = (env: NodeJS.ProcessEnv): string => env.GITHUB_ACTOR || env.GITLAB_USER_LOGIN || env.USER || env.USERNAME || "unknown";

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
