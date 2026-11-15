/**
 * Release trains (#2554, #2524 D19, ws-043): one record that pins a release
 * of every `chant` member, so several members move together.
 *
 * Releases stay per member (ws-043): each is a digest over its artifacts and
 * a git commit, written to the member's own ledger by `chant release cut`. A
 * train names one of them per member: by default the newest cut release, or
 * the one `--pin <member>=<label|digest>` picks. It refuses unless every
 * `chant` member of the declaration has a release, so a train never leaves a
 * member out. It is written to `_members/_workspace/<env>/trains.jsonl`.
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
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { CHANT_EXIT } from "../exit-codes";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { readAllReleases, readCuts } from "../lifecycle/release-store";
import { WORKSPACE_GATE_ENV, WORKSPACE_RUN_ENV } from "../op/workspace-run-env";
import type { WorkspaceGraph } from "./compose-graph";
import { readDeclaration, WorkspaceReadError } from "./declaration";
import { locateWorkspace } from "./which-chant";
import { appendWorkspaceLine, appendWorkspaceRun, readWorkspaceLines, readWorkspaceRuns, type WorkspaceRunRecord, type WorkspaceRunStep } from "./workspace-ledger";
import { appendWorkspaceGatePending, readWorkspaceGate, workspaceGateDigest, type WorkspaceGateCover, type WorkspaceGatePending } from "./workspace-gates";
import type { MemberOpResult } from "./workspace-run";
import { actorFromEnv } from "../actor";
import { NEXT_RELEASE } from "../release-floors";

export interface TrainMember {
  member: string;
  releaseDigest: string;
  /** The release's git commit. */
  commit: string;
  /** The label its newest cut gave it, or null. */
  label: string | null;
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
    if (!members.some((m) => m.member === name)) problems.push(`--pin ${name}: not a chant member of the workspace`);
  }
  for (const m of members) {
    const pin = pins.get(m.member);
    const r = pin === undefined ? m.releases[0] : m.releases.find((x) => x.releaseDigest === pin || x.label === pin);
    if (!r) {
      problems.push(pin === undefined ? `member ${m.member} has no release; cut one with chant release cut in its directory` : `member ${m.member} has no release ${pin}`);
      continue;
    }
    picked.push(r);
  }
  // #4037: a train names at least one release, so its digest never covers nothing.
  if (members.length === 0) problems.push("the workspace declares no chant member, so a train has nothing to pin");
  return problems.length > 0 ? { problems } : { members: picked };
}

/** Every `chant` member's releases, newest cut first, read from its ledger. */
export async function readMemberReleases(cwd: string): Promise<MemberReleases[]> {
  const located = locateWorkspace(cwd);
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  const out: MemberReleases[] = [];
  for (const m of declaration.members) {
    if (m.kind !== "chant") continue;
    const loc = { cwd: located.rootOnDisk, member: m.dir === "." ? "." : m.name };
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
export const TRAIN_PROMOTE_FLOOR = NEXT_RELEASE;

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
}

export type TrainPromoteOutcome =
  | { kind: "refused"; message: string }
  | { kind: "planned"; train: ReadTrain; order: string[] }
  | { kind: "ran"; train: ReadTrain; record: WorkspaceRunRecord; pending: WorkspaceGatePending | null; approved: string | null; ledgerError: string | null };

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

const USAGE =
  "chant workspace train <env> [--pin <member>=<label|digest>]... [--dry-run] [--json] | chant workspace train list <env> [--json] | chant workspace train promote <env> [<train id|digest>] [--gate <name>] [--dry-run] [--json]";

/** The workspace runs that promoted each train, as `train list --json` gives them (#4037). */
export interface TrainPromotion {
  run: string;
  started: string;
  ended: string;
  status: WorkspaceRunRecord["status"];
  gate: string | null;
  members: Array<{ member: string; status: WorkspaceRunStep["status"]; memberRun: string | null }>;
}

/** Each train with the runs that promoted it, oldest first. */
export function trainsWithPromotions(trains: readonly ReadTrain[], runs: readonly WorkspaceRunRecord[]): Array<ReadTrain & { promotions: TrainPromotion[] }> {
  return trains.map((t) => ({
    ...t,
    promotions: runs
      .filter((r) => r.train?.id === t.id)
      .map((r) => ({ run: r.id, started: r.started, ended: r.ended, status: r.status, gate: r.gate, members: r.steps.map((s) => ({ member: s.member, status: s.status, memberRun: s.memberRun })) })),
  }));
}

export async function runWorkspaceTrain(ctx: CommandContext): Promise<number> {
  const words = ctx.args.positionals ?? [];
  const rest = words[0] === "train" ? words.slice(1) : words;
  if (rest[0] === "promote") return runTrainPromote(ctx, rest.slice(1));
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
      console.error(formatError({ message: `no release train for ${env}: every chant member needs a release`, hint: USAGE }));
      for (const p of picked.problems) console.error(`  ${p}`);
      return 1;
    }
    const actor = ctx.args.actor ?? actorFromEnv();
    const record: ReleaseTrainRecord = { version: 1, id: `train-${randomUUID()}`, env, timestamp: new Date().toISOString(), actor, members: picked.members, trainDigest: trainDigest(picked.members) };
    if (!ctx.args.dryRun) await appendReleaseTrain(root, record);
    if (ctx.args.json) console.log(JSON.stringify({ ...record, written: !ctx.args.dryRun }, null, 2));
    else {
      console.log(`${ctx.args.dryRun ? "Would record" : "Recorded"} release train ${record.id} for ${env}, digest ${record.trainDigest}:`);
      for (const m of record.members) console.log(`  ${m.member.padEnd(24)} ${m.label ?? "(no label)"}  ${m.releaseDigest}  ${m.commit.slice(0, 12)}`);
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
    for (const s of record.steps) console.log(`  ${s.member.padEnd(24)} ${s.status}${s.memberRun ? `  (run ${s.memberRun})` : ""}${s.gate ? `  gate ${s.gate.name}` : ""}`);
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
