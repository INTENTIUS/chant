/**
 * Release trains (#2554, #2524 D19, ws-043): one record that pins a release
 * of every `chant` member, so several members move together.
 *
 * Releases stay per member (ws-043): each is a digest over its artifacts and
 * a git commit, written to the member's own ledger by `chant release cut`. A
 * train names one of them per member: by default the newest cut release, or
 * the one `--pin <member>=<label|digest>` picks. It refuses unless every
 * `chant` member of the declaration has a release, so a train never leaves a
 * member out. It is written to `_members/_workspace/<env>/trains.jsonl`, or
 * for a nested workspace inside its outer member's ledger
 * (`_members/<outer>/_members/_workspace/<env>/trains.jsonl`).
 *
 * A train's digest (#4037) is over the member release digests and nothing
 * else, so the same picks always give the same train digest, whatever the
 * environment, actor or time. The member releases are named, never copied
 * or changed.
 *
 * `chant workspace train promote <env>` (#4037) promotes a train: each
 * member's `chant components promote --to <env> --release <its digest>`,
 * under the member's own chant, producers first. With `--gate <name>`,
 * every member plans first (`--plan-only`), one workspace gate fact covers
 * each member's release gates with its change set and release, and nothing
 * deploys until `chant workspace run approve <name>` approves it. The
 * promote is a workspace run record that names the train.
 *
 * A train can pin `repo` members too (#5119): each one's releases are read
 * at its pinned revision through that repository's own `chant release list
 * --json`. A train of `repo` members is promoted from the control repo, one
 * member repository at a time: each call dispatches a member, or moves on
 * from its answer in `_control/applied.jsonl` (`--continue`). Each member
 * keeps its own gate (../control/train.ts has the jobs on both sides).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { CHANT_EXIT } from "../exit-codes";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { readAllReleases, readCuts } from "../lifecycle/release-store";
import { WORKSPACE_GATE_ENV, WORKSPACE_RUN_ENV } from "../op/workspace-run-env";
import type { WorkspaceGraph } from "./compose-graph";
import { readDeclaration, WorkspaceReadError, type RepoRef } from "./declaration";
import { REPO_KIND } from "./kinds";
import { locateWorkspace } from "./which-chant";
import { appendWorkspaceLine, appendWorkspaceRun, readWorkspaceLines, readWorkspaceRuns, type WorkspaceRunRecord, type WorkspaceRunStep } from "./workspace-ledger";
import { appendWorkspaceGatePending, readWorkspaceGate, workspaceGateDigest, type WorkspaceGateCover, type WorkspaceGatePending } from "./workspace-gates";
import type { MemberOpResult } from "./workspace-run";
import type { ControlAppliedRecord } from "../control/applied";
import type { TrainDispatch } from "../control/train";
import { actorFromEnv } from "../actor";

export interface TrainMember {
  member: string;
  releaseDigest: string;
  /** The release's git commit. */
  commit: string;
  /** The label its newest cut gave it, or null. */
  label: string | null;
  /**
   * For a member of kind `repo` (#5119): the other repository, its URL with
   * any credential removed, and the revision its releases were read at.
   * Absent for a `chant` member.
   */
  repo?: { url: string; rev: string };
}

export interface ReleaseTrainRecord {
  version: 1;
  id: string;
  env: string;
  timestamp: string;
  actor: string;
  /** Every `chant` member, by name. */
  members: TrainMember[];
  /**
   * {@link trainDigest} over `members` (#4037). Absent on a line written
   * before {@link TRAIN_PROMOTE_FLOOR}; {@link readReleaseTrains} computes it then.
   */
  trainDigest?: string;
}

/** A train as read back: its digest is always there. */
export type ReadTrain = ReleaseTrainRecord & { trainDigest: string };

/**
 * The digest of a train (#4037): over each member's name and release digest,
 * sorted by member. The commit and the label are the release's own, and the
 * release digest already covers the commit, so they stay out, as do the
 * environment, the id, the actor and the time.
 */
export function trainDigest(members: readonly Pick<TrainMember, "member" | "releaseDigest">[]): string {
  const subject = [...members]
    .map((m) => ({ member: m.member, releaseDigest: m.releaseDigest }))
    .sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
  return computePlanDigest("release-train", { members: subject });
}

const TRAINS_FILE = "trains.jsonl";

/** What one member offers a train: its releases, newest cut first. */
export interface MemberReleases {
  member: string;
  releases: TrainMember[];
  /** Why the member's releases could not be read (#5119), which stops the train. */
  problem?: string;
  /** For a `repo` member: where its releases are cut, for the message when it has none. */
  repo?: string;
}

/**
 * Pick each member's release, pure. `pins` maps a member to a label or a
 * digest; a member with no pin takes its newest. Returns the members, or
 * the problems that stop the train.
 */
export function pickTrain(members: readonly MemberReleases[], pins: ReadonlyMap<string, string> = new Map()): { members: TrainMember[] } | { problems: string[] } {
  const problems: string[] = [];
  const picked: TrainMember[] = [];
  for (const name of pins.keys()) {
    if (!members.some((m) => m.member === name)) problems.push(`--pin ${name}: not a chant or repo member of the workspace`);
  }
  for (const m of members) {
    if (m.problem !== undefined) {
      problems.push(`member ${m.member}: ${m.problem}`);
      continue;
    }
    const pin = pins.get(m.member);
    const r = pin === undefined ? m.releases[0] : m.releases.find((x) => x.releaseDigest === pin || x.label === pin);
    if (!r) {
      const where = m.repo !== undefined ? `in ${m.repo}` : "in its directory";
      problems.push(pin === undefined ? `member ${m.member} has no release; cut one with chant release cut ${where}` : `member ${m.member} has no release ${pin}`);
      continue;
    }
    picked.push(r);
  }
  // #4037: a train names at least one release, so its digest never covers nothing.
  if (members.length === 0) problems.push("the workspace declares no chant or repo member, so a train has nothing to pin");
  return problems.length > 0 ? { problems } : { members: picked };
}

/** Reads one `repo` member's releases (#5119); {@link readRepoReleases} unless a test passes its own. */
export type RepoReleasesReader = (member: string, ref: RepoRef, workspaceRoot: string) => Promise<MemberReleases>;

/**
 * Every `chant` member's releases, newest cut first, read from its ledger,
 * and every `repo` member's, read through that repository's own
 * `chant release list --json` at its pinned revision (#5119).
 */
export async function readMemberReleases(cwd: string, opts: { readRepo?: RepoReleasesReader } = {}): Promise<MemberReleases[]> {
  const located = locateWorkspace(cwd);
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  const out: MemberReleases[] = [];
  // #5136: in a nested workspace each member's ledger sits inside the outer member's.
  const { resolveMemberLedger } = await import("../lifecycle/member-ledger");
  const outer = (await resolveMemberLedger(located.rootOnDisk)).members;
  for (const m of declaration.members) {
    if (m.kind === REPO_KIND && m.repo !== null) {
      out.push(await (opts.readRepo ?? readRepoReleases)(m.name, m.repo, located.rootOnDisk));
      continue;
    }
    if (m.kind !== "chant") continue;
    const loc = { cwd: located.rootOnDisk, member: m.dir === "." ? outer : [...outer, m.name] };
    const { releases } = await readAllReleases(loc);
    const { cuts } = await readCuts(loc);
    const newest = (digest: string) => cuts.filter((c) => c.releaseDigest === digest).map((c) => c.timestamp).sort().at(-1) ?? "";
    const label = (digest: string) => cuts.filter((c) => c.releaseDigest === digest && c.label !== null).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)).at(-1)?.label ?? null;
    const list = releases
      .filter((r) => newest(r.releaseDigest) !== "")
      .sort((a, b) => (newest(b.releaseDigest) < newest(a.releaseDigest) ? -1 : newest(b.releaseDigest) > newest(a.releaseDigest) ? 1 : 0))
      .map((r) => ({ member: m.name, releaseDigest: r.releaseDigest, commit: r.commit, label: label(r.releaseDigest) }));
    out.push({ member: m.name, releases: list });
  }
  return out;
}

/** Starts one chant command in `cwd` and gives back what it printed. */
function spawnChant(command: readonly string[], argv: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [bin, ...pre] = command;
  return new Promise((done) => {
    const child = spawn(bin!, [...pre, ...argv], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => done({ exitCode: 127, stdout: "", stderr: `could not start ${bin}: ${e.message}` }));
    child.on("close", (code) => done({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

/**
 * The releases of a `repo` member (#5119), read the way its graph is read
 * (#3168): chant fetches the pinned revision into the user's cache, brings
 * that repository's `chant/lifecycle` into the cache clone, and runs
 * `chant release list --json` in the workspace root at the revision, under
 * the chant that resolves there. Nothing is written in the other
 * repository. A read that fails says why, and stops the train.
 */
export async function readRepoReleases(member: string, ref: RepoRef, workspaceRoot: string, opts: { env?: NodeJS.ProcessEnv; command?: readonly string[] } = {}): Promise<MemberReleases> {
  const { fetchRepoAt, fetchRepoLifecycle, redactUrl } = await import("./repo-ref");
  const url = redactUrl(ref.url);
  const base = { member, releases: [] as TrainMember[], repo: url };
  const fetched = fetchRepoAt(ref, workspaceRoot, opts.env);
  if (!fetched.ok) return { ...base, problem: fetched.message };
  const lifecycle = fetchRepoLifecycle(ref, workspaceRoot, opts.env);
  if (!lifecycle.ok) return { ...base, problem: lifecycle.message };
  const { resolveToolchain } = await import("./member-commands");
  const command = opts.command ?? resolveToolchain(fetched.dir, fetched.worktree).command;
  const r = await spawnChant(command, ["release", "list", "--json"], fetched.dir);
  type Printed = { $schema?: unknown; error?: { code?: unknown; message?: unknown }; releases?: unknown };
  let doc: Printed | null;
  try {
    doc = JSON.parse(r.stdout) as Printed;
  } catch {
    doc = null;
  }
  const { RELEASES_SCHEMA_ID } = await import("./releases");
  if (!doc || doc.$schema !== RELEASES_SCHEMA_ID) {
    const tail = r.stderr.trim().split("\n").slice(-3).join("; ");
    return { ...base, problem: `chant release list in ${url} at ${ref.rev.slice(0, 12)} exited ${r.exitCode} and printed no releases document${tail ? `: ${tail}` : ""}` };
  }
  if (doc.error) return { ...base, problem: `chant release list in ${url} at ${ref.rev.slice(0, 12)}: ${String(doc.error.code)}: ${String(doc.error.message)}` };
  const entries = Array.isArray(doc.releases) ? (doc.releases as Array<{ releaseDigest?: unknown; commit?: unknown; label?: unknown; cuts?: unknown }>) : [];
  const releases: TrainMember[] = [];
  // The document lists the newest cut first; a release no cut names comes last and is not one a train takes.
  for (const e of entries) {
    if (typeof e.releaseDigest !== "string" || typeof e.commit !== "string" || !Array.isArray(e.cuts) || e.cuts.length === 0) continue;
    releases.push({ member, releaseDigest: e.releaseDigest, commit: e.commit, label: typeof e.label === "string" ? e.label : null, repo: { url, rev: ref.rev } });
  }
  return { ...base, releases };
}

function isTrain(v: unknown): v is ReleaseTrainRecord {
  const t = v as ReleaseTrainRecord;
  return typeof t === "object" && t !== null && t.version === 1 && typeof t.id === "string" && typeof t.env === "string" && Array.isArray(t.members);
}

export async function readReleaseTrains(cwd: string, env: string): Promise<{ records: ReadTrain[]; malformed: number }> {
  const { records, malformed } = await readWorkspaceLines(cwd, env, TRAINS_FILE, isTrain);
  return { records: records.map((t) => ({ ...t, trainDigest: t.trainDigest ?? trainDigest(t.members) })), malformed };
}

/** The train `ref` names, by id or digest, else the newest. Null when there is none. */
export function findTrain(trains: readonly ReadTrain[], ref?: string): ReadTrain | null {
  if (ref === undefined) return trains.at(-1) ?? null;
  return trains.filter((t) => t.id === ref || t.trainDigest === ref).at(-1) ?? null;
}

export async function appendReleaseTrain(cwd: string, record: ReleaseTrainRecord): Promise<string> {
  return appendWorkspaceLine(cwd, record.env, TRAINS_FILE, record, `Release train: ${record.env} ${record.id}`);
}

/** The first chant that writes {@link ReleaseTrainRecord.trainDigest} and has `chant workspace train promote` (#4037). */
export const TRAIN_PROMOTE_FLOOR = "0.124.98";

// ── Promote ──────────────────────────────────────────────────────────────────

/** What a step of a train's promote runs in each member: `chant components promote`. */
export const TRAIN_STEP_OP = "components promote";

/** What `components promote --plan-only --json` prints (#4037). */
export interface MemberReleasePlan {
  env: string;
  releaseDigest: string;
  label: string | null;
  /** The ledger the member's release gates are recorded in. */
  op: string;
  /** The release gates the promoted compositions declare; empty when none does. */
  gates: string[];
  /** The change-set document's digest, or null when there is no gate to bind it. */
  changeSet: string | null;
  empty: boolean | null;
  components: string[];
}

function isMemberReleasePlan(v: unknown): v is MemberReleasePlan {
  const p = v as MemberReleasePlan;
  return typeof p === "object" && p !== null && typeof p.releaseDigest === "string" && typeof p.op === "string" && Array.isArray(p.gates) && (p.changeSet === null || typeof p.changeSet === "string");
}

/**
 * The covers a workspace gate needs for one member's release (#4037): one
 * per release gate, bound to the member's change set, the environment and
 * the release. None for an empty change set, which passes without an
 * approval, nor for a promote that declares no gate.
 */
export function releaseCovers(member: string, env: string, plan: MemberReleasePlan): WorkspaceGateCover[] {
  if (plan.changeSet === null || plan.empty === true) return [];
  return plan.gates.map((gate) => ({ member, op: plan.op, gate, planDigest: plan.changeSet!, environment: env, releaseDigest: plan.releaseDigest }));
}

export interface TrainPromoteQuery {
  /** The workspace root. */
  cwd: string;
  env: string;
  /** The train, by id or digest; the newest for `env` when absent. */
  train?: string;
  /** The workspace gate every member's release gates wait on together. */
  gate?: string;
  dryRun?: boolean;
  /** Overrides, for tests. */
  readGraph?: (cwd: string) => Promise<{ graph: WorkspaceGraph; failed: boolean } | { error: string }>;
  runMember?: (member: { name: string; dir: string }, argv: string[], env: Record<string, string>) => Promise<MemberOpResult>;
  now?: () => string;
  onOutput?: (target: string, result: MemberOpResult) => void;
  /**
   * A train of `repo` members (#5119): advance the promote in flight from
   * the answers the control repo recorded, and start nothing new.
   */
  continue?: boolean;
  /** Sends one dispatch into a member repository (#5119); {@link defaultTrainDispatcher} unless a test passes its own. */
  dispatch?: TrainDispatcher;
  /** The control repo's apply records (#5119), read from `_control/applied.jsonl` unless a test passes its own. */
  readAnswers?: (cwd: string) => Promise<ControlAppliedRecord[]>;
  /** The member links a train across repositories orders by (#5119), from the declaration unless a test passes its own. */
  readLinks?: (cwd: string) => Promise<WorkspaceGraph["links"]>;
}

/** Sends one dispatch into a member repository: the member, its repository's URL, and what the dispatch carries. Throws when it was not taken. */
export type TrainDispatcher = (member: { name: string; repo: string }, d: TrainDispatch) => Promise<void>;

export type TrainPromoteOutcome =
  | { kind: "refused"; message: string }
  | { kind: "planned"; train: ReadTrain; order: string[] }
  | { kind: "ran"; train: ReadTrain; record: WorkspaceRunRecord; pending: WorkspaceGatePending | null; approved: string | null; ledgerError: string | null }
  /** #5119: the promote in flight waits on `member`'s answer, and nothing was written. */
  | { kind: "waiting"; train: ReadTrain; record: WorkspaceRunRecord; member: string }
  /** #5119: `--continue` found no promote of the train in flight. */
  | { kind: "idle"; train: ReadTrain; message: string };

const promoteArgv = (env: string, m: TrainMember, extra: string[] = []) => ["components", "promote", "--to", env, "--release", m.releaseDigest, ...extra, "--json"];

/** The JSON a member's promote printed, or null. */
function parseJson(stdout: string): unknown {
  const at = stdout.indexOf("{");
  if (at < 0) return null;
  try {
    return JSON.parse(stdout.slice(at)) as unknown;
  } catch {
    return null;
  }
}

/** The member run and the gate a member's `promote --json` output names. */
function promoteOutcome(stdout: string): { run: string | null; gate?: WorkspaceRunStep["gate"] } {
  const doc = parseJson(stdout) as { recorded?: Array<{ runId?: unknown }>; run?: { gate?: { op?: unknown; gate?: unknown; planDigest?: unknown; environment?: unknown } } } | null;
  const runId = doc?.recorded?.find((r) => typeof r.runId === "string")?.runId;
  const g = doc?.run?.gate;
  return {
    run: typeof runId === "string" ? runId : null,
    ...(g && typeof g.gate === "string"
      ? { gate: { op: typeof g.op === "string" ? g.op : TRAIN_STEP_OP, name: g.gate, planDigest: typeof g.planDigest === "string" ? g.planDigest : null, environment: typeof g.environment === "string" ? g.environment : null } }
      : {}),
  };
}

/**
 * Promote a release train (#4037). Each member's release is promoted with
 * `chant components promote --to <env> --release <digest>` under its own
 * chant, producers first, stopping at the first member that does not pass.
 *
 * With a workspace gate, each member plans first and deploys nothing; the
 * covers of every member's release gates are recorded as one pending fact
 * naming the train, and the run ends gated. Once an approval of exactly
 * those covers stands, the same call promotes every member under the gate,
 * so each release gate takes the approval in place of its own where the
 * member opts in at base. A member whose plan moved since then plans a
 * change set the approval does not cover, and stops at its own gate.
 */
export async function promoteTrain(query: TrainPromoteQuery): Promise<TrainPromoteOutcome> {
  const now = query.now ?? (() => new Date().toISOString());
  const { records } = await readReleaseTrains(query.cwd, query.env);
  const train = findTrain(records, query.train);
  if (!train) {
    return {
      kind: "refused",
      message: query.train === undefined ? `no release train is recorded for ${query.env}; record one with chant workspace train ${query.env}` : `no release train ${query.train} is recorded for ${query.env}`,
    };
  }
  if (train.members.length === 0) return { kind: "refused", message: `release train ${train.id} pins no member, so there is nothing to promote` };
  const across = train.members.filter((m) => m.repo !== undefined);
  if (across.length > 0) {
    if (across.length < train.members.length) {
      return { kind: "refused", message: `release train ${train.id} pins repo members (${across.map((m) => m.member).join(", ")}) and chant members (${train.members.filter((m) => !m.repo).map((m) => m.member).join(", ")}); a promote runs chant members here and dispatches repo members, so record a train of one kind` };
    }
    return promoteAcrossRepos(query, train, now);
  }
  if (query.continue) return { kind: "refused", message: "--continue advances a train of repo members, and this train pins chant members" };

  const { defaultReadGraph, defaultRunMember, orderTargets } = await import("./workspace-run");
  const read = await (query.readGraph ?? defaultReadGraph)(query.cwd);
  if ("error" in read) return { kind: "refused", message: `the workspace graph could not be read: ${read.error}` };
  const { graph } = read;
  const missing = train.members.filter((m) => !graph.members.some((g) => g.name === m.member && g.status === "composed"));
  if (missing.length > 0) return { kind: "refused", message: `release train ${train.id} pins ${missing.map((m) => m.member).join(", ")}, which the workspace graph does not compose` };

  const order = orderTargets(train.members.map((m) => ({ member: m.member, op: TRAIN_STEP_OP })), graph.links).map((t) => train.members.find((m) => m.member === t.member)!);
  if (query.dryRun) return { kind: "planned", train, order: order.map((m) => m.member) };

  const id = `ws-${randomUUID()}`;
  const started = now();
  const citation = { id: train.id, digest: train.trainDigest };
  const steps: WorkspaceRunStep[] = order.map((m) => ({ target: `${m.member}/${TRAIN_STEP_OP}`, member: m.member, op: TRAIN_STEP_OP, status: "not-run", exitCode: null, memberRun: null }));
  const runMember = query.runMember ?? ((m, argv, e) => defaultRunMember(query.cwd, m, argv, e));
  const dirOf = (member: string) => graph.members.find((g) => g.name === member)!.dir;
  const finish = async (status: WorkspaceRunRecord["status"], pending: WorkspaceGatePending | null, approved: string | null, gatherCovers?: WorkspaceGateCover[]): Promise<TrainPromoteOutcome> => {
    const record: WorkspaceRunRecord = { version: 1, id, started, ended: now(), status, env: query.env, gate: query.gate ?? null, dependentsOf: null, steps, train: citation };
    let written = pending;
    let ledgerError: string | null = null;
    try {
      if (gatherCovers && query.gate && !written) written = await appendWorkspaceGatePending(query.cwd, { gate: query.gate, run: id, timestamp: record.ended, covers: gatherCovers, train: citation });
      await appendWorkspaceRun(query.cwd, record);
    } catch (err) {
      ledgerError = err instanceof Error ? err.message : String(err);
    }
    return { kind: "ran", train, record, pending: written, approved, ledgerError };
  };

  // With a workspace gate: every member plans before any deploys.
  let approved: string | null = null;
  if (query.gate) {
    const covers: WorkspaceGateCover[] = [];
    for (let i = 0; i < order.length; i++) {
      const m = order[i]!;
      const step = steps[i]!;
      const result = await runMember({ name: m.member, dir: dirOf(m.member) }, promoteArgv(query.env, m, ["--plan-only"]), { [WORKSPACE_RUN_ENV]: id });
      query.onOutput?.(`${step.target} --plan-only`, result);
      const plan = parseJson(result.stdout);
      if (result.exitCode !== 0 || !isMemberReleasePlan(plan) || plan.releaseDigest !== m.releaseDigest) {
        step.status = "fail";
        step.exitCode = result.exitCode;
        return finish("fail", null, null);
      }
      covers.push(...releaseCovers(m.member, query.env, plan));
    }
    if (covers.length > 0) {
      const digest = workspaceGateDigest(covers);
      const { pending, approvals } = await readWorkspaceGate(query.cwd, query.gate);
      if (approvals.some((a) => a.digest === digest && workspaceGateDigest(a.covers) === digest)) {
        approved = digest;
      } else {
        // Nothing deployed; each member with a cover waits on the workspace gate.
        for (const step of steps) {
          const c = covers.find((x) => x.member === step.member);
          if (c) step.gate = { op: c.op, name: c.gate, planDigest: c.planDigest, environment: c.environment ?? null };
          step.status = c ? "gated" : "not-run";
        }
        const standing = pending.filter((p) => p.digest === digest).at(-1) ?? null;
        return finish("gated", standing, null, covers);
      }
    }
  }

  const env: Record<string, string> = { [WORKSPACE_RUN_ENV]: id, ...(query.gate ? { [WORKSPACE_GATE_ENV]: query.gate } : {}) };
  let status: WorkspaceRunRecord["status"] = "ok";
  for (let i = 0; i < order.length; i++) {
    const m = order[i]!;
    const step = steps[i]!;
    const result = await runMember({ name: m.member, dir: dirOf(m.member) }, promoteArgv(query.env, m), env);
    query.onOutput?.(step.target, result);
    step.exitCode = result.exitCode;
    step.status = result.exitCode === 0 ? "ok" : result.exitCode === CHANT_EXIT.waiting ? "gated" : "fail";
    const found = promoteOutcome(result.stdout);
    step.memberRun = found.run;
    if (found.gate) step.gate = found.gate;
    if (step.status !== "ok") {
      status = step.status;
      break;
    }
  }
  return finish(status, null, approved);
}

// ── Across repositories (#5119) ──────────────────────────────────────────────

/** What a step of a train's promote across repositories runs in the member repository: its train job's `chant run --release`. */
export const TRAIN_REPO_STEP_OP = "run --release";

/** The answers after which the next member is dispatched. */
const TRAIN_PASSES: readonly string[] = ["applied", "unchanged"];

/** The member links in the declaration: producer to consumer, which a promote across repositories orders by. */
async function declarationLinks(cwd: string): Promise<WorkspaceGraph["links"]> {
  const declaration = readDeclaration(locateWorkspace(cwd).tree, "", { rootChant: true });
  return declaration.members.flatMap((m) => m.links.map((l) => ({ consumer: m.name, producer: l.member, status: "declared" }))) as unknown as WorkspaceGraph["links"];
}

/** Dispatches with the forge's API and the member's token from the environment ({@link trainTokenEnv}). */
export const defaultTrainDispatcher: TrainDispatcher = async (member, d) => {
  const { dispatchTrainMember, trainMemberTarget, trainProductOf } = await import("../control/train");
  await dispatchTrainMember(trainMemberTarget(member.repo), d, { words: trainProductOf() });
};

async function defaultReadAnswers(cwd: string): Promise<ControlAppliedRecord[]> {
  const { gitControlAppliedLedger, parseControlApplied } = await import("../control/applied");
  return parseControlApplied(await gitControlAppliedLedger({ cwd }).read()).records;
}

/** Each run's newest line: a promote across repositories appends its run again as each member answers. */
export function latestRuns(runs: readonly WorkspaceRunRecord[]): WorkspaceRunRecord[] {
  const at = new Map<string, number>();
  runs.forEach((r, i) => at.set(r.id, i));
  return runs.filter((r, i) => at.get(r.id) === i);
}

/**
 * Promote a train of `repo` members (#5119) from the control repo, one
 * member repository at a time, producers first. Each call does one step and
 * returns:
 *
 * - With no promote of the train in flight, it starts one: a workspace run
 *   record citing the train, and a dispatch into the first member
 *   repository, whose step is `dispatched`. `--continue` starts nothing.
 * - With one in flight, `--continue` reads the control repo's apply records
 *   for the member it waits on. `applied` or `unchanged` passes the step
 *   and dispatches the next member, or ends the run `ok`. `waiting` ends it
 *   `gated` at the member's own gate, and `failed` or `partial` ends it
 *   `fail`, the step saying why. An answer for another release fails the
 *   step. With no answer yet nothing is written. Without `--continue` it
 *   refuses, naming the member it waits on.
 *
 * Each member keeps its own gate: no workspace gate covers members in other
 * repositories, so `--gate` is refused.
 */
async function promoteAcrossRepos(query: TrainPromoteQuery, train: ReadTrain, now: () => string): Promise<TrainPromoteOutcome> {
  if (query.gate) return { kind: "refused", message: `release train ${train.id} pins repo members, and each keeps its own gate: a workspace gate covers members of this repository only, so drop --gate` };
  const { orderTargets } = await import("./workspace-run");
  const links = await (query.readLinks ?? declarationLinks)(query.cwd);
  const order = orderTargets(train.members.map((m) => ({ member: m.member, op: TRAIN_REPO_STEP_OP })), links).map((t) => train.members.find((m) => m.member === t.member)!);
  if (query.dryRun) return { kind: "planned", train, order: order.map((m) => m.member) };

  const runs = latestRuns((await readWorkspaceRuns(query.cwd, query.env)).records).filter((r) => r.train?.id === train.id);
  const inFlight = runs.filter((r) => r.status === "dispatched").at(-1) ?? null;
  if (!inFlight && query.continue) return { kind: "idle", train, message: `no promote of release train ${train.id} to ${query.env} is in flight, so there is nothing to continue` };
  if (inFlight && !query.continue) {
    const waiting = inFlight.steps.find((s) => s.status === "dispatched")?.member ?? "a member";
    return { kind: "refused", message: `promote ${inFlight.id} of release train ${train.id} is in flight and waits on ${waiting}; it continues when that member answers (chant workspace train promote ${query.env} ${train.id} --continue)` };
  }

  const dispatch = query.dispatch ?? defaultTrainDispatcher;
  const record: WorkspaceRunRecord = inFlight
    ? { ...inFlight, steps: inFlight.steps.map((s) => ({ ...s })) }
    : {
        version: 1,
        id: `ws-${randomUUID()}`,
        started: now(),
        ended: now(),
        status: "dispatched",
        env: query.env,
        gate: null,
        dependentsOf: null,
        steps: order.map((m) => ({ target: `${m.member}/${TRAIN_REPO_STEP_OP}`, member: m.member, op: TRAIN_REPO_STEP_OP, status: "not-run", exitCode: null, memberRun: null, repo: m.repo!.url })),
        train: { id: train.id, digest: train.trainDigest },
      };
  const memberOf = (name: string) => train.members.find((m) => m.member === name)!;

  /** Dispatch the first step not run yet, or end the run ok when none is left. */
  const next = async (): Promise<void> => {
    const step = record.steps.find((s) => s.status === "not-run");
    if (!step) {
      record.status = "ok";
      return;
    }
    const m = memberOf(step.member);
    try {
      await dispatch({ name: m.member, repo: m.repo!.url }, { member: m.member, env: query.env, train: train.id, run: record.id, releaseDigest: m.releaseDigest, commit: m.commit });
      step.status = "dispatched";
      record.status = "dispatched";
    } catch (err) {
      step.status = "fail";
      step.reason = `the dispatch into ${m.repo!.url} was not taken: ${err instanceof Error ? err.message : String(err)}`;
      record.status = "fail";
    }
  };

  if (!inFlight) await next();
  else {
    const step = record.steps.find((s) => s.status === "dispatched");
    if (!step) return { kind: "idle", train, message: `promote ${record.id} of release train ${train.id} waits on no member` };
    const answers = (await (query.readAnswers ?? defaultReadAnswers)(query.cwd)).filter((a) => a.member === step.member && a.train?.train === train.id && a.train.run === record.id);
    const answer = answers.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
    if (!answer) return { kind: "waiting", train, record: inFlight!, member: step.member };
    const m = memberOf(step.member);
    step.outcome = answer.outcome;
    if (answer.train!.releaseDigest !== m.releaseDigest || answer.train!.env !== query.env) {
      step.status = "fail";
      step.reason = `${step.member} answered for release ${answer.train!.releaseDigest} in ${answer.train!.env}, and the train pins ${m.releaseDigest} in ${query.env}`;
      record.status = "fail";
    } else if (TRAIN_PASSES.includes(answer.outcome)) {
      step.status = "ok";
      await next();
    } else {
      step.status = answer.outcome === "waiting" ? "gated" : "fail";
      step.reason = answer.outcome === "waiting" ? `${step.member}'s run waits at its own gate; approve it there, then promote the train again` : `${step.member}'s run ended ${answer.outcome} at ${answer.sha.slice(0, 12)}`;
      record.status = answer.outcome === "waiting" ? "gated" : "fail";
    }
  }
  record.ended = now();
  let ledgerError: string | null = null;
  try {
    await appendWorkspaceRun(query.cwd, record);
  } catch (err) {
    ledgerError = err instanceof Error ? err.message : String(err);
  }
  return { kind: "ran", train, record, pending: null, approved: null, ledgerError };
}

const USAGE =
  "chant workspace train <env> [--pin <member>=<label|digest>]... [--dry-run] [--json] | chant workspace train list <env> [--json] | chant workspace train promote <env> [<train id|digest>] [--gate <name>] [--continue] [--dry-run] [--json] | chant workspace train cut <env> [--at <sha>] [--levels <levels>] [--doctor] [--yes] [--no-push] [--json] | chant workspace train prepare <env> [<train id|digest>] [--json] | chant workspace train artifacts <env> [<train id|digest>] [--from <dir>] [-o <dir>] [--no-build] [--json] | chant workspace train verify <env> [<train id|digest>] [--json] | chant workspace train publish <env> [<train id|digest>] [--yes] [--json]";

/** The workspace runs that promoted each train, as `train list --json` gives them (#4037). */
export interface TrainPromotion {
  run: string;
  started: string;
  ended: string;
  status: WorkspaceRunRecord["status"];
  gate: string | null;
  /** Each member's step; a step in another repository (#5119) names it, with the member's answer and why a step did not pass. */
  members: Array<{ member: string; status: WorkspaceRunStep["status"]; memberRun: string | null; repo?: string; outcome?: string; reason?: string }>;
}

/** Each train with the runs that promoted it, oldest first. */
export function trainsWithPromotions(trains: readonly ReadTrain[], runs: readonly WorkspaceRunRecord[]): Array<ReadTrain & { promotions: TrainPromotion[] }> {
  const latest = latestRuns(runs);
  return trains.map((t) => ({
    ...t,
    promotions: latest
      .filter((r) => r.train?.id === t.id)
      .map((r) => ({
        run: r.id,
        started: r.started,
        ended: r.ended,
        status: r.status,
        gate: r.gate,
        members: r.steps.map((s) => ({ member: s.member, status: s.status, memberRun: s.memberRun, ...(s.repo !== undefined ? { repo: s.repo } : {}), ...(s.outcome !== undefined ? { outcome: s.outcome } : {}), ...(s.reason !== undefined ? { reason: s.reason } : {}) })),
      })),
  }));
}

export async function runWorkspaceTrain(ctx: CommandContext): Promise<number> {
  const words = ctx.args.positionals ?? [];
  const rest = words[0] === "train" ? words.slice(1) : words;
  if (rest[0] === "promote") return runTrainPromote(ctx, rest.slice(1));
  if (rest[0] === "cut") {
    const { runTrainCut } = await import("./train-cut");
    return runTrainCut(ctx, rest.slice(1));
  }
  if (rest[0] === "prepare") {
    const { runTrainPrepare } = await import("./train-prepare");
    return runTrainPrepare(ctx, rest.slice(1));
  }
  if (rest[0] === "artifacts" || rest[0] === "verify") {
    const m = await import("./train-artifacts");
    return rest[0] === "artifacts" ? m.runTrainArtifacts(ctx, rest.slice(1)) : m.runTrainVerify(ctx, rest.slice(1));
  }
  if (rest[0] === "publish") {
    const { runTrainPublish } = await import("./train-publish");
    return runTrainPublish(ctx, rest.slice(1));
  }
  const listing = rest[0] === "list";
  const env = listing ? rest[1] : rest[0];
  if (!env) {
    console.error(formatError({ message: "chant workspace train needs an environment", hint: USAGE }));
    return 1;
  }
  const cwd = resolve(".");
  try {
    if (listing) {
      const root = locateWorkspace(cwd).rootOnDisk;
      const { records } = await readReleaseTrains(root, env);
      const listed = trainsWithPromotions(records, (await readWorkspaceRuns(root, env)).records);
      if (ctx.args.json) console.log(JSON.stringify({ env, trains: listed }, null, 2));
      else if (listed.length === 0) console.log(`No release train recorded for ${env}.`);
      else {
        for (const t of listed) {
          const last = t.promotions.at(-1);
          console.log(`${t.timestamp}  ${t.id}  ${t.trainDigest}  ${t.members.map((m) => `${m.member}@${m.label ?? m.releaseDigest.slice(0, 19)}`).join(" ")}${last ? `  promoted: ${last.status}` : ""}`);
        }
      }
      return 0;
    }
    const pins = new Map<string, string>();
    for (const p of ctx.args.pins ?? []) {
      const at = p.indexOf("=");
      if (at <= 0) {
        console.error(formatError({ message: `--pin ${p}: expected <member>=<label|digest>`, hint: USAGE }));
        return 1;
      }
      pins.set(p.slice(0, at), p.slice(at + 1));
    }
    const root = locateWorkspace(cwd).rootOnDisk;
    const picked = pickTrain(await readMemberReleases(root), pins);
    if ("problems" in picked) {
      console.error(formatError({ message: `no release train for ${env}: every chant and repo member needs a release`, hint: USAGE }));
      for (const p of picked.problems) console.error(`  ${p}`);
      return 1;
    }
    const actor = ctx.args.actor ?? actorFromEnv();
    const record: ReleaseTrainRecord = { version: 1, id: `train-${randomUUID()}`, env, timestamp: new Date().toISOString(), actor, members: picked.members, trainDigest: trainDigest(picked.members) };
    if (!ctx.args.dryRun) await appendReleaseTrain(root, record);
    if (ctx.args.json) console.log(JSON.stringify({ ...record, written: !ctx.args.dryRun }, null, 2));
    else {
      console.log(`${ctx.args.dryRun ? "Would record" : "Recorded"} release train ${record.id} for ${env}, digest ${record.trainDigest}:`);
      for (const m of record.members) console.log(`  ${m.member.padEnd(24)} ${m.label ?? "(no label)"}  ${m.releaseDigest}  ${m.commit.slice(0, 12)}${m.repo ? `  ${m.repo.url}` : ""}`);
    }
    return 0;
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: USAGE }));
    return 1;
  }
}

async function runTrainPromote(ctx: CommandContext, words: string[]): Promise<number> {
  const [env, ref] = words;
  if (!env) {
    console.error(formatError({ message: "chant workspace train promote needs an environment", hint: USAGE }));
    return 1;
  }
  const cwd = resolve(".");
  // The root's chant promotes the train (ws-021), as it runs a workspace run.
  const { handToRootChant } = await import("./which-chant");
  const handed = await handToRootChant(cwd, undefined);
  if (handed !== undefined) return handed;
  const { args } = ctx;
  let outcome: TrainPromoteOutcome;
  try {
    outcome = await promoteTrain({
      cwd: locateWorkspace(cwd).rootOnDisk,
      env,
      ...(ref !== undefined ? { train: ref } : {}),
      ...(args.gate !== undefined ? { gate: args.gate } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
      ...(args.continueTrain ? { continue: true } : {}),
      onOutput: args.json
        ? undefined
        : (target, r) => {
            process.stderr.write(`── ${target} (exit ${r.exitCode})\n`);
            if (r.stderr) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
          },
    });
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: USAGE }));
    return 1;
  }
  if (outcome.kind === "refused") {
    if (args.json) console.log(JSON.stringify({ status: "refused", message: outcome.message }, null, 2));
    console.error(formatError({ message: outcome.message, hint: USAGE }));
    return 1;
  }
  if (outcome.kind === "idle") {
    if (args.json) console.log(JSON.stringify({ status: "idle", train: outcome.train.id, message: outcome.message }, null, 2));
    else console.log(outcome.message);
    return 0;
  }
  if (outcome.kind === "waiting") {
    if (args.json) console.log(JSON.stringify({ ...outcome.record, waitingOn: outcome.member }, null, 2));
    else console.log(`release train ${outcome.train.id} to ${env}: promote ${outcome.record.id} waits on ${outcome.member}, which has not answered yet`);
    return 0;
  }
  if (outcome.kind === "planned") {
    if (args.json) console.log(JSON.stringify({ status: "planned", train: outcome.train, order: outcome.order }, null, 2));
    else {
      console.log(`chant workspace train promote would promote ${outcome.train.id} (${outcome.train.trainDigest}) to ${env}, in order:`);
      for (const member of outcome.order) {
        const m = outcome.train.members.find((x) => x.member === member)!;
        console.log(`  ${member.padEnd(24)} ${m.label ?? "(no label)"}  ${m.releaseDigest}`);
      }
    }
    return 0;
  }
  const { record, pending, approved, ledgerError } = outcome;
  if (args.json) console.log(JSON.stringify({ ...record, pending, approved, ledgerError }, null, 2));
  else {
    console.log(`release train ${outcome.train.id} to ${env}: ${record.status}${approved ? ` (workspace gate "${record.gate}" approved ${approved})` : ""}`);
    for (const s of record.steps) console.log(`  ${s.member.padEnd(24)} ${s.status}${s.memberRun ? `  (run ${s.memberRun})` : ""}${s.gate ? `  gate ${s.gate.name}` : ""}${s.repo ? `  ${s.repo}` : ""}${s.reason ? `  ${s.reason}` : ""}`);
    if (record.status === "dispatched") {
      const at = record.steps.find((s) => s.status === "dispatched");
      if (at) console.log(`Dispatched ${at.member}. The control repo continues the train when it answers: chant workspace train promote ${env} ${outcome.train.id} --continue`);
    }
    if (record.status === "gated" && pending) {
      console.log(`Workspace gate "${pending.gate}" is pending over ${pending.covers.length} release gate(s) of ${new Set(pending.covers.map((c) => c.member)).size} member(s), digest ${pending.digest}. Nothing was deployed.`);
      console.log(`  Approve: chant workspace run approve ${pending.gate} --plan ${pending.digest}`);
      console.log(`  Then run the same chant workspace train promote again. The approval stands in only for members that set acceptWorkspaceGates: true at base.`);
    }
    if (ledgerError) console.error(formatError({ message: `the workspace run record was not written: ${ledgerError}` }));
  }
  if (record.status === "fail") return 1;
  if (record.status === "gated") return CHANT_EXIT.waiting;
  return 0;
}
