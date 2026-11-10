/**
 * Gated stack operations (#4578): a stack's export, a stuck lock's release,
 * a move of resources between stacks and a day-2 action, each run only
 * after a gated request (#4551) is approved on the workspace ledger.
 * INTENTIUS/plywood#16 puts its `export`, `cancel`, `move` and `action`
 * verbs on these; plywood holds the words only.
 *
 * Since #4808 each one runs on chant core's walk rather than one of its
 * own: the export is core's `exportStateVersion` over a Pulumi
 * {@link pulumiStackVersionSource}, the cancel is core's `releaseStateLock`
 * over a Pulumi lock source, the move is core's `runStateMigration` over a
 * Pulumi migration engine, and the action is core's `gatedOp`. So each one
 * gets what core's adapters check: the export of one version, the live-run
 * check before a cancel, and the check that nothing moved between a move's
 * plan and its write.
 *
 * ## The request
 *
 * Each operation is a `GatedRequest` under the op {@link PULUMI_STACK_OPS_OP}
 * (or the caller's), its digest `gatedRequestDigest` over the op and the
 * request, so chant computes what an approval binds:
 *
 * | Operation | kind | subject (the gate) | fields |
 * |---|---|---|---|
 * | export | `stack-export` | `<stack>` | `location`, `version_id` |
 * | cancel | `stack-cancel` | `<stack>` | `location`, `id` (the lock id) |
 * | move | `stack-move` | `move:<source>:<dest>` | `source`, `dest`, `engine`, `urns` (sorted, comma-joined), `roots`, `proof` (the plan's digest) |
 * | action | `stack-action` | `action:<stack>:<name>` (the URN without a name) | `stack`, `urn`, `engine`, `preview` (the preview's digest), `name` when given |
 *
 * The first call records the pending fact and answers `waiting` with the
 * `chant approve` command. A later call with the same request reuses the
 * standing request's `at`, so it digests the same and finds the approval.
 * The requester's own approval never counts (`refused`). Once approved, the
 * request is spent (pushed before anything runs), the operation runs, and a
 * `finished` line records how it ended with flat facts: never a state's
 * content, only digests, ids and counts.
 *
 * ## What runs
 *
 * - export: the version asked for, else the one the stack holds now. On a
 *   backend that numbers its updates (Pulumi Cloud) the version is the
 *   update's number from `stack history`, and the approved call runs
 *   `pulumi stack export --stack <s> --version <n>`. A file backend, a
 *   bucket and plunge number none, so there the version is the `sha256:`
 *   digest of the stack's export now, and the approved call writes the
 *   export only while its digest is still that one; a stack updated after
 *   the approval asks again. The output goes to the requester's machine
 *   only: a file outside every git working tree, mode 600, never
 *   overwritten, and the call is refused in CI.
 * - cancel: the lock is read first (a `file://` backend's lock file under
 *   `.pulumi/locks/...`, or the caller's `readLockId`); an approved lock
 *   that is not the one held is refused before anything is asked. While a
 *   run of the repository that began before the lock was taken is alive,
 *   nothing is asked ({@link PulumiStackOpRefused} `live-run`), and the runs
 *   are read again just before the spend (`held`). Then `pulumi cancel
 *   --yes --stack <s>`, and the lock is read again to check it went. A stack
 *   on plunge is refused: plunge keeps no stack lock.
 * - move: both stacks preview first, and the move is asked for only when
 *   the previews change nothing but the moved resources (each a delete in
 *   the source and a create of the same type and name in the destination).
 *   On plunge, `plunge stack move ... --json` plans it as well and its
 *   refusals refuse the request. The request binds each stack's export
 *   digest, so a stack updated before the approval asks again. Approved,
 *   each stack's export is read again just before the write, and one that
 *   is not the planned one refuses the move with nothing moved (`failed`,
 *   `check: "moved"`). Then `pulumi state move --source --dest --yes
 *   <urn>...` on stock, or `plunge stack move ... --json --yes`
 *   (INTENTIUS/plunge#56), and both stacks preview again; a change left on
 *   either finishes the request `failed` with the changes named.
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
 * The writes go through `runGatedPulumi` and `runGatedPlunge`, and the
 * version reads through `runStackOpReadPulumi` (`./run.ts`), whose fixed
 * forms are the whole of what may run.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import type { ForgeOverrides } from "@intentius/chant/forge-flags";
import { chantGatedLedger, gatedOp, type GatedOpAct, type GatedRequestLedger } from "@intentius/chant/lifecycle/gated-op";
import type { GatedRequest, GatedRequestRules } from "@intentius/chant/lifecycle/gated-request";
import type { ForgeTargetOptions } from "@intentius/chant/pr-forge";
import { exportStateVersion, StateExportError, type StateVersionSource } from "@intentius/chant/state-export";
import { runStateMigration, type MigrationCheck, type MigrationRootPlan, type StateMigrationEngine } from "@intentius/chant/state-migration";
import { describeRun, forgeLiveRuns, releaseStateLock, type LiveRun, type LockInfo, type StateLockSource } from "@intentius/chant/state-unlock";
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
  pulumiStackExportVersionArgs,
  pulumiStackHistoryArgs,
  pulumiStateMoveArgs,
  runAllowedPlunge,
  runAllowedPulumi,
  runGatedPlunge,
  runGatedPulumi,
  runStackOpReadPulumi,
  type PulumiRunner,
} from "./run";
import { isObject } from "./values";

/** The op the requests are recorded under, unless the caller names its own. */
export const PULUMI_STACK_OPS_OP = "pulumi-stack-ops";

export type PulumiStackOpKind = "stack-export" | "stack-cancel" | "stack-move" | "stack-action";

/** chant's gated-request ledger (#4551), injectable for tests: core's `GatedRequestLedger`. */
export type GatedRequestApi = GatedRequestLedger;

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
  /** How long the pending fact stands. Default 48h. */
  expiry?: string;
  /** The ref the rules are read at. */
  base?: string;
  now?: string;
  run?: PulumiRunner;
  plunge?: PulumiRunner;
  env?: Record<string, string | undefined>;
  gated?: GatedRequestApi;
}

/** Which of core's checks stopped an operation that was approved (#4808): a state that moved between the plan and the write. */
export type PulumiStackOpCheck = "moved";

/** How a call ended. Only `done` and `failed` ran anything. */
export type PulumiStackOpOutcome<T> =
  | { status: "waiting"; digest: string; request: GatedRequest; command: string }
  /** An approval stands and does not count, such as the requester's own. */
  | { status: "refused"; digest: string; request: GatedRequest; by: string; reason: string; command: string }
  /** It ran already under an approval; a request runs once. */
  | { status: "spent"; digest: string; request: GatedRequest }
  | { status: "done"; digest: string; request: GatedRequest; result: T; approvedBy?: string; recorded?: boolean }
  | { status: "failed"; digest: string; request: GatedRequest; error: string; check?: PulumiStackOpCheck; recorded?: boolean };

/** Why an operation was refused without acting (#4808). `held` was approved and stays unspent. */
export type PulumiStackOpRefusal = "live-run" | "held" | "lock-gone";

/** An operation core's checks refused before it acted: `code` says which, `runs` names the live runs. */
export class PulumiStackOpRefused extends Error {
  readonly code: PulumiStackOpRefusal;
  readonly runs: LiveRun[];
  readonly digest?: string;
  constructor(code: PulumiStackOpRefusal, message: string, extra: { runs?: LiveRun[]; digest?: string } = {}) {
    super(`${code}: ${message}`);
    this.name = "PulumiStackOpRefused";
    this.code = code;
    this.runs = extra.runs ?? [];
    if (extra.digest) this.digest = extra.digest;
  }
}

/** The gated-request settings core's walks take, from the common options. */
function gatedSettings(common: PulumiStackOpCommon) {
  return {
    rules: common.rules,
    ...(common.ledgerCwd ? { cwd: common.ledgerCwd } : {}),
    ...(common.expiry ? { expiry: common.expiry } : {}),
    ...(common.base ? { base: common.base } : {}),
    ...(common.now ? { now: common.now } : {}),
    ...(common.gated ? { ledger: common.gated } : {}),
  };
}

/** The request core asked under `digest`, read back from the ledger, since core's outcomes name only its digest; `fallback` when the ledger has none. */
async function askedRequest(common: PulumiStackOpCommon, digest: string, fallback: Omit<GatedRequest, "at">): Promise<GatedRequest> {
  const read = digest ? await (common.gated ?? chantGatedLedger).readGatedRequests(common.op ?? PULUMI_STACK_OPS_OP, common.ledgerCwd ? { cwd: common.ledgerCwd } : undefined).catch(() => []) : [];
  return read.find((g) => g.digest === digest)?.request ?? { ...fallback, at: "" };
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

const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** Where a stack's state is, as messages and the record name it: the stack and its backend's URL, never a credential. */
function stackLocation(dir: string, stack: string, env: Record<string, string | undefined>): string {
  const backend = pulumiStackBackend(dir, { env });
  return `stack ${stack}${backend ? ` at ${backend.url}` : ""}`;
}

/** The stack's export now, under its engine's read form. */
async function exportNow(opts: { dir: string; stack: string; engine: PulumiMemberEngine; run?: PulumiRunner; plunge?: PulumiRunner }): Promise<string> {
  const args = ["stack", "export", "--stack", opts.stack];
  try {
    const { stdout } = opts.engine === "plunge" ? await runAllowedPlunge(opts.plunge ?? defaultPlungeRunner, args, opts.dir) : await runAllowedPulumi(opts.run ?? defaultPulumiRunner, args, opts.dir);
    return stdout;
  } catch (err) {
    throw new Error(`${opts.engine} ${args.join(" ")} failed: ${why(err, opts.engine)}`);
  }
}

// ── export ───────────────────────────────────────────────────────────────

/** The CI variables that mark a job, where an export would become an artifact. Core's list (`@intentius/chant/state-export`). */
export { CI_MARKERS, enclosingWorkTree } from "@intentius/chant/state-export";

/** A version id that is an update's number, as `stack history` and `stack export --version` take it. */
const UPDATE_NUMBER = /^[1-9][0-9]*$/;

/**
 * A stack's state read by version (#4808), core's `StateVersionSource` for
 * `exportStateVersion`. On a backend that numbers its updates the version
 * is the newest update's number (`stack history --json --page-size 1`), a
 * version is held when it is between 1 and that number, and one is read
 * with `stack export --version <n>`. A backend that numbers none (a file
 * backend answers `0`, plunge keeps no history chant reads) has one version,
 * the one it holds now, named by its export's `sha256:` digest; reading it
 * exports again and refuses an export whose digest moved. `read` keeps the
 * last export's size and resource count for the caller.
 */
export function pulumiStackVersionSource(opts: { dir: string; stack: string; engine: PulumiMemberEngine; run?: PulumiRunner; plunge?: PulumiRunner; env?: Record<string, string | undefined> }): StateVersionSource & { read?: { bytes: number; resources: number } } {
  const location = stackLocation(opts.dir, opts.stack, opts.env ?? process.env);
  const newest = async (): Promise<number | undefined> => {
    if (opts.engine === "plunge") return undefined;
    let stdout: string;
    try {
      ({ stdout } = await runStackOpReadPulumi(opts.run ?? defaultPulumiRunner, pulumiStackHistoryArgs(opts.stack), opts.dir));
    } catch {
      // A history that cannot be read numbers nothing; the export by digest still stands.
      return undefined;
    }
    try {
      const doc = JSON.parse(stdout) as unknown;
      const first = Array.isArray(doc) ? doc[0] : undefined;
      const v = isObject(first) && typeof first.version === "number" ? first.version : 0;
      return v > 0 ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const checked = (body: string, what: string): string => {
    let resources: number;
    try {
      resources = pulumiExportResources(JSON.parse(body)).length;
    } catch {
      throw new StateExportError(`${what} printed no JSON`);
    }
    source.read = { bytes: Buffer.byteLength(body), resources };
    return body;
  };
  const source: StateVersionSource & { read?: { bytes: number; resources: number } } = {
    location,
    async current() {
      const n = await newest();
      if (n !== undefined) return { exists: true, versionId: String(n) };
      return { exists: true, versionId: sha256(await exportNow(opts)) };
    },
    async hasVersion(id) {
      if (UPDATE_NUMBER.test(id)) {
        const n = await newest();
        return n !== undefined && Number(id) <= n;
      }
      return id.startsWith("sha256:") && (await newest()) === undefined && sha256(await exportNow(opts)) === id;
    },
    async readVersion(id) {
      if (UPDATE_NUMBER.test(id)) {
        const args = pulumiStackExportVersionArgs(opts.stack, id);
        let stdout: string;
        try {
          ({ stdout } = await runStackOpReadPulumi(opts.run ?? defaultPulumiRunner, args, opts.dir));
        } catch (err) {
          throw new StateExportError(`pulumi ${args.join(" ")} failed: ${why(err, "pulumi")}`);
        }
        return checked(stdout, `pulumi ${args.join(" ")}`);
      }
      const body = await exportNow(opts);
      if (sha256(body) !== id) throw new StateExportError(`${location} changed since the request: its export is no longer ${id}, so nothing was written; ask again for the state it holds now`);
      return checked(body, `${opts.engine} stack export --stack ${opts.stack}`);
    },
  };
  return source;
}

export interface PulumiStackExportOptions extends PulumiStackOpCommon {
  /** The stack's directory, where `Pulumi.yaml` is. */
  dir: string;
  cwd?: string;
  stack: string;
  engine?: PulumiMemberEngine;
  /** Where the export is written on the requester's machine: outside every git working tree, and not there yet. */
  out: string;
  /** The version to export (#4808): an update's number on a backend that numbers them, else the `sha256:` digest of the export now. Default the version the stack holds now. */
  version?: string;
}

export interface PulumiStackExportResult {
  file: string;
  /** The hex SHA-256 of the bytes written. */
  sha256: string;
  bytes: number;
  resources: number;
  /** The version exported (#4808). */
  version: string;
}

/**
 * A stack's export, one version of it, delivered to the requester's machine
 * after a second identity approves it: core's `exportStateVersion` over
 * {@link pulumiStackVersionSource}. Refused in CI, for a destination inside
 * a git working tree or over a file, and for a version the stack does not
 * have, before anything is asked.
 */
export async function gatedStackExport(opts: PulumiStackExportOptions): Promise<PulumiStackOpOutcome<PulumiStackExportResult>> {
  const env = opts.env ?? process.env;
  const dir = stackDirOf(opts.dir, opts.cwd);
  const engine = engineOf(dir, opts.engine, env);
  const source = pulumiStackVersionSource({ dir, stack: opts.stack, engine, env, ...(opts.run ? { run: opts.run } : {}), ...(opts.plunge ? { plunge: opts.plunge } : {}) });
  const out = resolve(opts.out);
  const r = await exportStateVersion({
    subject: opts.stack,
    by: opts.by,
    source,
    out,
    ...(opts.version ? { version: opts.version } : {}),
    words: { op: opts.op ?? PULUMI_STACK_OPS_OP, kind: "stack-export" },
    env,
    ...gatedSettings(opts),
  });
  const request = await askedRequest(opts, r.digest, { kind: "stack-export", subject: opts.stack, by: opts.by, fields: { location: r.location, version_id: r.version } });
  switch (r.status) {
    case "waiting":
      return { status: "waiting", digest: r.digest, request, command: r.command };
    case "refused":
      return { status: "refused", digest: r.digest, request, by: r.by, reason: r.reason, command: r.command };
    case "spent":
      return { status: "spent", digest: r.digest, request };
    case "failed":
      return { status: "failed", digest: r.digest, request, error: r.error.message, recorded: r.recorded };
    case "written":
      return {
        status: "done",
        digest: r.digest,
        request,
        approvedBy: r.approvedBy,
        recorded: r.recorded,
        result: { file: r.file, sha256: r.contentDigest.replace(/^sha256:/, ""), bytes: source.read?.bytes ?? 0, resources: source.read?.resources ?? 0, version: r.version },
      };
  }
}

// ── cancel ───────────────────────────────────────────────────────────────

/** The two lock directories of a DIY backend at `root` for a stack: project-scoped first, then the older layout. */
function diyLockDirs(root: string, project: string | undefined, stack: string): string[] {
  return [...(project ? [join(root, ".pulumi", "locks", "organization", project, stack)] : []), join(root, ".pulumi", "locks", stack)];
}

/**
 * The lock ids a DIY backend at `root` holds for a stack: the file names
 * under `.pulumi/locks/organization/<project>/<stack>/` (project-scoped
 * stacks) and `.pulumi/locks/<stack>/` (the older layout), without `.json`.
 */
export function diyStackLockIds(root: string, project: string | undefined, stack: string): string[] {
  const ids = new Set<string>();
  for (const d of diyLockDirs(root, project, stack)) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".json")) ids.add(f.slice(0, -".json".length));
  }
  return [...ids].sort();
}

/**
 * One DIY lock as core's `LockInfo` (#4808): its id, and from the lock
 * file Pulumi writes (`pid`, `username`, `hostname`, `timestamp`) who took
 * it and when, so the live-run check knows which runs could hold it.
 * Undefined when the stack holds no lock of that id.
 */
export function diyStackLock(root: string, project: string | undefined, stack: string, id: string): LockInfo | undefined {
  for (const d of diyLockDirs(root, project, stack)) {
    const file = join(d, `${id}.json`);
    if (!existsSync(file)) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      doc = undefined;
    }
    const s = (k: string): string | undefined => (isObject(doc) && typeof doc[k] === "string" && doc[k] !== "" ? (doc[k] as string) : undefined);
    const who = s("username") && s("hostname") ? `${s("username")}@${s("hostname")}` : s("username");
    return { ID: id, ...(who ? { Who: who } : {}), ...(s("timestamp") ? { Created: s("timestamp")! } : {}) };
  }
  return undefined;
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

/** The DIY root and project of a stack on a `file://` backend, or undefined for any other backend. */
async function diyRootOf(dir: string, env: Record<string, string | undefined>, project?: string): Promise<{ root?: string; project?: string; backend?: string }> {
  const backend = pulumiStackBackend(dir, { env });
  const m = backend ? /^file:\/\/(.*)$/.exec(backend.url) : null;
  if (!m) return backend ? { backend: backend.url } : {};
  const root = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
  let name = project;
  if (!name) {
    const { pulumiYamlName } = await import("./lint/post-synth/member-read-helpers");
    name = pulumiYamlName(dir);
  }
  return { root, backend: backend!.url, ...(name ? { project: name } : {}) };
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
  const at = await diyRootOf(dir, env, opts.project);
  if (!at.root) return { checked: false, ...(at.backend ? { backend: at.backend } : {}), ids: [] };
  return { checked: true, ...(at.backend ? { backend: at.backend } : {}), ids: diyStackLockIds(at.root, at.project, opts.stack) };
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
  /**
   * The repository's runs that have not finished (#4808), read before the
   * request and again just before the spend: while one that began before
   * the lock was taken is alive, nothing is released. A throw refuses the
   * release. Default core's `forgeLiveRuns` of the forge {@link forge}
   * names over the environment (`forgeTargetWith`).
   */
  liveRuns?: () => Promise<LiveRun[]>;
  /** The forge whose runs are read when no `liveRuns` is given: `--forge`, `--repo` and the rest a product's flags give. */
  forge?: ForgeTargetOptions & ForgeOverrides;
  commit?: string;
}

export interface PulumiStackCancelResult {
  /** Whether the current lock was read and found to be the approved one before `cancel` ran. */
  lockChecked: boolean;
  /** How many of the repository's runs were alive at the check, none of them able to hold the lock. */
  liveRuns: number;
}

/** The runs of the forge `forge` names over `env`, as core reads them (#4808). */
function forgeRuns(env: Record<string, string | undefined>, forge: (ForgeTargetOptions & ForgeOverrides) | undefined): () => Promise<LiveRun[]> {
  return async () => {
    const { forgeTargetWith } = await import("@intentius/chant/forge-flags");
    const t = forgeTargetWith(env, forge ?? {});
    return forgeLiveRuns({ kind: t.kind, apiBase: t.apiBase, repo: t.repo, token: t.token, ...(t.tokenHeader ? { tokenHeader: t.tokenHeader } : {}) });
  };
}

/**
 * Release a stuck lock after an approval of its lock id, while no run that
 * may hold it is alive: core's `releaseStateLock` over the stack's lock.
 * Refused for plunge, which keeps no stack lock. On a backend chant cannot
 * list and with no `readLockId`, the lock is the one the caller names and
 * `lockChecked` is false.
 */
export async function gatedStackCancel(opts: PulumiStackCancelOptions): Promise<PulumiStackOpOutcome<PulumiStackCancelResult>> {
  const env = opts.env ?? process.env;
  const dir = stackDirOf(opts.dir, opts.cwd);
  const engine = engineOf(dir, opts.engine, env);
  if (engine === "plunge") throw new Error(`stack ${opts.stack} runs on plunge, which keeps no stack lock, so there is nothing to cancel; a stuck plunge update is finished by running it again`);
  if (!opts.lockId || opts.lockId.startsWith("-")) throw new Error("a cancel names the lock id it releases");

  const at: { root?: string; project?: string; backend?: string } = opts.readLockId ? {} : await diyRootOf(dir, env, opts.project);
  const checked = opts.readLockId !== undefined || at.root !== undefined;
  const heldIds = async (): Promise<string[]> => {
    if (opts.readLockId) {
      const id = await opts.readLockId();
      return id ? [id] : [];
    }
    return at.root ? diyStackLockIds(at.root, at.project, opts.stack) : [];
  };
  if (checked) {
    const ids = await heldIds();
    if (!ids.includes(opts.lockId)) {
      throw new PulumiStackOpRefused(
        "lock-gone",
        `refusing to cancel stack ${opts.stack}: the approved lock ${opts.lockId} is ${ids.length === 0 ? "gone, and the stack holds no lock" : `not the one it holds now (${ids.join(", ")})`}; ask again for the lock it holds`,
      );
    }
  }
  const location = at.root ? `${at.backend} lock of stack ${opts.stack}` : stackLocation(dir, opts.stack, env);
  let released = false;
  const lock: StateLockSource = {
    location,
    async read() {
      // A backend chant cannot list holds the lock the caller names until the release ran.
      if (!checked) return released ? undefined : { ID: opts.lockId };
      if (!(await heldIds()).includes(opts.lockId)) return undefined;
      return (at.root ? diyStackLock(at.root, at.project, opts.stack, opts.lockId) : undefined) ?? { ID: opts.lockId };
    },
    async release() {
      const args = pulumiCancelArgs({ stack: opts.stack });
      try {
        await runGatedPulumi(opts.run ?? defaultPulumiRunner, args, dir);
      } catch (err) {
        throw new Error(`pulumi ${args.join(" ")} failed: ${why(err, "pulumi")}`);
      }
      released = true;
    },
  };
  const r = await releaseStateLock({
    subject: opts.stack,
    by: opts.by,
    lock,
    liveRuns: opts.liveRuns ?? forgeRuns(env, opts.forge),
    words: { op: opts.op ?? PULUMI_STACK_OPS_OP, kind: "stack-cancel" },
    ...(opts.commit ? { commit: opts.commit } : {}),
    ...gatedSettings(opts),
  });
  const request = await askedRequest(opts, "digest" in r ? r.digest : "", { kind: "stack-cancel", subject: opts.stack, by: opts.by, fields: { location, id: opts.lockId } });
  switch (r.status) {
    case "free":
      throw new PulumiStackOpRefused("lock-gone", `refusing to cancel stack ${opts.stack}: the approved lock ${opts.lockId} is gone; ask again for the lock it holds`);
    case "alive":
      throw new PulumiStackOpRefused("live-run", `a run that began before ${opts.lockId} was taken is alive, so it may hold the lock, and nothing was asked: ${r.alive.map(describeRun).join("; ")}`, { runs: r.alive });
    case "held":
      throw new PulumiStackOpRefused("held", `${r.reason}; the approval stands unspent, so run the cancel again once that run finished`, { digest: r.digest });
    case "waiting":
      return { status: "waiting", digest: r.digest, request, command: r.command };
    case "refused":
      return { status: "refused", digest: r.digest, request, by: r.by, reason: r.reason, command: r.command };
    case "spent":
      return { status: "spent", digest: r.digest, request };
    case "failed":
      return { status: "failed", digest: r.digest, request, error: r.error.message, recorded: r.recorded };
    case "released":
      return { status: "done", digest: r.digest, request, approvedBy: r.approvedBy, recorded: r.recorded, result: { lockChecked: checked, liveRuns: r.liveRuns } };
  }
}

// ── move ─────────────────────────────────────────────────────────────────

/** One side of a move. */
export interface PulumiMoveStack {
  /** The member's name, for messages and the record. */
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
  runId?: string;
  commit?: string;
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
 * Move resources between two stacks after an approval: core's
 * `runStateMigration` (#4808) with the two stacks as its roots. Each call
 * plans: both previews, plunge's plan on plunge, and each stack's export
 * digest as its state before. The request binds that plan. Approved, the
 * engine reads each export again and refuses a state that moved, runs
 * `pulumi state move` (plunge's marker move on plunge), and previews both
 * stacks again. A Pulumi move's new states are the engine's to write, so
 * each root's `after` digest binds what the move does to it (the stacks and
 * the URNs), not bytes. Pulumi takes each stack's lock inside the move
 * itself; chant takes none, and refuses while a `file://` backend shows
 * either stack locked. Refused before anything is asked for an empty or
 * non-URN list, two engines, or a plan that changes more than the move.
 */
export async function gatedStackMove(opts: PulumiStackMoveOptions): Promise<PulumiStackOpOutcome<PulumiStackMoveResult>> {
  const env = opts.env ?? process.env;
  if (opts.urns.length === 0 || !opts.urns.every((u) => u.startsWith("urn:pulumi:"))) throw new Error("a move names the source URNs it moves, each urn:pulumi:...");
  if (opts.source.member === opts.dest.member) throw new Error(`a move is between two members, and both sides are ${opts.source.member}`);
  const sourceDir = stackDirOf(opts.source.dir, opts.cwd);
  const destDir = stackDirOf(opts.dest.dir, opts.cwd);
  const engine = engineOf(sourceDir, opts.engine, env);
  const destEngine = engineOf(destDir, opts.engine, env);
  if (engine !== destEngine) throw new Error(`${opts.source.member} runs on ${engine} and ${opts.dest.member} on ${destEngine}; a move needs both stacks on one engine`);
  const urns = [...new Set(opts.urns)].sort();
  const runners = { ...(opts.run ? { run: opts.run } : {}), ...(opts.plunge ? { plunge: opts.plunge } : {}), engine };
  const sides = [
    { ...opts.source, dir: sourceDir },
    { ...opts.dest, dir: destDir },
  ];
  const side = (member: string) => sides.find((s) => s.member === member)!;

  const previews = async (): Promise<{ source: ChangeSetPart; dest: ChangeSetPart }> => {
    const [s, d] = await Promise.all(sides.map((x) => previewPulumiMemberRead({ member: x.member, dir: x.dir, stack: x.stack, ...runners })));
    for (const p of [s!.part, d!.part]) {
      if (p.member.status === "failed") throw new Error(`the preview of ${p.member.member} failed: ${p.member.error ?? "no error printed"}`);
    }
    return { source: s!.part, dest: d!.part };
  };

  // The plan: previews that change only the moved resources, plunge's own plan, each state's digest now.
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
  const digestOf = async (member: string): Promise<string> => sha256(await exportNow({ ...side(member), ...runners }));
  const move = { source: opts.source.stack, dest: opts.dest.stack, urns };
  const proof: MigrationCheck = { changes: [], summary: `the previews change only the ${urns.length} moved resource(s)` };
  const roots: MigrationRootPlan[] = [];
  for (const s of sides) {
    roots.push({ root: s.member, location: stackLocation(s.dir, s.stack, env), before: { digest: await digestOf(s.member) }, after: { digest: sha256(JSON.stringify({ root: s.member, move })) }, proof });
  }

  let outcome: unknown;
  const migration: StateMigrationEngine = {
    async lock() {
      for (const s of sides) {
        const locks = engine === "plunge" ? { checked: false, ids: [] } : await pulumiStackLockIds({ dir: s.dir, stack: s.stack.split("/").at(-1)!, engine, env });
        if (locks.ids.length > 0) throw new Error(`${s.member} holds lock ${locks.ids.join(", ")}: an update is running on it, so nothing was moved`);
      }
      return async () => undefined;
    },
    async current(root) {
      return { digest: await digestOf(root) };
    },
    async write() {
      if (engine === "plunge") {
        const args = plungeMoveArgs({ ...move, yes: true });
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
        return;
      }
      const args = pulumiStateMoveArgs(move);
      try {
        await runGatedPulumi(opts.run ?? defaultPulumiRunner, args, sourceDir);
      } catch (err) {
        throw new Error(`pulumi ${args.join(" ")} failed: ${why(err, "pulumi")}`);
      }
    },
    async verify(root) {
      const s = side(root);
      const { part } = await previewPulumiMemberRead({ member: s.member, dir: s.dir, stack: s.stack, ...runners });
      if (part.member.status === "failed") return { changes: [`the preview failed: ${part.member.error ?? "no error printed"}`], summary: "preview failed" };
      const changes = changing(part).map((e) => `${e.action} ${e.address}`);
      return { changes, summary: changes.length === 0 ? "no change" : `${changes.length} change(s)` };
    },
  };

  const subject = `move:${opts.source.stack}:${opts.dest.stack}`;
  const fields = { source: opts.source.stack, dest: opts.dest.stack, engine, urns: urns.join(",") };
  const r = await runStateMigration({
    name: subject,
    by: opts.by,
    roots,
    engine: migration,
    words: { op: opts.op ?? PULUMI_STACK_OPS_OP, kind: "stack-move" },
    fields,
    detail: (res) => ({ urns: urns.length, engine, afterNoChange: res.status === "applied" }),
    description: `move of ${urns.length} resource(s) from ${opts.source.stack} to ${opts.dest.stack}`,
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.commit ? { commit: opts.commit } : {}),
    ...gatedSettings(opts),
  });
  const request = await askedRequest(opts, "digest" in r ? r.digest : "", { kind: "stack-move", subject, by: opts.by, fields });
  switch (r.status) {
    case "proof-failed":
      throw new Error(`refusing to move: ${r.failing.join(", ")} plan changes`);
    case "waiting":
      return { status: "waiting", digest: r.digest, request, command: r.command };
    case "refused":
      return { status: "refused", digest: r.digest, request, by: r.by, reason: r.reason, command: r.command };
    case "spent":
      return { status: "spent", digest: r.digest, request };
    case "approval-moved":
      // An approval of an earlier request for these stacks stands, but their state moved since it (#4806), so it
      // doesn't count for this one, and this request waits for its own.
      return { status: "waiting", digest: r.digest, request, command: r.command };
    case "moved":
      return {
        status: "failed",
        digest: r.digest,
        request,
        check: "moved",
        recorded: r.recorded,
        error: `the state of ${(r.result.moved ?? []).join(", ")} changed since the plan, so nothing was moved; the approval is spent, so ask again for the stacks as they are now`,
      };
    case "failed": {
      const still = (r.result?.roots ?? []).flatMap((x) => (x.verify?.changes ?? []).map((c) => `${x.root}: ${c}`));
      return { status: "failed", digest: r.digest, request, recorded: r.recorded, error: still.length > 0 ? `the move ran, and the stacks still preview changes: ${still.join("; ")}` : r.error };
    }
    case "applied":
      return { status: "done", digest: r.digest, request, approvedBy: r.approvedBy, recorded: r.recorded, result: { engine, moved: urns, ...(outcome !== undefined ? { outcome } : {}) } };
  }
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
  // core's gatedOp (#4808); reuseApplied makes a retried call with the same request answer `spent`.
  const r = await gatedOp<{ result: PulumiStackActionResult; error?: string }>(
    {
      op: opts.op ?? PULUMI_STACK_OPS_OP,
      request: { kind: "stack-action", subject, by: opts.by, fields },
      description: `action ${opts.name ?? opts.urn} on stack ${opts.stack}: replace ${opts.urn}, requested by ${opts.by}`,
      ...(opts.anew ? {} : { reuseApplied: true }),
      ...gatedSettings(opts),
    },
    (async () => {
      const args = pulumiActionUpArgs(target);
      try {
        const done = engine === "plunge" ? await runGatedPlunge(opts.plunge ?? defaultPlungeRunner, args, dir) : await runGatedPulumi(opts.run ?? defaultPulumiRunner, args, dir);
        const tail = lastLines(done.stdout, 10);
        return { output: { result: { urn: opts.urn, engine, preview: digest, exit: 0, tail } }, detail: { result: "ok", exit: 0, tail: tail.slice(-400), urn: opts.urn } };
      } catch (err) {
        const f = pulumiRunFailure(err);
        const exit = f.exitCode ?? 1;
        const tail = lastLines(`${f.stdout ?? ""}\n${f.stderr ?? ""}`, 10);
        const error = `${engine} ${args.join(" ")} failed: ${why(err, engine)}`;
        return { output: { result: { urn: opts.urn, engine, preview: digest, exit, tail }, error }, detail: { result: "failed", exit, tail: tail.slice(-400), urn: opts.urn, error: error.slice(0, 400) }, failed: true };
      }
    }) as GatedOpAct<{ result: PulumiStackActionResult; error?: string }>,
  );
  switch (r.status) {
    case "waiting":
      return { status: "waiting", digest: r.digest, request: r.request, command: r.command };
    case "refused":
      return { status: "refused", digest: r.digest, request: r.request, by: r.by, reason: r.reason, command: r.command };
    case "spent":
      return { status: "spent", digest: r.digest, request: r.request };
    case "held":
      return { status: "failed", digest: r.digest, request: r.request, error: r.reason, recorded: false };
    case "failed":
      return { status: "failed", digest: r.digest, request: r.request, error: r.error.message, recorded: r.recorded };
    case "done":
      return r.output.error !== undefined
        ? { status: "failed", digest: r.digest, request: r.request, error: r.output.error, recorded: r.recorded }
        : { status: "done", digest: r.digest, request: r.request, result: r.output.result, approvedBy: r.approvedBy, recorded: r.recorded };
  }
}
