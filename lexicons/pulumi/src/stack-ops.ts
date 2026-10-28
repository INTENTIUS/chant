/**
 * Gated stack operations (#4578): a stack's export, a stuck lock's release,
 * and a move of resources between stacks, each run only after a gated
 * request (#4551) is approved on the workspace ledger. INTENTIUS/plywood#16
 * puts its `export`, `cancel` and `move` verbs on these; plywood holds the
 * words only.
 *
 * ## The request
 *
 * Each operation is a `GatedRequest` under the op {@link PULUMI_STACK_OPS_OP}
 * (or the caller's), its digest `gatedRequestDigest` over the op and the
 * request, so chant computes what an approval binds:
 *
 * | Operation | kind | subject (the gate) | fields |
 * |---|---|---|---|
 * | export | `stack-export` | `<stack>` | `stack`, `engine`, `deliver: requester` |
 * | cancel | `stack-cancel` | `<stack>` | `stack`, `lockId` |
 * | move | `stack-move` | `move:<source>:<dest>` | `source`, `dest`, `engine`, `urns` (sorted, comma-joined) |
 * | action | `stack-action` | `action:<stack>:<name>` (the URN without a name) | `stack`, `urn`, `engine`, `preview` (the preview's digest), `name` when given |
 *
 * The first call records the pending fact and answers `waiting` with the
 * `chant approve` command. A later call with the same request reuses the
 * standing request's `at`, so it digests the same and finds the approval.
 * The requester's own approval never counts (`refused`). Once approved, the
 * request is spent (`spendGatedRequest`, pushed before anything runs), the
 * operation runs, and a `finished` line records how it ended with flat
 * facts: never the export's content, only its digest and size.
 *
 * ## What runs
 *
 * - export: `pulumi stack export --stack <s>` (`plunge stack export` on
 *   plunge), the read form #4546 allows. The output goes to the requester's
 *   machine only: a file outside every git working tree, mode 600, never
 *   overwritten, and the call is refused in CI (`CI`, `GITHUB_ACTIONS`,
 *   `GITLAB_CI`, `FORGEJO_ACTIONS`), where it would become a job artifact.
 * - cancel: `pulumi cancel --yes --stack <s>`, after checking the stack's
 *   lock is still the one approved when the backend is a `file://` path
 *   (`.pulumi/locks/...`); another backend's lock is read by the caller's
 *   `readLockId`, or the check is reported as not made. A stack on plunge is
 *   refused: plunge keeps no stack lock.
 * - move: both stacks preview first, and the move runs only when the
 *   previews change nothing but the moved resources (each a delete in the
 *   source and a create of the same type and name in the destination), so
 *   the move leaves both previewing no change. On plunge, `plunge stack move
 *   ... --json` plans it as well and its refusals refuse the request. Then
 *   `pulumi state move --source --dest --yes <urn>...` on stock, or `plunge
 *   stack move ... --json --yes` (INTENTIUS/plunge#56). Both stacks preview
 *   again afterwards; a change left on either finishes the request `failed`
 *   with the changes named.
 *
 * - action (#4654): a day-2 action is a `command:` resource
 *   (`command:local:Command`, `command:remote:Command`) whose replacement is
 *   the operation. Its type is checked before anything runs (`action-type`).
 *   Each call previews `preview --json --target <urn> --replace <urn>`, and
 *   refuses (`action-scope`) unless the preview changes that URN alone, by
 *   a replacement. The request binds the preview's digest, so a preview
 *   that moved after the approval asks again. Once approved, `up --yes
 *   --target <urn> --replace <urn> --stack <s>` under the stack's engine,
 *   and the finished line keeps chant's `applied | failed` with
 *   `detail.result` `ok` or `failed`, the exit code and the output's last
 *   lines. A request that applied answers `spent` to the same call, unless
 *   the caller asks `anew`.
 *
 * The writes go through `runGatedPulumi` and `runGatedPlunge`
 * (`./run.ts`), whose fixed forms are the whole of what may run.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import type {
  finishGatedRequest as FinishGatedRequest,
  readGatedRequests as ReadGatedRequests,
  requestGate as RequestGate,
  spendGatedRequest as SpendGatedRequest,
  GatedRequest,
  GatedRequestRules,
  RequestGateResult,
} from "@intentius/chant/lifecycle/gated-request";
import { parsePulumiUrn, pulumiNodeKey } from "@intentius/chant/pulumi-urn";
import { pulumiStackBackend } from "./adopt";
import { pulumiExportResources, pulumiPreviewDigest, pulumiSteps, PULUMI_UNCHANGED_OPS } from "./change-set";
import { pulumiMemberEngine, type PulumiMemberEngine } from "./member-engine";
import {
  defaultPlungeRunner,
  defaultPulumiRunner,
  plungeMoveArgs,
  previewPulumiMemberRead,
  pulumiActionPreviewArgs,
  pulumiActionUpArgs,
  pulumiCancelArgs,
  pulumiRunFailure,
  pulumiStateMoveArgs,
  runAllowedPlunge,
  runAllowedPulumi,
  runGatedPlunge,
  runGatedPulumi,
  type PulumiRunner,
} from "./run";
import { isObject } from "./values";

/** The op the requests are recorded under, unless the caller names its own. */
export const PULUMI_STACK_OPS_OP = "pulumi-stack-ops";

export type PulumiStackOpKind = "stack-export" | "stack-cancel" | "stack-move" | "stack-action";

/** chant's gated-request API (#4551), injectable for tests. */
export interface GatedRequestApi {
  requestGate: typeof RequestGate;
  spendGatedRequest: typeof SpendGatedRequest;
  finishGatedRequest: typeof FinishGatedRequest;
  readGatedRequests: typeof ReadGatedRequests;
}

/** What every operation takes. */
export interface PulumiStackOpCommon {
  /** The requester, as the ledger names identities. Their own approval never counts. */
  by: string;
  /** Which approvals count: the block op waves read at base. */
  rules: GatedRequestRules;
  /** The op the request is recorded under. Default {@link PULUMI_STACK_OPS_OP}. */
  op?: string;
  /** Where the workspace ledger is read and written. Default the process's cwd. */
  ledgerCwd?: string;
  /** How long the pending fact stands. Default the gate default. */
  expiry?: string;
  now?: string;
  run?: PulumiRunner;
  plunge?: PulumiRunner;
  env?: Record<string, string | undefined>;
  gated?: GatedRequestApi;
}

/** How a call ended. Only `done` and `failed` ran anything. */
export type PulumiStackOpOutcome<T> =
  | { status: "waiting"; digest: string; request: GatedRequest; command: string }
  /** An approval stands and does not count, such as the requester's own. */
  | { status: "refused"; digest: string; request: GatedRequest; by: string; reason: string; command: string }
  /** It ran already under an approval; a request runs once. */
  | { status: "spent"; digest: string; request: GatedRequest }
  | { status: "done"; digest: string; request: GatedRequest; result: T }
  | { status: "failed"; digest: string; request: GatedRequest; error: string };

async function gatedApi(given?: GatedRequestApi): Promise<GatedRequestApi> {
  if (given) return given;
  try {
    const mod = (await import("@intentius/chant/lifecycle/gated-request")) as Partial<GatedRequestApi>;
    if (mod.requestGate && mod.spendGatedRequest && mod.finishGatedRequest && mod.readGatedRequests) return mod as GatedRequestApi;
  } catch {
    // Fall through to the refusal.
  }
  throw new Error("this chant has no gated requests (#4551), so a gated stack operation cannot be asked for; upgrade @intentius/chant");
}

const sameFields = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/**
 * Ask for the request, and run `act` once it is approved: the shared walk of
 * every operation. `precheck` runs after the approval and before the request
 * is spent, so a refusal there leaves the approval unspent.
 */
async function askThenAct<T>(
  common: PulumiStackOpCommon,
  kind: PulumiStackOpKind,
  subject: string,
  fields: Record<string, string>,
  description: string,
  act: () => Promise<{ result: T; detail: Record<string, string | number | boolean>; failed?: string }>,
  precheck?: () => Promise<void>,
  options: { reuseApplied?: boolean } = {},
): Promise<PulumiStackOpOutcome<T>> {
  const api = await gatedApi(common.gated);
  const op = common.op ?? PULUMI_STACK_OPS_OP;
  const cwd = common.ledgerCwd ?? process.cwd();
  // With reuseApplied (#4654), a request with these fields that applied already is asked again as itself, so it answers `spent`.
  const standing = (await api.readGatedRequests(op, { cwd }).catch(() => []))
    .filter((r) => (options.reuseApplied || !r.applied) && r.request.kind === kind && r.request.subject === subject && r.request.by === common.by && sameFields(r.request.fields, fields))
    .at(-1);
  const request: GatedRequest = { kind, subject, by: common.by, at: standing?.request.at ?? common.now ?? new Date().toISOString(), fields };
  const asked: RequestGateResult = await api.requestGate({
    op,
    request,
    rules: common.rules,
    description,
    cwd,
    ...(common.expiry ? { expiry: common.expiry } : {}),
    ...(common.now ? { now: common.now } : {}),
  });
  if (asked.status === "waiting") return { status: "waiting", digest: asked.digest, request: asked.request, command: asked.command };
  if (asked.status === "refused") return { status: "refused", digest: asked.digest, request: asked.request, by: asked.by, reason: asked.reason, command: asked.command };
  if (asked.status === "spent") return { status: "spent", digest: asked.digest, request: asked.request };

  if (precheck) await precheck();
  const applied = await api.spendGatedRequest({ op, gate: subject, digest: asked.digest, approval: asked.approval, cwd, ...(common.now ? { now: common.now } : {}) });
  try {
    const { result, detail, failed } = await act();
    await api.finishGatedRequest({ op, gate: subject, digest: asked.digest, applied: applied.timestamp, result: failed ? "failed" : "applied", detail: failed ? { ...detail, error: failed } : detail, cwd });
    return failed ? { status: "failed", digest: asked.digest, request: asked.request, error: failed } : { status: "done", digest: asked.digest, request: asked.request, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await api.finishGatedRequest({ op, gate: subject, digest: asked.digest, applied: applied.timestamp, result: "failed", detail: { error: error.slice(0, 2000) }, cwd }).catch(() => undefined);
    return { status: "failed", digest: asked.digest, request: asked.request, error };
  }
}

function stackDirOf(dir: string, cwd?: string): string {
  return isAbsolute(dir) ? dir : resolve(cwd ?? process.cwd(), dir);
}

function engineOf(dir: string, engine: PulumiMemberEngine | undefined, env?: Record<string, string | undefined>): PulumiMemberEngine {
  return pulumiMemberEngine(dir, engine, env ? { env } : {}).engine;
}

function why(err: unknown, binary: string): string {
  const f = pulumiRunFailure(err);
  return f.missingBinary ? `the ${binary} binary was not found on PATH` : (f.stderr?.trim() || f.message).split("\n").slice(-3).join("\n");
}

// ── export ───────────────────────────────────────────────────────────────

/** The CI variables that mark a job, where an export would become an artifact. */
export const CI_MARKERS = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "FORGEJO_ACTIONS", "BUILDKITE", "JENKINS_URL"];

/** The git working tree `path` sits in, or undefined. */
export function enclosingWorkTree(path: string): string | undefined {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export interface PulumiStackExportOptions extends PulumiStackOpCommon {
  /** The stack's directory, where `Pulumi.yaml` is. */
  dir: string;
  cwd?: string;
  stack: string;
  engine?: PulumiMemberEngine;
  /** Where the export is written on the requester's machine: outside every git working tree, and not there yet. */
  out: string;
}

export interface PulumiStackExportResult {
  file: string;
  sha256: string;
  bytes: number;
  resources: number;
}

/**
 * A stack's export, delivered to the requester's machine after a second
 * identity approves it. Refused in CI and for a destination inside a git
 * working tree, before anything is asked.
 */
export async function gatedStackExport(opts: PulumiStackExportOptions): Promise<PulumiStackOpOutcome<PulumiStackExportResult>> {
  const env = opts.env ?? process.env;
  const marker = CI_MARKERS.find((k) => env[k] !== undefined && env[k] !== "" && env[k] !== "false");
  if (marker) throw new Error(`a stack export goes to the requester's machine only, and ${marker} is set, so this is a CI job whose files can become artifacts; ask for it from your own machine`);
  const out = resolve(opts.out);
  const tree = enclosingWorkTree(dirname(out));
  if (tree) throw new Error(`a stack export never goes into a repository, and ${out} is inside the git working tree ${tree}; name a path outside it`);
  if (existsSync(out)) throw new Error(`${out} already exists; a stack export never overwrites a file`);
  const dir = stackDirOf(opts.dir, opts.cwd);
  const engine = engineOf(dir, opts.engine, env);
  return askThenAct(
    opts,
    "stack-export",
    opts.stack,
    { stack: opts.stack, engine, deliver: "requester" },
    `export of stack ${opts.stack} to ${opts.by}'s machine`,
    async () => {
      const args = ["stack", "export", "--stack", opts.stack];
      let stdout: string;
      try {
        ({ stdout } = engine === "plunge" ? await runAllowedPlunge(opts.plunge ?? defaultPlungeRunner, args, dir) : await runAllowedPulumi(opts.run ?? defaultPulumiRunner, args, dir));
      } catch (err) {
        throw new Error(`${engine} ${args.join(" ")} failed: ${why(err, engine)}`);
      }
      let resources = 0;
      try {
        resources = pulumiExportResources(JSON.parse(stdout)).length;
      } catch {
        throw new Error(`${engine} ${args.join(" ")} printed no JSON`);
      }
      writeFileSync(out, stdout, { mode: 0o600, flag: "wx" });
      const sha256 = createHash("sha256").update(stdout).digest("hex");
      const bytes = Buffer.byteLength(stdout);
      return { result: { file: out, sha256, bytes, resources }, detail: { sha256, bytes, resources } };
    },
  );
}

// ── cancel ───────────────────────────────────────────────────────────────

/**
 * The lock ids a DIY backend at `root` holds for a stack: the file names
 * under `.pulumi/locks/organization/<project>/<stack>/` (project-scoped
 * stacks) and `.pulumi/locks/<stack>/` (the older layout), without `.json`.
 */
export function diyStackLockIds(root: string, project: string | undefined, stack: string): string[] {
  const dirs = [...(project ? [join(root, ".pulumi", "locks", "organization", project, stack)] : []), join(root, ".pulumi", "locks", stack)];
  const ids = new Set<string>();
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".json")) ids.add(f.slice(0, -".json".length));
  }
  return [...ids].sort();
}

/** A stack's current lock, as {@link pulumiStackLockIds} reads it (#4615). */
export interface PulumiStackLocks {
  /** Whether the backend was read: a `file://` backend chant can list. False for Pulumi Cloud, a bucket, or no backend found. */
  checked: boolean;
  /** The backend URL the stack resolves to, when one was found. */
  backend?: string;
  /** The lock ids the stack holds now, sorted. Empty when it holds none, or when `checked` is false. */
  ids: string[];
}

/**
 * The lock ids a stack holds now (#4615), for a caller that needs the id
 * `gatedStackCancel` asks for: the stack's backend from its directory (the
 * environment's `PULUMI_BACKEND_URL`, else `Pulumi.yaml`'s `backend.url`),
 * and on a `file://` backend the lock files {@link diyStackLockIds} lists.
 * Any other backend answers `checked: false`. A stack on plunge keeps no
 * stack lock, so it answers `checked: true` with no ids.
 */
export async function pulumiStackLockIds(opts: { dir: string; stack: string; cwd?: string; project?: string; engine?: PulumiMemberEngine; env?: NodeJS.ProcessEnv }): Promise<PulumiStackLocks> {
  const env = opts.env ?? process.env;
  const dir = stackDirOf(opts.dir, opts.cwd);
  if (engineOf(dir, opts.engine, env) === "plunge") return { checked: true, ids: [] };
  const backend = pulumiStackBackend(dir, { env });
  const m = backend ? /^file:\/\/(.*)$/.exec(backend.url) : null;
  if (!m) return { checked: false, ...(backend ? { backend: backend.url } : {}), ids: [] };
  const root = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
  let project = opts.project;
  if (!project) {
    const { pulumiYamlName } = await import("./lint/post-synth/member-read-helpers");
    project = pulumiYamlName(dir);
  }
  return { checked: true, backend: backend!.url, ids: diyStackLockIds(root, project, opts.stack) };
}

export interface PulumiStackCancelOptions extends PulumiStackOpCommon {
  dir: string;
  cwd?: string;
  stack: string;
  engine?: PulumiMemberEngine;
  /** The lock the approver approves releasing. */
  lockId: string;
  /** The project, for a DIY backend's lock path. Default `Pulumi.yaml`'s `name`. */
  project?: string;
  /** Reads the stack's current lock id on a backend chant cannot read itself. */
  readLockId?: () => Promise<string | undefined>;
}

export interface PulumiStackCancelResult {
  /** Whether the current lock was read and found to be the approved one before `cancel` ran. */
  lockChecked: boolean;
}

/** Release a stuck lock after an approval of its lock id. Refused for plunge, which keeps no stack lock. */
export async function gatedStackCancel(opts: PulumiStackCancelOptions): Promise<PulumiStackOpOutcome<PulumiStackCancelResult>> {
  const env = opts.env ?? process.env;
  const dir = stackDirOf(opts.dir, opts.cwd);
  const engine = engineOf(dir, opts.engine, env);
  if (engine === "plunge") throw new Error(`stack ${opts.stack} runs on plunge, which keeps no stack lock, so there is nothing to cancel; a stuck plunge update is finished by running it again`);
  if (!opts.lockId || opts.lockId.startsWith("-")) throw new Error("a cancel names the lock id it releases");

  const readLock = async (): Promise<{ checked: boolean; ids: string[] }> => {
    if (opts.readLockId) {
      const id = await opts.readLockId();
      return { checked: true, ids: id ? [id] : [] };
    }
    const locks = await pulumiStackLockIds({ dir, stack: opts.stack, engine, env, ...(opts.project ? { project: opts.project } : {}) });
    return { checked: locks.checked, ids: locks.ids };
  };

  let checked = false;
  return askThenAct(
    opts,
    "stack-cancel",
    opts.stack,
    { stack: opts.stack, lockId: opts.lockId },
    `release of lock ${opts.lockId} on stack ${opts.stack}`,
    async () => {
      const args = pulumiCancelArgs({ stack: opts.stack });
      try {
        await runGatedPulumi(opts.run ?? defaultPulumiRunner, args, dir);
      } catch (err) {
        throw new Error(`pulumi ${args.join(" ")} failed: ${why(err, "pulumi")}`);
      }
      return { result: { lockChecked: checked }, detail: { lockId: opts.lockId, lockChecked: checked } };
    },
    async () => {
      const lock = await readLock();
      checked = lock.checked;
      if (lock.checked && !lock.ids.includes(opts.lockId)) {
        throw new Error(
          `refusing to cancel stack ${opts.stack}: the approved lock ${opts.lockId} is ${lock.ids.length === 0 ? "gone, and the stack holds no lock" : `not the one it holds now (${lock.ids.join(", ")})`}; ask again for the lock it holds`,
        );
      }
    },
  );
}

// ── move ─────────────────────────────────────────────────────────────────

/** One side of a move. */
export interface PulumiMoveStack {
  /** The member's name, for messages. */
  member: string;
  /** The stack's directory, where `Pulumi.yaml` is. */
  dir: string;
  /** The stack, as `--source` or `--dest` takes it (`<org>/<project>/<stack>` across projects). */
  stack: string;
}

export interface PulumiStackMoveOptions extends PulumiStackOpCommon {
  source: PulumiMoveStack;
  dest: PulumiMoveStack;
  /** The source URNs to move. */
  urns: string[];
  cwd?: string;
  engine?: PulumiMemberEngine;
}

export interface PulumiStackMoveResult {
  engine: PulumiMemberEngine;
  moved: string[];
  /** What the move printed: plunge's outcome document, parsed, on plunge. */
  outcome?: unknown;
}

/** The entries of a preview that change anything. */
function changing(part: ChangeSetPart): { address: string; type: string; action: string }[] {
  return part.entries.filter((e) => e.mayAppear === true || ["create", "update", "replace", "delete", "forget"].includes(e.action)).map((e) => ({ address: e.address, type: e.type, action: e.mayAppear ? "may-appear" : e.action }));
}

/**
 * What stands between the two previews and "no change once the move is
 * made": each changing entry that is not a moved resource's delete in the
 * source or its create, by type and name, in the destination. Empty when the
 * move leaves both previewing no change.
 */
export function moveLeftovers(urns: readonly string[], source: ChangeSetPart, dest: ChangeSetPart): string[] {
  const keys = new Set(urns.map((u) => pulumiNodeKey(u) ?? u));
  const out: string[] = [];
  const sourceDeletes = new Set<string>();
  for (const e of changing(source)) {
    const key = pulumiNodeKey(e.address) ?? e.address;
    if (e.action === "delete" && urns.includes(e.address)) sourceDeletes.add(key);
    else out.push(`${source.member.member}: ${e.action} ${e.address}`);
  }
  const destCreates = new Set<string>();
  for (const e of changing(dest)) {
    const key = pulumiNodeKey(e.address) ?? e.address;
    if (e.action === "create" && keys.has(key)) destCreates.add(key);
    else out.push(`${dest.member.member}: ${e.action} ${e.address}`);
  }
  for (const k of keys) {
    if (!sourceDeletes.has(k)) out.push(`${source.member.member}: its preview does not delete ${k}, so its program still declares it`);
    if (!destCreates.has(k)) out.push(`${dest.member.member}: its preview does not create ${k}, so its program does not declare it yet`);
  }
  return out;
}

/** plunge's move document's status and refusals, when it printed one. */
function moveView(text: string | undefined): { status: string; refusals: { urn?: string; reason: string }[]; error?: string; doc: unknown } | undefined {
  if (!text) return undefined;
  try {
    const doc = JSON.parse(text) as unknown;
    if (!isObject(doc) || typeof doc.status !== "string") return undefined;
    const refusals = (Array.isArray(doc.refusals) ? doc.refusals : []).filter(isObject).map((r) => ({ ...(typeof r.urn === "string" ? { urn: r.urn } : {}), reason: typeof r.reason === "string" ? r.reason : "" }));
    return { status: doc.status, refusals, ...(typeof doc.error === "string" ? { error: doc.error } : {}), doc };
  } catch {
    return undefined;
  }
}

/**
 * Move resources between two stacks after an approval: `pulumi state move`
 * on stock, plunge's marker move on plunge. Refused before anything is asked
 * for an empty or non-URN list or two engines.
 */
export async function gatedStackMove(opts: PulumiStackMoveOptions): Promise<PulumiStackOpOutcome<PulumiStackMoveResult>> {
  const env = opts.env ?? process.env;
  if (opts.urns.length === 0 || !opts.urns.every((u) => u.startsWith("urn:pulumi:"))) throw new Error("a move names the source URNs it moves, each urn:pulumi:...");
  const sourceDir = stackDirOf(opts.source.dir, opts.cwd);
  const destDir = stackDirOf(opts.dest.dir, opts.cwd);
  const engine = engineOf(sourceDir, opts.engine, env);
  const destEngine = engineOf(destDir, opts.engine, env);
  if (engine !== destEngine) throw new Error(`${opts.source.member} runs on ${engine} and ${opts.dest.member} on ${destEngine}; a move needs both stacks on one engine`);
  const urns = [...new Set(opts.urns)].sort();
  const runners = { ...(opts.run ? { run: opts.run } : {}), ...(opts.plunge ? { plunge: opts.plunge } : {}), engine };

  const previews = async (): Promise<{ source: ChangeSetPart; dest: ChangeSetPart }> => {
    const [s, d] = await Promise.all([
      previewPulumiMemberRead({ member: opts.source.member, dir: sourceDir, stack: opts.source.stack, ...runners }),
      previewPulumiMemberRead({ member: opts.dest.member, dir: destDir, stack: opts.dest.stack, ...runners }),
    ]);
    for (const p of [s.part, d.part]) {
      if (p.member.status === "failed") throw new Error(`the preview of ${p.member.member} failed: ${p.member.error ?? "no error printed"}`);
    }
    return { source: s.part, dest: d.part };
  };

  return askThenAct(
    opts,
    "stack-move",
    `move:${opts.source.stack}:${opts.dest.stack}`,
    { source: opts.source.stack, dest: opts.dest.stack, engine, urns: urns.join(",") },
    `move of ${urns.length} resource(s) from ${opts.source.stack} to ${opts.dest.stack}`,
    async () => {
      let outcome: unknown;
      if (engine === "plunge") {
        const args = plungeMoveArgs({ source: opts.source.stack, dest: opts.dest.stack, urns, yes: true });
        try {
          const { stdout } = await runGatedPlunge(opts.plunge ?? defaultPlungeRunner, args, sourceDir);
          outcome = moveView(stdout)?.doc;
        } catch (err) {
          const view = moveView(pulumiRunFailure(err).stdout);
          if (view) {
            const reasons = view.refusals.map((r) => `${r.urn ?? ""} ${r.reason}`.trim()).join("; ");
            throw new Error(`plunge stack move ${view.status}: ${reasons || view.error || "no reason printed"}${view.status === "interrupted" ? "; run the move again to finish it" : ""}`);
          }
          throw new Error(`plunge ${args.join(" ")} failed: ${why(err, "plunge")}`);
        }
      } else {
        const args = pulumiStateMoveArgs({ source: opts.source.stack, dest: opts.dest.stack, urns });
        try {
          await runGatedPulumi(opts.run ?? defaultPulumiRunner, args, sourceDir);
        } catch (err) {
          throw new Error(`pulumi ${args.join(" ")} failed: ${why(err, "pulumi")}`);
        }
      }
      // Both stacks must preview no change once the move is made.
      const after = await previews();
      const left = [...changing(after.source).map((e) => `${opts.source.member}: ${e.action} ${e.address}`), ...changing(after.dest).map((e) => `${opts.dest.member}: ${e.action} ${e.address}`)];
      const result: PulumiStackMoveResult = { engine, moved: urns, ...(outcome !== undefined ? { outcome } : {}) };
      return {
        result,
        detail: { moved: urns.length, engine, afterNoChange: left.length === 0 },
        ...(left.length > 0 ? { failed: `the move ran, and the stacks still preview changes: ${left.join("; ")}` } : {}),
      };
    },
    async () => {
      const before = await previews();
      const left = moveLeftovers(urns, before.source, before.dest);
      if (left.length > 0) throw new Error(`refusing to move: the previews change more than the moved resources, so the stacks would not preview no change after it: ${left.join("; ")}`);
      if (engine === "plunge") {
        const args = plungeMoveArgs({ source: opts.source.stack, dest: opts.dest.stack, urns });
        let view: ReturnType<typeof moveView>;
        try {
          view = moveView((await runAllowedPlunge(opts.plunge ?? defaultPlungeRunner, args, sourceDir)).stdout);
        } catch (err) {
          view = moveView(pulumiRunFailure(err).stdout);
          if (!view) throw new Error(`plunge ${args.join(" ")} failed: ${why(err, "plunge")}`);
        }
        if (!view || view.status !== "planned") {
          const reasons = view?.refusals.map((r) => `${r.urn ?? ""} ${r.reason}`.trim()).join("; ");
          throw new Error(`refusing to move: plunge's plan is ${view?.status ?? "missing"}${reasons ? `: ${reasons}` : ""}`);
        }
      }
    },
  );
}

// ── action ───────────────────────────────────────────────────────────────

/** Why a stack action was refused before anything was asked (#4654). */
export type PulumiStackActionRefusal = "action-urn" | "action-type" | "action-scope";

/** A stack action refused before its request: `code` says why, `urns` names what the preview changed besides the action, for `action-scope`. */
export class PulumiStackActionRefused extends Error {
  readonly code: PulumiStackActionRefusal;
  readonly urns: string[];
  constructor(code: PulumiStackActionRefusal, message: string, urns: string[] = []) {
    super(`${code}: ${message}`);
    this.name = "PulumiStackActionRefused";
    this.code = code;
    this.urns = urns;
  }
}

/** The resource types an action may name: the command provider's (`command:local:Command`, `command:remote:Command`). */
export const PULUMI_ACTION_TYPE_PREFIX = "command:";

/** An action's name as a caller's config gives it, for the request's subject. */
const ACTION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/** The subject an action's request is asked and approved under: `action:<stack>:<name>`, or the URN in place of a name. */
export const stackActionSubject = (stack: string, nameOrUrn: string): string => `action:${stack}:${nameOrUrn}`;

export interface PulumiStackActionOptions extends PulumiStackOpCommon {
  /** The stack's directory, where `Pulumi.yaml` is. */
  dir: string;
  cwd?: string;
  /** The stack, as `--stack` takes it. */
  stack: string;
  engine?: PulumiMemberEngine;
  /** The `command:` resource whose replacement is the action. */
  urn: string;
  /** The action's name in the caller's config, which the subject carries in place of the URN. */
  name?: string;
  /** Ask anew even when the same request applied already. Absent, such a call answers `spent`, so a retried job never runs the action twice. */
  anew?: boolean;
}

export interface PulumiStackActionResult {
  urn: string;
  engine: PulumiMemberEngine;
  /** The preview's digest the request bound. */
  preview: string;
  /** The update's exit code: 0, since a failed update ends `failed`. */
  exit: number;
  /** The update's last lines of output. */
  tail: string;
}

/** The last `n` lines of `text`, trimmed. */
const lastLines = (text: string | undefined, n: number): string =>
  (text ?? "").trim().split("\n").slice(-n).join("\n");

/**
 * Check an action's URN before anything runs: a Pulumi URN on `stack` whose
 * type is a command provider's. Throws {@link PulumiStackActionRefused}.
 */
export function checkStackActionUrn(stack: string, urn: string): void {
  const parsed = parsePulumiUrn(urn);
  if (!parsed) throw new PulumiStackActionRefused("action-urn", `${JSON.stringify(urn)} is not a resource URN (urn:pulumi:<stack>::<project>::<type>::<name>)`);
  const stackName = stack.split("/").at(-1);
  if (parsed.stack !== stackName) throw new PulumiStackActionRefused("action-urn", `${urn} names stack ${parsed.stack}, and the action runs on ${stack}`);
  if (!parsed.type.startsWith(PULUMI_ACTION_TYPE_PREFIX)) {
    throw new PulumiStackActionRefused(
      "action-type",
      `${urn} is a ${parsed.type}, and an action is a command resource (command:local:Command or command:remote:Command), whose replacement runs it; replacing any other resource is an update`,
    );
  }
}

/**
 * What a preview changes besides the action's replacement (#4654): each URN
 * with a changing step other than `urn`, and `urn` itself when it changes
 * other than by replacement or is not replaced at all. Empty when the
 * preview replaces `urn` and nothing else.
 */
export function stackActionScope(urn: string, preview: unknown): { others: string[]; problem?: string } {
  const steps = pulumiSteps(preview) ?? [];
  const others = new Set<string>();
  let replaced = false;
  let problem: string | undefined;
  for (const s of steps) {
    const op = s.op ?? "";
    if (PULUMI_UNCHANGED_OPS.has(op)) continue;
    if (s.urn !== urn) {
      others.add(s.urn!);
      continue;
    }
    if (op === "replace" || op === "create-replacement" || op === "delete-replaced") replaced = true;
    else problem = `the preview shows ${op} of ${urn}, not its replacement`;
  }
  if (!problem && !replaced) problem = `the preview does not replace ${urn}`;
  return { others: [...others].sort(), ...(problem ? { problem } : {}) };
}

/**
 * A day-2 action on a stack (#4654): the replacement of one `command:`
 * resource, previewed, asked for under a gated request, and run once a
 * second identity approves. Refused before anything runs for a URN that is
 * not a command resource's (`action-type`), and before anything is asked for
 * a preview that changes more than that replacement (`action-scope`).
 */
export async function gatedStackAction(opts: PulumiStackActionOptions): Promise<PulumiStackOpOutcome<PulumiStackActionResult>> {
  checkStackActionUrn(opts.stack, opts.urn);
  if (opts.name !== undefined && !ACTION_NAME.test(opts.name)) throw new Error(`an action's name is letters, digits, "_", "." and "-", not ${JSON.stringify(opts.name)}`);
  const env = opts.env ?? process.env;
  const dir = stackDirOf(opts.dir, opts.cwd);
  const engine = engineOf(dir, opts.engine, env);
  const target = { stack: opts.stack, urn: opts.urn };

  const previewArgs = pulumiActionPreviewArgs(target);
  let stdout: string;
  try {
    ({ stdout } = engine === "plunge" ? await runAllowedPlunge(opts.plunge ?? defaultPlungeRunner, previewArgs, dir) : await runAllowedPulumi(opts.run ?? defaultPulumiRunner, previewArgs, dir));
  } catch (err) {
    throw new Error(`${engine} ${previewArgs.join(" ")} failed: ${why(err, engine)}`);
  }
  let preview: unknown;
  try {
    preview = JSON.parse(stdout);
  } catch {
    throw new Error(`${engine} ${previewArgs.join(" ")} printed no JSON`);
  }
  const scope = stackActionScope(opts.urn, preview);
  if (scope.others.length > 0) {
    throw new PulumiStackActionRefused(
      "action-scope",
      `the preview of ${opts.stack} replacing ${opts.urn} also changes ${scope.others.join(", ")}, and an action replaces its command resource alone; nothing was asked for`,
      scope.others,
    );
  }
  if (scope.problem) throw new PulumiStackActionRefused("action-scope", `${scope.problem}; nothing was asked for`);

  const digest = pulumiPreviewDigest(preview, { changedOnly: true });
  const subject = stackActionSubject(opts.stack, opts.name ?? opts.urn);
  const fields: Record<string, string> = { stack: opts.stack, urn: opts.urn, engine, preview: digest, ...(opts.name ? { name: opts.name } : {}) };
  return askThenAct(
    opts,
    "stack-action",
    subject,
    fields,
    `action ${opts.name ?? opts.urn} on stack ${opts.stack}: replace ${opts.urn}, requested by ${opts.by}`,
    async () => {
      const args = pulumiActionUpArgs(target);
      try {
        const done = engine === "plunge" ? await runGatedPlunge(opts.plunge ?? defaultPlungeRunner, args, dir) : await runGatedPulumi(opts.run ?? defaultPulumiRunner, args, dir);
        const tail = lastLines(done.stdout, 10);
        return { result: { urn: opts.urn, engine, preview: digest, exit: 0, tail }, detail: { result: "ok", exit: 0, tail: tail.slice(-400), urn: opts.urn } };
      } catch (err) {
        const f = pulumiRunFailure(err);
        const exit = f.exitCode ?? 1;
        const tail = lastLines(`${f.stdout ?? ""}\n${f.stderr ?? ""}`, 10);
        return {
          result: { urn: opts.urn, engine, preview: digest, exit, tail },
          detail: { result: "failed", exit, tail: tail.slice(-400), urn: opts.urn },
          failed: `${engine} ${args.join(" ")} failed: ${why(err, engine)}`,
        };
      }
    },
    undefined,
    { reuseApplied: !opts.anew },
  );
}
