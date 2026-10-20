/**
 * What an Op waves job runs (#3679): `chant run wave --spec <file> --wave <k>`.
 * `./op-waves.ts` holds the spec and the jobs; this plans a wave's runs,
 * decides its gate and applies it.
 *
 * - Plan: each run's `plan` command writes a plan file; its `planDigest` is
 *   the run's member digest, named by its target. With `planWave` (#3762)
 *   one call plans every run and lists each run's plan; the digest and the
 *   decision are the same as from per-run plans.
 * - Hooks (#3762): read at base with the policy, run before and after the
 *   plan and the apply. One with `onFailure: approve` that fails holds the
 *   wave: it waits for an approval of its set digest whatever its policy.
 * - Decide: the wave's policy comes from the spec file at the base commit
 *   (`git show <base>:<file>`), so a change cannot loosen its own gate. A
 *   wave missing there, or a file missing there, is `always`. A wave that
 *   needs an approval waits on `<gate>-wave-<k>` bound to
 *   {@link waveSetDigest} over its members, and exits 3 when nobody approved
 *   that digest.
 * - Which approvals count is the wave's `approval`, read at base like its
 *   policy (#3684): `ledger`, `sealed` or `pr-review` (`./gate-review.ts`).
 *   Under `pr-review` the pull request's pipeline runs `--record-plans`
 *   ({@link recordOpWaveHeadPlans}), which plans every wave at the head and
 *   records the digests a review of that head approves.
 * - Spend (#3784): with `approvals.spend` at base, an approval a wave applied
 *   under counts for nothing, and the wave records each approval it applies
 *   under in `_gates/<name>/applied.jsonl` (`../lifecycle/gate-applied.ts`)
 *   just before it applies (a wide wave's deciding job, before its shares).
 * - Apply: each run's `apply` command, or one `applyWave` call for the
 *   approved set (#3762). A share job (`--share i`) re-plans its
 *   slice first and refuses, without applying it, a run whose plan digest is
 *   not the one the deciding job recorded (exit 4). A job group's job
 *   (`--group <name>`, #3914) is a share job over the group's runs.
 * - Hooks file (#3804): every apply call gets `CHANT_HOOKS`, a JSON file
 *   ({@link OpWaveHooksFile}) with the outcomes of the hooks that already ran
 *   and whether an approval stands. Under `hooks.apply.runBy: "apply"` (read
 *   at base) chant does not run the apply-stage hooks itself: the file hands
 *   them to the apply, which runs them under its own lock with
 *   {@link runOpWaveApplyHooks}, and their outcomes come back through
 *   `CHANT_HOOKS_RESULT`. A non-wave apply reads the same hooks at base with
 *   {@link opWaveHooksAtBase}.
 * - Point (#3836): with `point` at base (the wave's, else the spec's), a wave
 *   that needs an approval asks that decision point through
 *   `evaluatePointGate` (`../point-decision.ts`) with `gate.planDigest` set to
 *   its set digest: an open question waits (exit 3, the pending fact cites
 *   it, `approve` is the `points answer` line), an answer the gate passes on
 *   records the resolution that cites it and the wave goes on, and any other
 *   answer refuses the wave (`refused.reason: "point"`, exit 8). Once the
 *   question is answered, `chant run resume --op <name>` starts the job again
 *   (`pointGateResumable`, #3835).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import {
  decideWaveGate,
  runWaveLoop,
  waveDigestMembers,
  waveSetDigest,
  writeWaveRecordFile,
  type WaveAttempt,
  type WaveMember,
  type WaveStep,
} from "../wave-engine";
import type { ReviewApproval } from "../gate-decision";
import { approveCommand, evaluateGate, gitGateLedgerPort, type GateCheck, type GateDigestMismatch, type GateLedgerPort } from "./gate";
import type { GateAnswerRef, PendingGateRecord } from "../lifecycle/gate-ledger";
import type { GatePointAsker } from "../point-decision";
import type { WaitingPoint } from "./steward-points";
import { isApprovalSpent, type AppliedGateRecord } from "../lifecycle/gate-applied";
import { isLifecycleLocalNote } from "../lifecycle/local-note";
import type { HeadPlans, MergedReview, ReviewSource } from "./gate-review";
import type { TrustPolicy } from "../workspace/trust/policy";
import type { GateSigners } from "../workspace/trust/gate-seal";
import { ciRunIdFromEnv } from "./gate-run-locator";
import {
  OP_WAVE_DEFAULT_APPLY,
  OP_WAVE_GATE_POLICIES,
  OP_WAVE_HOOK_MOMENTS,
  GATE_APPROVAL_SOURCES,
  assertOpWaveHooks,
  assertOpWavesSpec,
  opWaveApplyHooksRunBy,
  opWaveGateName,
  opWaveHooksAt,
  opWavePointAt,
  opWavePointProblems,
  opWaveRecordPath,
  opWaveGroupRuns,
  opWaveGroupsProblem,
  opWaveShare,
  type GateApprovalSource,
  type OpWave,
  type OpWaveApplyHooksRunner,
  type OpWaveGatePolicy,
  type OpWaveHook,
  type OpWaveHookMoment,
  type OpWavePoint,
  type OpWaveRun,
  type OpWavesSpec,
} from "./op-waves";

/** What a run's plan command writes to `{plan}`. */
export interface OpWavePlanFile {
  planDigest: string;
  /** The plan destroys, rewrites or otherwise needs a person under `on-destructive`. */
  destructive?: boolean;
  /** The plan changes nothing. */
  empty?: boolean;
  /**
   * The product's policy denied this plan (#3821): the ids of the rules that
   * denied it. The wave applies nothing unless an override of this run, its
   * plan digest and these rules counts (`@intentius/chant/override-gate`).
   */
  denied?: { rules: string[]; reason?: string };
}

/** What a wave-level plan command writes to `{plans}` (#3762): one plan per run, by target. The array alone is read too. */
export interface OpWavePlansFile {
  runs: Array<OpWavePlanFile & { target: string }>;
  /**
   * Fields the product adds to the wave's pending fact (#3821), such as the
   * commit it planned or the members its own readers expect. chant's own
   * fields win: a key chant writes (`op`, `gate`, `planDigest`, `timestamp`,
   * ...) is refused, except `description`.
   */
  pending?: Record<string, unknown>;
  /**
   * Who may override a denial (#3821), for a product that keeps the list in
   * its own config at base and read it there. Absent: the spec's
   * `override.overriders` file at base, else `.chant/overriders` at base.
   */
  overriders?: string[];
  /**
   * Digest members that are not runs (#3821), such as the wave's monthly cost
   * when a cost threshold applies, so an approval at one cost does not apply
   * at another. Each needs a name no run has.
   */
  members?: WaveMember[];
  /** On a discovering wave (#3821): how many waves the product found, which a `rest` wave walks to. */
  waves?: number;
}

/** Pending-fact keys chant writes itself, which a plans file's `pending` may not set (#3821). */
export const OP_WAVE_PENDING_RESERVED = [
  "version", "kind", "op", "gate", "timestamp", "expiresAt", "planDigest", "runId", "url", "resume",
  "environment", "origin", "neverOverMcp", "approval", "approvalMode", "answer", "wave", "heldBy",
] as const;

/** What chant writes to `{runs}` for a wave-level command or a hook (#3762). */
export interface OpWaveRunsFile {
  /** The wave's name. */
  wave: string;
  /** 1-based. */
  number: number;
  /** The wave's set digest, once it is decided. On `applyWave`, the digest the set was approved or let through at. */
  digest?: string;
  /** Set when the wave discovers its runs (#3821): `runs` is empty, and the plan command plans the runs it finds for this wave. */
  discover?: true;
  /** Each run, with its plan once planned. On `applyWave`, the runs to apply. */
  runs: Array<{ target: string; op: string; planDigest?: string; destructive?: boolean; empty?: boolean }>;
}

/** One run's plan, as the decision records it. */
export interface OpWaveMember extends WaveMember {
  op: string;
  destructive?: boolean;
  empty?: boolean;
  /** The product's policy denied the plan (#3821). */
  denied?: { rules: string[]; reason?: string };
  /** The override that lets the denied plan through (#3821). */
  override?: { by: string; at: string; digest: string; reason: string };
}

/** Where a wave's policy came from. */
export type OpWavePolicySource = "base" | "absent-at-base";

/** A wave's decision: what was planned, the policy, and whether it may apply. */
export interface OpWaveDecision {
  wave: number;
  name: string;
  /** The op the gate is recorded under: the spec's name. */
  op: string;
  gate: string;
  policy: OpWaveGatePolicy;
  /** Which approvals count, read at base with the policy (#3684). */
  approval: GateApprovalSource;
  policySource: OpWavePolicySource;
  /** The base commit the policy was read at. */
  base: string;
  digest: string;
  members: OpWaveMember[];
  /**
   * `approved`: an approval of this digest stands. `not-required`: the policy
   * lets it through. `waiting`: neither. `refused`: the product's policy
   * denied a run and no override counts (#3821, exit 7).
   */
  status: "approved" | "not-required" | "waiting" | "refused";
  approvedBy?: string;
  /** How the approval arrived: a resolution on the ledger, the merged pull request's review (#3684), or a decision point's answer (#3836). */
  via?: "ledger" | "pr-review" | "point";
  /**
   * The decision point the gate asks, as read at base (#3836), and what it
   * said: the open `question` while the wave waits, the `answer` once it is
   * answered (the one that passed, or the one that refused the wave).
   */
  point?: OpWavePoint & { question?: WaitingPoint; answer?: GateAnswerRef };
  /** The review that approved the wave, or why the review did not, under `pr-review`. */
  review?: { pr?: number; head?: string; approvers?: string[]; url?: string; reason?: string };
  /** The command that approves this digest, when waiting. */
  approve?: string;
  /** The hooks read at base (#3762), which a wide wave's share jobs run too. Absent when there are none. */
  hooks?: Partial<Record<OpWaveHookMoment, OpWaveHook[]>>;
  /** The `onFailure: approve` hooks that failed: the wave needs an approval whatever its policy (#3762). */
  heldBy?: string[];
  /**
   * Spent approvals (#3784). `base`: the spec at base sets `approvals.spend`,
   * so a spent approval counts for nothing and the approval this wave applies
   * under is recorded. `change`: only the change sets it, so the approval is
   * recorded and spent from the next decision on. Absent: neither.
   */
  spend?: "base" | "change";
  /** The approval's own timestamp: what the applied record names. */
  approvedAt?: string;
  /** When the wave recorded that it applies under the approval, which spent it. */
  spentAt?: string;
  /** `apply`: the apply command runs the apply-stage hooks under its own lock (#3804), as read at base. Absent: chant runs them. */
  applyHooksRunBy?: "apply";
  /** Every hook's outcome so far in the job that wrote the record (#3804). */
  outcomes?: OpWaveHookOutcome[];
  /** `changing`: the digest covers only the runs whose plan is not empty, as the spec's `digest.over` says (#3821). Absent: every run. */
  digestOver?: "changing";
  /** The fields the plans file added to the pending fact (#3821). */
  pending?: Record<string, unknown>;
  /** The pending fact carries `neverOverMcp`, set by the spec here or at base (#3821). */
  neverOverMcp?: true;
  /** While waiting (#3821): the pending fact that stands for the digest, this run's own when `recorded`. */
  pendingFact?: PendingGateRecord;
  /** While waiting: whether this run recorded the pending fact, rather than finding one standing. */
  recorded?: boolean;
  /** While waiting: when the wait began, the standing pending fact's time. */
  waitingSince?: string;
  /** While waiting: the newest approval of this gate for another digest, which the plans moved away from. */
  mismatch?: GateDigestMismatch;
  /**
   * Why a `refused` wave applies nothing: the runs the policy denied, and
   * whether an override stands for an earlier plan or other rules (#3821,
   * exit 7); or `point`, the gate's decision point answered with an answer
   * it does not pass on (#3836, exit 8), with every run and the `message`.
   */
  refused?: {
    reason: "policy" | "override-moved" | "point";
    runs: string[];
    message?: string;
    /** Where the plans file said its overriders come from (#3848), when it did. */
    overridersSource?: string;
  };
  /**
   * A hook held the wave on another gate (#3821), such as a state migration
   * behind its own: that gate, its digest, and how it came out. While it
   * waits, the wave waits (exit 3) and `approve` approves it.
   */
  heldOn?: OpWaveHeldOn;
  /** When the wave recorded the overrides it applies under (#3821), which spent them. */
  overridesSpentAt?: string;
  /** Digest members that are no run, from the plans file (#3821), such as the wave's cost. */
  extras?: WaveMember[];
  /** On a discovering wave (#3821): how many waves the plan command found. */
  discovered?: { waves?: number };
}

/**
 * What an apply call writes to `CHANT_APPLY_OUTCOME` when it applied nothing
 * for a reason that is not a failure (#3821). `stood-down`: a newer run (a
 * newer push on the branch) applies instead, exit 6. `held`: another run
 * holds what the apply changes and the apply does not wait for it, exit 5.
 * `replan`: the run it waited for let go, so the plans may have moved and
 * the wave plans again in the same job. An apply that applied writes nothing.
 */
export interface OpWaveApplyOutcome {
  outcome: "stood-down" | "held" | "replan";
  reason?: string;
  /** The run holding what the apply changes, for `held`. */
  holder?: { run: string; url?: string };
}

export const OP_WAVE_APPLY_OUTCOMES = ["stood-down", "held", "replan"] as const;

/** What a hook asks for when it holds a wave on another gate (#3821): it writes this to `CHANT_HOLD` and exits non-zero. */
export interface OpWaveHoldRequest {
  /** The op the gate is recorded under. Default: the spec's name. */
  op?: string;
  gate: string;
  /** The digest an approval binds. */
  digest: string;
  description?: string;
  /** Fields for the pending fact, as a plans file's `pending`. */
  pending?: Record<string, unknown>;
}

/** A hold on another gate, as the decision records it (#3821). */
export interface OpWaveHeldOn {
  op: string;
  gate: string;
  digest: string;
  /** The hook that asked. */
  hook: string;
  status: "approved" | "waiting";
  approvedBy?: string;
  approvedAt?: string;
  approve?: string;
  waitingSince?: string;
  recorded?: boolean;
  mismatch?: GateDigestMismatch;
  /**
   * The gates the same hook call held the wave on before this one, each
   * approved, oldest first (#3847): its approved re-runs asked for this one.
   */
  after?: OpWaveHeldOnApproval[];
}

/** An approved hold on another gate (#3847), as `CHANT_HOLD_APPROVED` and `CHANT_HOLDS_APPROVED` carry it. */
export interface OpWaveHeldOnApproval {
  op: string;
  gate: string;
  digest: string;
  approvedBy: string;
  approvedAt: string;
}

/** One hook's run (#3762). */
export interface OpWaveHookOutcome {
  moment: OpWaveHookMoment;
  name: string;
  /** The run, for a `perRun` hook. */
  target?: string;
  exit: number;
  outcome: "passed" | "failed" | "held" | "skipped";
  /** Why the moment was skipped, for `skipped` (#3811). */
  reason?: string;
}

/** One run as a hook sees it (#3804). */
export interface OpWaveHookRun {
  target: string;
  op: string;
  /** The run's plan file, once planned. */
  plan?: string;
}

/**
 * What chant hands an apply command in `CHANT_HOOKS` (#3804), and what
 * {@link opWaveHooksAtBase} builds for an apply outside the waves. Paths are
 * relative to the job's working directory.
 */
export interface OpWaveHooksFile {
  version: 1;
  /** The Op waves spec's name. */
  opWaves: string;
  /** The spec's `op`: a hook's `{op}` when it runs once for the wave. */
  op: string;
  wave: string;
  /** 1-based; 0 when the working tree's spec has no such wave. */
  number: number;
  /** The commit the hooks were read at. */
  base?: string;
  /** The wave's set digest, once decided. */
  digest?: string;
  /** An approval of the digest stands, so a held hook does not stop the apply. */
  approved: boolean;
  /** The labels of the hooks that held the wave, approved or not. */
  heldBy?: string[];
  /** Who runs the apply-stage hooks. With `chant`, `hooks` is empty: chant runs them around the apply. */
  runBy: OpWaveApplyHooksRunner;
  /** The runs this apply call applies. */
  runs: OpWaveHookRun[];
  /** The runs file, a hook's `{runs}` and `CHANT_RUNS`. */
  runsFile: string;
  /** The hooks the apply runs, by moment, as read at base. */
  hooks: Partial<Record<OpWaveHookMoment, OpWaveHook[]>>;
  /** The hooks that already ran for this wave in this job, and how each came out. */
  outcomes: OpWaveHookOutcome[];
  /** Where {@link runOpWaveApplyHooks} writes its outcomes (`CHANT_HOOKS_RESULT`), which chant reads back. */
  result?: string;
  /** Set when the hooks at base could not be read: none run, and the runner refuses to proceed. */
  refused?: string;
}

/** What {@link runOpWaveApplyHooks} writes to `CHANT_HOOKS_RESULT` (#3804). */
export interface OpWaveHooksResult {
  version: 1;
  /** The moments the apply ran, empty ones included. */
  moments: OpWaveHookMoment[];
  outcomes: OpWaveHookOutcome[];
}

/** The options of {@link runOpWaveApplyHooks} (#3825). */
export interface RunOpWaveApplyHooksOptions {
  /** Where the hooks run. Default `process.cwd()`. */
  cwd?: string;
  /** Runs one hook. Default: spawn it with the job's environment. */
  exec?: OpWaveExec;
  /** Default: stderr. */
  log?: (line: string) => void;
  /** Run nothing and record the moment as skipped, with this reason (#3811). */
  skip?: string;
}

/** One call of {@link runOpWaveApplyHooks}. */
export interface OpWaveApplyHooksRun {
  moment: OpWaveHookMoment;
  outcomes: OpWaveHookOutcome[];
  /** Set when a hook with `onFailure: fail` failed; the hooks after it did not run. */
  failed?: string;
  /** The `onFailure: approve` hooks that failed, or why the hooks could not be read at base. */
  held: string[];
  /**
   * Whether the apply may go on: no hook failed, and nothing held it or an
   * approval of the digest stands. When false after a hold, the apply applies
   * nothing and exits non-zero; chant then waits for, or finds, an approval
   * and calls it again.
   */
  proceed: boolean;
}

/** Runs one argv; returns its exit code. `env` is added to the job's environment. Injected so tests run no processes. */
export type OpWaveExec = (argv: string[], cwd: string, env?: Record<string, string>) => number;

const spawnExec: OpWaveExec = (argv, cwd, env) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, stdio: "inherit", ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/** Reads one file at one commit, or null when the commit has no such file. Injected for tests. */
export type OpWaveShowAtBase = (base: string, path: string, cwd: string) => { sha: string; text: string | null };

const gitShowAtBase: OpWaveShowAtBase = (base, path, cwd) => {
  let sha: string;
  try {
    sha = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(
      `the gate policy is read at ${base}, which this checkout does not have. ` +
        `Check out the full history (fetch-depth: 0 on GitHub and Forgejo, GIT_DEPTH: "0" on GitLab), or set the spec's base.`,
    );
  }
  try {
    const text = execFileSync("git", ["show", `${sha}:./${path}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { sha, text };
  } catch {
    return { sha, text: null };
  }
};

/** Read a spec file, refusing anything that is not one. */
export function parseOpWavesSpec(text: string, where: string): OpWavesSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const waves = (parsed as { waves?: unknown } | null)?.waves;
  const spec = (Array.isArray(waves) ? parsed : waves) as OpWavesSpec | undefined;
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.waves)) {
    throw new Error(`${where} must hold an Op waves spec: { "name", "op", "plan", "waves": [...] }, or { "waves": <that>, "options": {...} }`);
  }
  return spec;
}

/** What {@link readOpWavePolicy} read at base. */
export interface OpWaveBaseRules {
  policy: OpWaveGatePolicy;
  approval: GateApprovalSource;
  source: OpWavePolicySource;
  base: string;
  /** The wave's hooks at base, by moment (#3762): the spec's, then the wave's. None when the file or the wave is absent there. */
  hooks: Record<OpWaveHookMoment, OpWaveHook[]>;
  /** Set when the hooks at base could not be read: none run, and the wave waits for a person. */
  hooksRefused?: string;
  /** The spec at base sets `approvals.spend` (#3784). */
  spend: boolean;
  /** Who runs the apply-stage hooks, as read at base (#3804). `chant` when the file, the wave or the hooks are missing there. */
  applyHooksRunBy: OpWaveApplyHooksRunner;
  /** The spec at base sets `neverOverMcp` (#3821). */
  neverOverMcp: boolean;
  /** The decision point the wave's gate asks, as read at base (#3836): the wave's, else the spec's. */
  point?: OpWavePoint;
  /** Set when the point at base cannot be asked: the wave fails rather than fall back to the ledger (#3836). */
  pointRefused?: string;
}

const noHooks = (): Record<OpWaveHookMoment, OpWaveHook[]> =>
  Object.fromEntries(OP_WAVE_HOOK_MOMENTS.map((m) => [m, []])) as unknown as Record<OpWaveHookMoment, OpWaveHook[]>;

/**
 * The policy of wave `name`, as the spec file at `base` declares it. The
 * file or the wave missing there reads as `always`: a change that adds a
 * wave, or the file, waits for a person the first time. Its stage hooks are
 * read there too (#3762), so a change cannot add, edit or remove a hook its
 * own apply runs; the file or the wave missing there has none.
 */
export function readOpWavePolicy(
  specFile: string,
  name: string,
  base: string,
  cwd: string,
  show: OpWaveShowAtBase = gitShowAtBase,
): OpWaveBaseRules {
  const { sha, text } = show(base, specFile.replace(/^\.\//, "").split("\\").join(posix.sep), cwd);
  const absent = { policy: "always" as const, approval: "ledger" as const, source: "absent-at-base" as const, base: sha, hooks: noHooks(), spend: false, applyHooksRunBy: "chant" as const, neverOverMcp: false };
  if (text === null) return absent;
  let spec: OpWavesSpec;
  try {
    spec = parseOpWavesSpec(text, `${specFile} at ${base}`);
  } catch {
    return absent;
  }
  // The spend rule is the spec's, so it holds for a wave the base does not have yet.
  const spend = (spec as { approvals?: { spend?: unknown } }).approvals?.spend === true;
  const neverOverMcp = (spec as { neverOverMcp?: unknown }).neverOverMcp === true;
  // #3836: the gate's decision point, the spec's for a wave the base does not have yet.
  const asks = pointAtBase(spec, name, `${specFile} at ${sha.slice(0, 12)}`);
  const wave = spec.waves.find((w) => w.name === name);
  if (!wave) return { ...absent, spend, neverOverMcp, ...asks };
  const policy = wave.gate ?? "always";
  // An approval mode this chant does not know reads as sealed: the strictest, so an unknown rule never loosens a gate.
  const approval = wave.approval === undefined ? "ledger" : GATE_APPROVAL_SOURCES.includes(wave.approval) ? wave.approval : "sealed";
  const rules: OpWaveBaseRules = { policy: OP_WAVE_GATE_POLICIES.includes(policy) ? policy : "always", approval, source: "base", base: sha, hooks: noHooks(), spend, applyHooksRunBy: "chant", neverOverMcp, ...asks };
  try {
    assertOpWaveHooks(`${specFile} at ${sha.slice(0, 12)}`, spec.hooks);
    assertOpWaveHooks(`${specFile} at ${sha.slice(0, 12)}, wave "${name}"`, wave.hooks);
    rules.hooks = opWaveHooksAt(spec, name);
    rules.applyHooksRunBy = opWaveApplyHooksRunBy(spec, name);
  } catch (err) {
    // A hook at base no runner can run: none run, and the wave waits for a person rather than going out without them.
    rules.hooksRefused = `the hooks at base cannot be run (${err instanceof Error ? err.message : String(err)})`;
  }
  return rules;
}

/** The point wave `name` asks at base (#3836), or why it cannot be asked. */
function pointAtBase(spec: OpWavesSpec, name: string, where: string): Pick<OpWaveBaseRules, "point" | "pointRefused"> {
  const raw = spec.waves.find((w) => w.name === name)?.point ?? spec.point;
  if (raw === undefined) return {};
  const problems = opWavePointProblems(raw);
  if (problems.length > 0) return { pointRefused: `the decision point at base cannot be asked (${where}: ${problems.join("; ")})` };
  return { point: opWavePointAt(spec, name)! };
}

/** Fill one argv template. A placeholder whose value is not given is left as it is. */
export function opWaveArgv(
  template: readonly string[],
  values: { op: string; wave: string; target?: string; plan?: string; runs?: string; plans?: string },
): string[] {
  const pairs: Array<[string, string | undefined]> = [
    ["{op}", values.op],
    ["{target}", values.target],
    ["{wave}", values.wave],
    ["{plans}", values.plans],
    ["{plan}", values.plan],
    ["{runs}", values.runs],
  ];
  return template.map((part) => pairs.reduce((out, [key, value]) => (value === undefined ? out : out.replaceAll(key, value)), part));
}

/** Where a run's plan file goes. */
export function opWavePlanPath(spec: Pick<OpWavesSpec, "name">, wave: number, target: string): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}/${target.replace(/[^A-Za-z0-9._-]/g, "_")}.plan.json`;
}

/** Where a wave's runs file goes: the `{runs}` of a wave-level command or a hook (#3762). */
export function opWaveRunsPath(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}/runs.json`;
}

/** Where a wave-level plan command writes its plans: its `{plans}` (#3762). */
export function opWavePlansPath(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}/plans.json`;
}

export interface RunOpWaveOptions {
  spec: OpWavesSpec;
  specFile: string;
  /** 1-based. */
  wave: number;
  /** Plan and decide only (a wide wave's deciding job). */
  decide?: boolean;
  /** Apply this 1-based share of a decided wave, or with `group`, of that job group. */
  share?: number;
  /**
   * Apply this job group's runs of a decided wave (#3914), as a share job
   * does: plan them again and apply those whose plan has not moved.
   */
  group?: string;
  /** Overrides the spec's base. */
  base?: string;
  cwd?: string;
  gates?: GateLedgerPort;
  exec?: OpWaveExec;
  show?: OpWaveShowAtBase;
  now?: string;
  log?: (line: string) => void;
  /** The applied commit, which a `pr-review` gate finds the merged pull request by. Default `git rev-parse HEAD`. */
  head?: string;
  /** The forge's reviews, for a `pr-review` gate. Default: the CI job's forge (`reviewSourceFromEnv`). */
  reviews?: ReviewSource;
  /** The plans recorded for a pull request's head. Default: read from `chant/lifecycle`. */
  headPlans?: (name: string, head: string) => Promise<HeadPlans | null>;
  /** The signers policy at base, for a `sealed` gate. Default: read from the base commit. */
  trust?: (base: string) => TrustPolicy;
  /** The signers at base, for a sealed override of a policy denial (#3821). Default: `gateSignersAt` from `@intentius/chant/gate-decision`. */
  signers?: (base: string) => GateSigners;
  /** How a gate with a `point` asks it (#3836). Default: `workspaceGatePointAsker` over `cwd`. A tool that bundles chant passes `chantGatePointAsker`. */
  points?: GatePointAsker;
}

export interface RunOpWaveResult {
  /**
   * 0 applied (or decided), 1 a run or a hook failed, 3 waiting for an
   * approval, 4 a plan moved since the decision, 5 the apply applied nothing
   * because another run holds what it changes, 6 the apply stood down for a
   * newer run, 7 the product's policy denied a run and no override counts
   * (5, 6 and 7: #3821), 8 the gate's decision point was answered with an
   * answer it does not pass on (#3836).
   */
  exitCode: number;
  /** Set when the apply applied nothing and stood down or was held by another run (#3821): not a failure. */
  outcome?: OpWaveApplyOutcome;
  /** Set when the apply asked to plan again (#3821); {@link runOpWave} does, so a caller sees it only on a pass that gave up. */
  replan?: { reason?: string };
  /** The waves a `rest` wave's job ran (#3821), in order, with how each ended. */
  rest?: Array<{ wave: number; exitCode: number; digest?: string }>;
  decision?: OpWaveDecision;
  applied: string[];
  failed: string[];
  /** Runs a share job refused because their plan moved since the decision. */
  moved: string[];
  /** The hooks that ran (#3762). */
  hooks: OpWaveHookOutcome[];
}

/** What one wave job works with. */
interface WaveContext {
  spec: OpWavesSpec;
  k: number;
  wave: OpWave;
  cwd: string;
  exec: OpWaveExec;
  log: (line: string) => void;
  result: RunOpWaveResult;
  options: RunOpWaveOptions;
  /** How another gate a hook holds the wave on is decided (#3821): the approval mode and base the wave's rules were read at, and whether pending facts carry neverOverMcp. */
  gateRule: { approval: GateApprovalSource; base: string; neverOverMcp: boolean };
}

function planRun(opts: { spec: OpWavesSpec; wave: number; cwd: string; exec: OpWaveExec }, waveName: string, run: OpWaveRun): OpWaveMember {
  const op = run.op ?? opts.spec.op;
  const plan = opWavePlanPath(opts.spec, opts.wave, run.target);
  mkdirSync(dirname(join(opts.cwd, plan)), { recursive: true });
  const code = opts.exec(opWaveArgv(opts.spec.plan!, { op, target: run.target, wave: waveName, plan }), opts.cwd);
  if (code !== 0) throw new Error(`planning ${run.target} exited ${code}`);
  let file: OpWavePlanFile;
  try {
    file = JSON.parse(readFileSync(join(opts.cwd, plan), "utf-8")) as OpWavePlanFile;
  } catch (err) {
    throw new Error(`planning ${run.target} wrote no readable plan file at ${plan}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof file.planDigest !== "string" || file.planDigest === "") {
    throw new Error(`the plan file for ${run.target} (${plan}) has no planDigest`);
  }
  return member(run.target, op, file);
}

function member(target: string, op: string, file: OpWavePlanFile): OpWaveMember {
  const denied = file.denied as unknown;
  if (denied !== undefined) {
    const d = denied as { rules?: unknown; reason?: unknown } | null;
    if (!d || typeof d !== "object" || !Array.isArray(d.rules) || d.rules.length === 0 || !d.rules.every((r) => typeof r === "string" && r.trim() !== "") || (d.reason !== undefined && typeof d.reason !== "string")) {
      throw new Error(`the plan of ${target} has denied ${JSON.stringify(denied)}; a denial is { "rules": ["<rule id>", ...], "reason"?: "<text>" }`);
    }
  }
  return {
    member: target,
    planDigest: file.planDigest,
    op,
    ...(file.destructive === true ? { destructive: true } : {}),
    ...(file.empty === true ? { empty: true } : {}),
    ...(file.denied ? { denied: { rules: file.denied.rules, ...(file.denied.reason ? { reason: file.denied.reason } : {}) } } : {}),
  };
}

/** Write the `{runs}` file: the runs, with their plans once planned. */
function writeRunsFile(
  at: { spec: OpWavesSpec; k: number; wave: OpWave; cwd: string },
  runs: readonly OpWaveRun[],
  members?: ReadonlyMap<string, OpWaveMember>,
  digest?: string,
  path: string = opWaveRunsPath(at.spec, at.k),
  discover = false,
): string {
  const file: OpWaveRunsFile = {
    wave: at.wave.name,
    number: at.k,
    ...(digest ? { digest } : {}),
    ...(discover ? { discover: true as const } : {}),
    runs: runs.map((run) => {
      const m = members?.get(run.target);
      return {
        target: run.target,
        op: run.op ?? at.spec.op,
        ...(m ? { planDigest: m.planDigest, ...(m.destructive ? { destructive: true } : {}), ...(m.empty ? { empty: true } : {}) } : {}),
      };
    }),
  };
  mkdirSync(dirname(join(at.cwd, path)), { recursive: true });
  writeFileSync(join(at.cwd, path), JSON.stringify(file, null, 2) + "\n");
  return path;
}

/**
 * Plan `runs` of wave `k`: one `plan` call per run, or one `planWave` call
 * for all of them (#3762). A wave plan is written out as each run's plan file
 * too, so a per-run `apply` or hook reads `{plan}` either way.
 */
function planRuns(at: { spec: OpWavesSpec; k: number; wave: OpWave; cwd: string; exec: OpWaveExec }, runs: readonly OpWaveRun[], discover = false): PlannedRuns {
  const { spec, k, wave, cwd, exec } = at;
  if (!spec.planWave) return { members: runs.map((run) => planRun({ spec, wave: k, cwd, exec }, wave.name, run)) };
  const runsPath = writeRunsFile(at, runs, undefined, undefined, undefined, discover);
  const plans = opWavePlansPath(spec, k);
  rmSync(join(cwd, plans), { force: true });
  const code = exec(opWaveArgv(spec.planWave, { op: spec.op, wave: wave.name, runs: runsPath, plans }), cwd);
  if (code !== 0) throw new Error(`planning wave ${k} (${wave.name}) exited ${code}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, plans), "utf-8"));
  } catch (err) {
    throw new Error(`planning wave ${k} (${wave.name}) wrote no readable plans file at ${plans}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entries = Array.isArray(parsed) ? parsed : (parsed as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(entries)) throw new Error(`the plans file of wave ${k} (${plans}) must hold { "runs": [{ "target", "planDigest" }] }`);
  const wanted = new Set(runs.map((r) => r.target));
  const byTarget = new Map<string, OpWavePlanFile>();
  // #3821: a discovering wave's runs are the ones the plans file names.
  const found: OpWaveRun[] = [];
  for (const entry of entries as Array<Partial<OpWavePlanFile & { target: string; op: string }>>) {
    const target = entry?.target;
    if (discover && typeof target === "string" && target !== "" && !byTarget.has(target)) {
      if (entry.op !== undefined && (typeof entry.op !== "string" || entry.op === "")) throw new Error(`the plans file of wave ${k} (${plans}) gives ${target} an op that is not a name`);
      found.push({ target, ...(entry.op && entry.op !== spec.op ? { op: entry.op } : {}) });
      wanted.add(target);
    }
    if (typeof target !== "string" || !wanted.has(target)) {
      throw new Error(`the plans file of wave ${k} (${plans}) plans ${JSON.stringify(target)}, which is not a run it was asked to plan`);
    }
    if (byTarget.has(target)) throw new Error(`the plans file of wave ${k} (${plans}) plans ${target} twice`);
    if (typeof entry.planDigest !== "string" || entry.planDigest === "") throw new Error(`the plans file of wave ${k} (${plans}) has no planDigest for ${target}`);
    byTarget.set(target, entry as OpWavePlanFile);
  }
  const missing = runs.filter((r) => !byTarget.has(r.target)).map((r) => r.target);
  if (missing.length > 0) throw new Error(`the plans file of wave ${k} (${plans}) has no plan for ${missing.join(", ")}`);
  if (discover) runs = found;
  const extras = Array.isArray(parsed) ? undefined : extraMembers((parsed as { members?: unknown }).members, new Set(runs.map((r) => r.target)), `the plans file of wave ${k} (${plans})`);
  const count = Array.isArray(parsed) ? undefined : (parsed as { waves?: unknown }).waves;
  if (count !== undefined && (!Number.isInteger(count) || (count as number) < 0)) throw new Error(`the plans file of wave ${k} (${plans}): \`waves\` must be the number of waves found, a whole number`);
  const pending = Array.isArray(parsed) ? undefined : pendingFields((parsed as { pending?: unknown }).pending, `the plans file of wave ${k} (${plans})`);
  const members = runs.map((run) => {
    const m = member(run.target, run.op ?? spec.op, byTarget.get(run.target)!);
    const path = join(cwd, opWavePlanPath(spec, k, run.target));
    writeFileSync(path, JSON.stringify({ planDigest: m.planDigest, ...(m.destructive ? { destructive: true } : {}), ...(m.empty ? { empty: true } : {}), ...(m.denied ? { denied: m.denied } : {}) }) + "\n");
    return m;
  });
  const overriders = Array.isArray(parsed) ? undefined : (parsed as { overriders?: unknown }).overriders;
  const overridersSource = Array.isArray(parsed) ? undefined : (parsed as { overridersSource?: unknown }).overridersSource;
  if (overridersSource !== undefined && (typeof overridersSource !== "string" || overridersSource.trim() === "")) {
    throw new Error(`the plans file of wave ${k} (${plans}): \`overridersSource\` must be a label for where the overriders come from, such as "policy.override in terragucci.yml"`);
  }
  if (overriders !== undefined && (!Array.isArray(overriders) || !overriders.every((o) => typeof o === "string"))) {
    throw new Error(`the plans file of wave ${k} (${plans}): \`overriders\` must be a list of principals`);
  }
  return {
    members,
    ...(pending ? { pending } : {}),
    ...(overriders ? { overriders: overriders as string[] } : {}),
    ...(overriders && overridersSource ? { overridersSource: overridersSource as string } : {}),
    ...(extras ? { extras } : {}),
    ...(count !== undefined ? { waves: count as number } : {}),
  };
}

/** What planning a wave's runs gave: each run's plan, and the product's pending-fact fields (#3821). */
interface PlannedRuns {
  members: OpWaveMember[];
  pending?: Record<string, unknown>;
  /** The plans file's overriders (#3821). */
  overriders?: string[];
  /** A label for where those overriders come from, used in refusals (#3848). */
  overridersSource?: string;
  /** Digest members that are not runs, such as the wave's cost (#3821). */
  extras?: WaveMember[];
  /** How many waves the product found (#3821), for a `rest` wave. */
  waves?: number;
}

/** A plans file's `members` (#3821): digest members that are no run, each named once and by no run's target. */
function extraMembers(value: unknown, targets: ReadonlySet<string>, where: string): WaveMember[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${where}: \`members\` must be a list of { "member", "planDigest" }`);
  const seen = new Set<string>();
  const out: WaveMember[] = [];
  for (const m of value as Array<Partial<WaveMember>>) {
    if (!m || typeof m.member !== "string" || m.member === "" || typeof m.planDigest !== "string" || m.planDigest === "") throw new Error(`${where}: each of \`members\` needs a member and a planDigest`);
    if (targets.has(m.member)) throw new Error(`${where}: member ${m.member} is also a run's target; a digest member that is no run needs a name of its own`);
    if (seen.has(m.member)) throw new Error(`${where}: names member ${m.member} twice`);
    seen.add(m.member);
    out.push({ member: m.member, planDigest: m.planDigest });
  }
  return out.length > 0 ? out : undefined;
}

/** A plans file's `pending` (#3821): an object whose keys chant does not write itself, `description` aside. Undefined when absent or empty. */
function pendingFields(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: \`pending\` must be an object of fields for the pending fact`);
  const reserved = Object.keys(value).filter((key) => (OP_WAVE_PENDING_RESERVED as readonly string[]).includes(key));
  if (reserved.length > 0) throw new Error(`${where}: \`pending\` sets ${reserved.join(", ")}, which chant writes itself`);
  if ("description" in value && typeof (value as { description?: unknown }).description !== "string") throw new Error(`${where}: pending.description must be a string`);
  return Object.keys(value).length > 0 ? (value as Record<string, unknown>) : undefined;
}

/**
 * A wave's set digest (#3821): {@link waveSetDigest} over its runs' plans,
 * or under `digest.over: "changing"` over the runs whose plan is not empty,
 * falling back to every run when all of them are empty. `extras`, the plans
 * file's members that are no run (a cost), are always in it.
 */
export function opWaveSetDigest(spec: Pick<OpWavesSpec, "digest">, members: ReadonlyArray<WaveMember & { empty?: boolean }>, extras: readonly WaveMember[] = []): string {
  return waveSetDigest(waveDigestMembers(members, { ...(spec.digest?.over ? { over: spec.digest.over } : {}), extras }));
}

/** What one moment's hooks came to. */
interface HooksOutcome {
  /** Set when a hook with `onFailure: fail` failed; the hooks after it did not run. */
  failed?: string;
  /** The `onFailure: approve` hooks that failed. */
  holds: string[];
  /** A hook held the wave on another gate that nobody approved yet (#3821): the wave waits. */
  waitingOn?: OpWaveHeldOn;
}

/** A hook call that held the wave on another gate (#3821), kept so it can run again once that gate is approved. */
interface OtherGateHold {
  label: string;
  name: string;
  moment: OpWaveHookMoment;
  target?: string;
  argv: string[];
  env: Record<string, string>;
  request: OpWaveHoldRequest;
}

/** Read the hold file a hook wrote (#3821), or undefined when it wrote none or one that names no gate and digest. */
function readHoldRequest(path: string, log: (line: string) => void, label: string): OpWaveHoldRequest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const r = JSON.parse(readFileSync(path, "utf-8")) as Partial<OpWaveHoldRequest>;
    if (typeof r.gate !== "string" || r.gate === "" || typeof r.digest !== "string" || r.digest === "") throw new Error("it names no gate and digest");
    if (r.op !== undefined && (typeof r.op !== "string" || r.op === "")) throw new Error("its op is not a name");
    return { gate: r.gate, digest: r.digest, ...(r.op ? { op: r.op } : {}), ...(typeof r.description === "string" ? { description: r.description } : {}), ...(r.pending ? { pending: pendingFields(r.pending, `the hold ${label} wrote`) ?? {} } : {}) };
  } catch (err) {
    log(`${label} wrote a hold file that cannot be read (${err instanceof Error ? err.message : String(err)}), so it holds the wave on its set digest`);
    return undefined;
  }
}

/** Where hooks run: the wave they belong to and the job's tools. */
interface HookPlace {
  /** The spec's name and `op`. */
  name: string;
  op: string;
  waveName: string;
  k: number;
  cwd: string;
  exec: OpWaveExec;
  log: (line: string) => void;
}

/**
 * Run one moment's hooks, in order: each once for the wave, or once per run
 * for a `perRun` hook. A hook that fails stops the rest, unless its
 * `onFailure` is `approve`: then it holds the wave and the hooks after it run.
 */
function runHookList(
  at: HookPlace,
  moment: OpWaveHookMoment,
  hooks: readonly OpWaveHook[] | undefined,
  runs: readonly OpWaveHookRun[],
  runsPath: string,
  extraEnv: Record<string, string> = {},
): HooksOutcome & { outcomes: OpWaveHookOutcome[]; otherGates: OtherGateHold[] } {
  const out: HooksOutcome & { outcomes: OpWaveHookOutcome[]; otherGates: OtherGateHold[] } = { holds: [], outcomes: [], otherGates: [] };
  if (!hooks || hooks.length === 0) return out;
  const { name: specName, op, waveName, k, cwd, exec, log } = at;
  // #3821: a hook that holds the wave on another gate names it in this file.
  const holdPath = `.chant/op-waves/${specName}/wave-${k}/hold.json`;
  const env = { CHANT_OP_WAVES: specName, CHANT_WAVE: waveName, CHANT_WAVE_NUMBER: String(k), CHANT_HOOK: moment, CHANT_RUNS: runsPath, CHANT_HOLD: holdPath, ...extraEnv };
  for (const hook of hooks) {
    const name = hook.name ?? (hook.command.join(" ").length > 60 ? `${hook.command.join(" ").slice(0, 57)}...` : hook.command.join(" "));
    const calls = hook.perRun
      ? runs.map((run) => ({
          target: run.target as string | undefined,
          argv: opWaveArgv(hook.command, { op: run.op, wave: waveName, target: run.target, runs: runsPath, ...(run.plan ? { plan: run.plan } : {}) }),
          env: { ...env, CHANT_TARGET: run.target, ...(run.plan ? { CHANT_PLAN: run.plan } : {}) } as Record<string, string>,
        }))
      : [{ target: undefined, argv: opWaveArgv(hook.command, { op, wave: waveName, runs: runsPath }), env: env as Record<string, string> }];
    for (const call of calls) {
      const label = `${moment} hook ${name}${call.target ? ` (${call.target})` : ""}`;
      let code: number;
      rmSync(join(cwd, holdPath), { force: true });
      try {
        code = exec(call.argv, cwd, call.env);
      } catch (err) {
        log(`${label} did not run: ${err instanceof Error ? err.message : String(err)}`);
        code = 127;
      }
      const base = { moment, name, ...(call.target ? { target: call.target } : {}), exit: code };
      if (code === 0) {
        out.outcomes.push({ ...base, outcome: "passed" });
        continue;
      }
      if (hook.onFailure === "approve") {
        out.outcomes.push({ ...base, outcome: "held" });
        const request = readHoldRequest(join(cwd, holdPath), log, label);
        if (request) {
          out.otherGates.push({ label, name, moment, ...(call.target ? { target: call.target } : {}), argv: call.argv, env: call.env, request });
          log(`${label} exited ${code} and holds wave ${k} (${waveName}) on gate ${request.op ?? specName} / ${request.gate}, digest ${request.digest}`);
          continue;
        }
        out.holds.push(label);
        log(`${label} exited ${code}, so wave ${k} (${waveName}) waits for an approval of its set digest`);
        continue;
      }
      out.outcomes.push({ ...base, outcome: "failed" });
      out.failed = `${label} exited ${code}`;
      log(out.failed);
      return out;
    }
  }
  return out;
}

const placeOf = (ctx: WaveContext): HookPlace => ({ name: ctx.spec.name, op: ctx.spec.op, waveName: ctx.wave.name, k: ctx.k, cwd: ctx.cwd, exec: ctx.exec, log: ctx.log });

const hookRuns = (spec: OpWavesSpec, k: number, runs: readonly OpWaveRun[], members?: ReadonlyMap<string, OpWaveMember>): OpWaveHookRun[] =>
  runs.map((run) => ({ target: run.target, op: run.op ?? spec.op, ...(members?.has(run.target) ? { plan: opWavePlanPath(spec, k, run.target) } : {}) }));

/**
 * Run one moment's hooks in the wave job (#3762), recording each outcome on
 * the result. A hook that held the wave on another gate (#3821) has that
 * gate settled here: approved, the hook runs again with
 * `CHANT_HOLD_APPROVED`; otherwise the wave waits on it. The re-run passes,
 * or holds the wave on a further gate (#3847), settled the same way, up to
 * {@link OP_WAVE_MAX_CHAINED_HOLDS} gates per hook call.
 */
async function runHooks(
  ctx: WaveContext,
  moment: OpWaveHookMoment,
  hooks: readonly OpWaveHook[] | undefined,
  runs: readonly OpWaveRun[],
  members?: ReadonlyMap<string, OpWaveMember>,
  digest?: string,
  extraEnv: Record<string, string> = {},
): Promise<HooksOutcome> {
  if (!hooks || hooks.length === 0) return { holds: [] };
  const runsPath = writeRunsFile(ctx, runs, members, digest);
  const out = runHookList(placeOf(ctx), moment, hooks, hookRuns(ctx.spec, ctx.k, runs, members), runsPath, extraEnv);
  ctx.result.hooks.push(...out.outcomes);
  const back: HooksOutcome = { holds: out.holds, ...(out.failed ? { failed: out.failed } : {}) };
  if (out.failed) return back;
  for (const first of out.otherGates) {
    // #3847: an approved re-run may hold the wave on a further gate (a second state migration that plans against the first one's states), settled in turn.
    let hold = first;
    const approved: OpWaveHeldOnApproval[] = [];
    for (;;) {
      const held = await settleOtherGate(ctx, hold);
      if (held.status === "waiting") {
        if (approved.length > 0) held.after = approved;
        back.waitingOn ??= held;
        break;
      }
      const now: OpWaveHeldOnApproval = { op: held.op, gate: held.gate, digest: held.digest, approvedBy: held.approvedBy!, approvedAt: held.approvedAt! };
      approved.push(now);
      const approvedEnv = {
        ...hold.env,
        CHANT_HOLD_APPROVED: JSON.stringify(now),
        // Every hold this hook call was approved through so far, oldest first (#3847).
        CHANT_HOLDS_APPROVED: JSON.stringify(approved),
      };
      const holdPath = join(ctx.cwd, hold.env.CHANT_HOLD!);
      rmSync(holdPath, { force: true });
      let code: number;
      try {
        code = ctx.exec(hold.argv, ctx.cwd, approvedEnv);
      } catch (err) {
        ctx.log(`${hold.label} did not run: ${err instanceof Error ? err.message : String(err)}`);
        code = 127;
      }
      const target = hold.target ? { target: hold.target } : {};
      if (code === 0) {
        ctx.result.hooks.push({ moment, name: hold.name, ...target, exit: code, outcome: "passed" });
        ctx.log(`${hold.label}: ${held.approvedBy} approved ${held.op} / ${held.gate} at ${held.digest}, and the hook ran again and passed`);
        break;
      }
      const next = readHoldRequest(holdPath, ctx.log, hold.label);
      const problem = !next
        ? `${hold.label} exited ${code} after ${held.approvedBy} approved ${held.gate}`
        : approved.some((a) => a.op === (next.op ?? ctx.spec.name) && a.gate === next.gate && a.digest === next.digest)
          ? `${hold.label} exited ${code} after ${held.approvedBy} approved ${held.gate}, and holds the wave again on ${next.op ?? ctx.spec.name} / ${next.gate} at ${next.digest}, which is already approved`
          : approved.length >= OP_WAVE_MAX_CHAINED_HOLDS
            ? `${hold.label} held the wave on ${approved.length} gates in turn and asks for one more; a hook call holds on at most ${OP_WAVE_MAX_CHAINED_HOLDS}`
            : undefined;
      if (problem) {
        ctx.result.hooks.push({ moment, name: hold.name, ...target, exit: code, outcome: "failed" });
        back.failed = problem;
        ctx.log(back.failed);
        return back;
      }
      ctx.result.hooks.push({ moment, name: hold.name, ...target, exit: code, outcome: "held" });
      ctx.log(`${hold.label}: ${held.approvedBy} approved ${held.op} / ${held.gate}; the hook ran again, exited ${code} and holds wave ${ctx.k} (${ctx.wave.name}) on gate ${next!.op ?? ctx.spec.name} / ${next!.gate}, digest ${next!.digest}`);
      hold = { ...hold, request: next! };
    }
  }
  return back;
}

/** How many gates one hook call holds a wave on in turn (#3847): the first hold and the holds its approved re-runs ask for. */
export const OP_WAVE_MAX_CHAINED_HOLDS = 10;

/**
 * The gate ledger a wave decides by: the job's port, its `identity.gates`
 * rule read at the wave's base (#3841), and the signers at base as a second
 * rule when `approval` is `sealed`.
 */
async function gatePort(options: RunOpWaveOptions, cwd: string, gate: string, approval: GateApprovalSource, base: string): Promise<{ ledger: GateLedgerPort; port: GateLedgerPort }> {
  const ledger = options.gates ?? gitGateLedgerPort({ cwd });
  const atBase = (g: string) => ledger.approvalRule?.(g, { base }) ?? Promise.resolve(null);
  if (approval !== "sealed") return { ledger, port: ledger.approvalRule ? { ...ledger, approvalRule: atBase } : ledger };
  // #3684: only an approval sealed by a signer listed at base counts.
  const review = await import("./gate-review");
  const sealed = review.sealedApprovalRule(gate, (options.trust ?? ((b) => review.trustPolicyAt(cwd, b)))(base));
  return {
    ledger,
    port: {
      ...ledger,
      async approvalRule(g) {
        const own = await atBase(g);
        return g === gate ? review.bothRules(own, sealed) : own;
      },
    },
  };
}

/** Log each approval of the digest a rule did not count (#3841), so a wait says why. */
function logRefused(log: (line: string) => void, label: string, check: GateCheck): void {
  if (check.satisfied) return;
  for (const { resolution: r, reason } of check.refused ?? []) log(`${label}: the approval by ${r.resolvedBy} at ${r.timestamp} does not count: ${reason}`);
}

/**
 * Settle a hold on another gate (#3821): an approval of that gate and digest
 * under the wave's approval mode (`pr-review` counts the ledger alone, since
 * no review planned that digest), else a pending fact for it.
 */
async function settleOtherGate(ctx: WaveContext, hold: OtherGateHold): Promise<OpWaveHeldOn> {
  const { spec, k, wave, log } = ctx;
  const rules = ctx.gateRule;
  const op = hold.request.op ?? spec.name;
  const mode: GateApprovalSource = rules.approval === "sealed" ? "sealed" : "ledger";
  const { port } = await gatePort(ctx.options, ctx.cwd, hold.request.gate, mode, rules.base);
  const neverOverMcp = rules.neverOverMcp;
  const now = ctx.options.now ?? new Date().toISOString();
  const check = await evaluateGate(port, {
    op,
    gate: hold.request.gate,
    planDigest: hold.request.digest,
    description: hold.request.description ?? `wave ${k} (${wave.name}) of ${spec.name} is held on it by ${hold.label}`,
    now,
    // #3839: the wave a hold belongs to, as a field, whatever the hook's own description says.
    fields: { ...hold.request.pending, approvalMode: rules.approval, wave: { number: k, name: wave.name, op: spec.name }, heldBy: { hook: hold.name, moment: hold.moment, ...(hold.target ? { target: hold.target } : {}) } },
    ...(neverOverMcp ? { neverOverMcp: true } : {}),
  });
  const base = { op, gate: hold.request.gate, digest: hold.request.digest, hook: hold.label };
  logRefused(log, `${op} / ${hold.request.gate}`, check);
  if (check.satisfied) return { ...base, status: "approved", approvedBy: check.resolution.resolvedBy, approvedAt: check.resolution.timestamp };
  const approve = approveCommand(op, hold.request.gate, undefined, hold.request.digest, mode === "sealed");
  log(`wave ${k} (${wave.name}) waits on ${op} / ${hold.request.gate}, which ${hold.label} holds it on: nobody approved ${hold.request.digest}. Approve: ${approve}`);
  return {
    ...base,
    status: "waiting",
    approve,
    waitingSince: check.pending.timestamp,
    recorded: check.recorded,
    ...(check.mismatch ? { mismatch: check.mismatch } : {}),
  };
}

/**
 * Read the hooks file chant hands an apply command (#3804): the one at
 * `path`, by default `CHANT_HOOKS`. Null when there is none, as for an apply
 * that a wave job did not start.
 */
export function readOpWaveHooksFile(path: string | undefined = process.env.CHANT_HOOKS, cwd: string = process.cwd()): OpWaveHooksFile | null {
  if (!path) return null;
  const at = isAbsolute(path) ? path : join(cwd, path);
  let parsed: OpWaveHooksFile;
  try {
    parsed = JSON.parse(readFileSync(at, "utf-8")) as OpWaveHooksFile;
  } catch (err) {
    throw new Error(`the hooks file ${path} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.runs) || typeof parsed.hooks !== "object") throw new Error(`${path} is not an Op waves hooks file (version 1)`);
  return parsed;
}

/**
 * Run one moment's hooks from a hooks file (#3804): what an apply command
 * calls under its own lock, `before-apply` right before it changes anything
 * and `after-apply` once it has, when the spec's `hooks.apply.runBy` at base
 * is `apply`. Also what a product's apply outside the waves calls, with a
 * file from {@link opWaveHooksAtBase}. A moment the file has no hooks for
 * runs nothing and proceeds, so an apply can call it whoever runs the hooks.
 *
 * Each call adds its outcomes to the file's `result` (`CHANT_HOOKS_RESULT`),
 * which chant reads back after the apply exits: the outcomes join the wave's
 * result and decision record, and a hold makes the wave wait for, or find,
 * an approval of its digest. `skip: "<reason>"` runs nothing and records the
 * moment as skipped with the reason (#3811), for an apply that changes nothing:
 * chant counts the moment as handled. A skip without a reason throws. `exec` runs one hook; inject it to run a hook
 * in process or to keep its output.
 */
export function runOpWaveApplyHooks(file: OpWaveHooksFile, moment: OpWaveHookMoment, options: RunOpWaveApplyHooksOptions = {}): OpWaveApplyHooksRun {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.error(line));
  let run: OpWaveApplyHooksRun;
  if (options.skip !== undefined) {
    const reason = options.skip.trim();
    if (!reason) throw new Error(`skipping the ${moment} hooks needs a reason (skip: "nothing to apply")`);
    log(`${moment} hooks skipped: ${reason}`);
    run = { moment, outcomes: [{ moment, name: "skip", exit: 0, outcome: "skipped", reason }], held: [], proceed: true };
  } else if (file.refused) {
    log(`${file.refused}, so none of the ${moment} hooks run and the apply does not go on`);
    run = { moment, outcomes: [], held: [file.refused], proceed: false };
  } else {
    const place: HookPlace = { name: file.opWaves, op: file.op, waveName: file.wave, k: file.number, cwd, exec: options.exec ?? spawnExec, log };
    const out = runHookList(place, moment, file.hooks[moment], file.runs, file.runsFile);
    // A hold on another gate (#3821) is settled only by the wave job; under the apply's lock it stops the apply.
    const others = out.otherGates.map((o) => `${o.label} on ${o.request.op ?? file.opWaves} / ${o.request.gate}`);
    run = {
      moment,
      outcomes: out.outcomes,
      ...(out.failed ? { failed: out.failed } : {}),
      held: [...out.holds, ...others],
      proceed: !out.failed && others.length === 0 && (out.holds.length === 0 || file.approved),
    };
  }
  if (file.result) {
    const at = isAbsolute(file.result) ? file.result : join(cwd, file.result);
    let prior: OpWaveHooksResult = { version: 1, moments: [], outcomes: [] };
    if (existsSync(at)) {
      try {
        prior = JSON.parse(readFileSync(at, "utf-8")) as OpWaveHooksResult;
      } catch {
        // A result file that cannot be read is started again.
      }
    }
    const next: OpWaveHooksResult = { version: 1, moments: [...prior.moments, moment], outcomes: [...prior.outcomes, ...run.outcomes] };
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, JSON.stringify(next, null, 2) + "\n");
  }
  return run;
}

/**
 * The hooks of wave `wave` read at base, for an apply outside the waves
 * (#3804): a product's own `apply <env>` that runs the same Op as the wave
 * does, and the same hooks. All four moments are in the file; the apply runs
 * the ones it has a stage for with {@link runOpWaveApplyHooks}. Nothing is
 * approved: a held hook stops the apply. The wave or the file missing at
 * base has no hooks, as in a wave job.
 */
export function opWaveHooksAtBase(options: {
  specFile: string;
  wave: string;
  /** The runs this apply applies. Default: the wave's runs in the working tree's spec. */
  runs?: ReadonlyArray<{ target: string; op?: string }>;
  /** Default: the spec's `base`, else `HEAD^1`. */
  base?: string;
  cwd?: string;
  show?: OpWaveShowAtBase;
}): OpWaveHooksFile {
  const cwd = options.cwd ?? process.cwd();
  const spec = parseOpWavesSpec(readFileSync(isAbsolute(options.specFile) ? options.specFile : join(cwd, options.specFile), "utf-8"), options.specFile);
  const k = spec.waves.findIndex((w) => w.name === options.wave) + 1;
  const rules = readOpWavePolicy(options.specFile, options.wave, options.base ?? spec.base ?? "HEAD^1", cwd, options.show);
  const runs = (options.runs ?? spec.waves[k - 1]?.runs ?? []).map((r) => ({ target: r.target, op: r.op ?? spec.op }));
  const runsFile = `.chant/op-waves/${spec.name}/${options.wave.replace(/[^A-Za-z0-9._-]/g, "_")}.runs.json`;
  const runsBody: OpWaveRunsFile = { wave: options.wave, number: k, runs };
  mkdirSync(dirname(join(cwd, runsFile)), { recursive: true });
  writeFileSync(join(cwd, runsFile), JSON.stringify(runsBody, null, 2) + "\n");
  const hooks = Object.fromEntries(Object.entries(rules.hooks).filter(([, list]) => list.length > 0));
  return {
    version: 1,
    opWaves: spec.name,
    op: spec.op,
    wave: options.wave,
    number: k,
    base: rules.base,
    approved: false,
    runBy: "apply",
    runs,
    runsFile,
    hooks,
    outcomes: [],
    ...(rules.hooksRefused ? { refused: rules.hooksRefused } : {}),
  };
}

/** Whether `policy` lets a wave with these members through without an approval. */
export function opWaveNeedsApproval(policy: OpWaveGatePolicy, members: readonly OpWaveMember[]): boolean {
  if (policy === "never") return false;
  if (members.every((m) => m.empty === true)) return false;
  if (policy === "on-destructive") return members.some((m) => m.destructive === true);
  return true;
}

/** Log when the change's hooks are not the ones at base, which are the ones that run. */
function noteHooksAtBase(ctx: WaveContext, rules: OpWaveBaseRules): void {
  const { hooks: atBase, base } = rules;
  const own = opWaveHooksAt(ctx.spec, ctx.wave.name);
  if (JSON.stringify(own) !== JSON.stringify(atBase) || opWaveApplyHooksRunBy(ctx.spec, ctx.wave.name) !== rules.applyHooksRunBy) {
    ctx.log(`wave ${ctx.k} (${ctx.wave.name}): its hooks are read at ${base.slice(0, 12)}, and this change's differ; the ones at base run`);
  }
}

/**
 * Plan, decide and apply one wave, or one part of a wide wave: the wave
 * engine's loop (`runWaveLoop`, #3766) over this module's steps. An apply
 * that comes back `replan` plans the wave again (#3821), at most
 * {@link OP_WAVE_MAX_REPLANS} times; a `rest` wave goes on through the waves
 * its plan command found.
 */
export async function runOpWave(options: RunOpWaveOptions): Promise<RunOpWaveResult> {
  const { spec } = options;
  assertOpWavesSpec(spec);
  const log = options.log ?? ((line: string) => console.error(line));
  const last = spec.waves[spec.waves.length - 1]!;
  const applied: string[] = [];
  const rest: NonNullable<RunOpWaveResult["rest"]> = [];
  const result = await runWaveLoop<OpWavePlanned, OpWaveDecided, RunOpWaveResult>({
    first: options.wave,
    plan: (at) => planOpWave(options, at),
    // A share job applies under the digest its deciding job recorded; it does not take the set digest again.
    digest: (_at, planned) => (planned.kind === "share" ? planned.decision.digest : opWaveSetDigest(spec, planned.members, planned.extras)),
    decide: (at, planned, digest) => (planned.kind === "share" ? shareUnmoved(planned) : decideOpWave(options, at, planned, digest)),
    apply: (_at, planned, decided) => applyOpWave(options, planned, decided),
    replan: (_at, outcome) => outcome.replan !== undefined,
    maxPasses: OP_WAVE_MAX_REPLANS,
    passesSpent({ k }, outcome) {
      log(`wave ${k}: its apply asked to plan again ${OP_WAVE_MAX_REPLANS} times, so the wave stops here`);
      outcome.exitCode = 1;
      return outcome;
    },
    replanning({ k }, outcome) {
      log(`wave ${k}: the apply applied nothing and asks to plan again${outcome.replan!.reason ? ` (${outcome.replan!.reason})` : ""}; planning again`);
    },
    onward(k, outcome) {
      applied.push(...outcome.applied);
      // #3821: a `rest` wave goes on through the waves its plan command found.
      const found = outcome.decision?.discovered?.waves;
      const onward = k >= spec.waves.length && last.rest === true && options.share === undefined && options.group === undefined && !options.decide && outcome.exitCode === 0 && found !== undefined && k < found;
      if (rest.length > 0 || onward) rest.push({ wave: k, exitCode: outcome.exitCode, ...(outcome.decision ? { digest: outcome.decision.digest } : {}) });
      if (onward) log(`wave ${k} applied; the plan found ${found} waves, so this job goes on to wave ${k + 1}`);
      return onward;
    },
  });
  return { ...result, applied, ...(rest.length > 0 ? { rest } : {}) };
}

/** What a share or job group's job calls itself in the log: `share 2`, `job group "prod"`, `share 2 of job group "prod"`. */
function shareLabel(options: Pick<RunOpWaveOptions, "share" | "group">): string {
  if (options.group === undefined) return `share ${options.share}`;
  return `${options.share !== undefined ? `share ${options.share} of ` : ""}job group "${options.group}"`;
}

/** How many times one wave job plans again when its apply asks to (#3821). */
export const OP_WAVE_MAX_REPLANS = 10;

/**
 * What planning one pass of a wave gave. `decide`: the deciding job (or a
 * narrow wave's only job), with the rules read at base and the decision it
 * fills in. `share`: a share job (`--share i`), with its deciding job's
 * decision and the slice it planned again.
 */
type OpWavePlanned =
  | {
      kind: "decide";
      ctx: WaveContext;
      recordPath: string;
      rules: OpWaveBaseRules;
      decision: OpWaveDecision;
      /** The holds so far: the hooks at base that cannot be run (#3762). */
      holds: string[];
      /** The holds of the before-plan hooks. */
      before: string[];
      members: OpWaveMember[];
      planned: Map<string, OpWaveMember>;
      pending?: Record<string, unknown>;
      overriders?: string[];
      overridersSource?: string;
      extras?: WaveMember[];
    }
  | {
      kind: "share";
      ctx: WaveContext;
      decision: OpWaveDecision;
      slice: OpWaveRun[];
      planned: Map<string, OpWaveMember>;
      /** The holds of the before-plan and after-plan hooks. */
      holds: string[];
    };

/** What a decided wave applies: these runs, with the holds of the hooks so far, writing the record at `recordPath` when the job owns it. */
interface OpWaveDecided {
  runs: readonly OpWaveRun[];
  earlierHolds: readonly string[];
  recordPath?: string;
}

/**
 * Plan wave `k`: read its rules at base and run the before-plan hooks
 * around planning its runs, or for a share job, read the deciding job's
 * decision and plan the share's slice between its hooks. Ends the wave when
 * a hook fails or holds it on another gate, or a share's decision waits or
 * was refused.
 */
async function planOpWave(options: RunOpWaveOptions, { k, pass }: WaveAttempt<RunOpWaveResult>): Promise<WaveStep<OpWavePlanned, RunOpWaveResult>> {
  const { spec } = options;
  const cwd = options.cwd ?? process.cwd();
  const exec = options.exec ?? spawnExec;
  const log = options.log ?? ((line: string) => console.error(line));
  const last = spec.waves[spec.waves.length - 1]!;
  // #3821: past the spec's waves, a `rest` wave stands for each wave its plan command found.
  let wave = spec.waves[k - 1] ?? (last.rest ? last : undefined);
  if (!wave) throw new Error(`Op waves "${spec.name}" has ${spec.waves.length} waves; there is no wave ${k}.`);
  // #3914: a job group's job is a share job over the group's runs, split by the group's own shares.
  const group = options.group === undefined ? undefined : wave.jobs?.find((g) => g.name === options.group);
  if (options.group !== undefined && !group) {
    const names = (wave.jobs ?? []).map((g) => g.name);
    throw new Error(`wave ${k} (${wave.name}) has ${names.length > 0 ? `the job groups ${names.join(", ")}` : "no job groups"}; there is no group "${options.group}".`);
  }
  if (options.share !== undefined && options.group === undefined && wave.jobs !== undefined) {
    throw new Error(`wave ${k} (${wave.name}) is split into job groups; name the group a share belongs to with --group.`);
  }
  const shares = group ? (group.shares ?? 1) : (wave.shares ?? 1);
  if (options.share !== undefined && (options.share < 1 || options.share > shares)) {
    throw new Error(`${group ? `job group "${group.name}" of ` : ""}wave ${k} (${wave.name}) has ${shares} share${shares === 1 ? "" : "s"}; there is no share ${options.share}.`);
  }
  const part = shareLabel(options);
  const recordPath = join(cwd, opWaveRecordPath(spec, k));
  const result: RunOpWaveResult = { exitCode: 0, applied: [], failed: [], moved: [], hooks: [] };
  const ctx: WaveContext = { spec, k, wave, cwd, exec, log, result, options, gateRule: { approval: "ledger", base: "HEAD", neverOverMcp: spec.neverOverMcp === true } };
  if (pass > 0) log(`wave ${k} (${wave.name}): plan ${pass + 1}`);

  if (options.share !== undefined || group !== undefined) {
    let decision: OpWaveDecision;
    try {
      decision = JSON.parse(readFileSync(recordPath, "utf-8")) as OpWaveDecision;
    } catch {
      throw new Error(`${part} of wave ${k} (${wave.name}) found no decision at ${opWaveRecordPath(spec, k)}. Run the deciding job first.`);
    }
    result.decision = decision;
    ctx.gateRule = { approval: decision.approval, base: decision.base, neverOverMcp: decision.neverOverMcp === true };
    if (decision.status === "waiting" || decision.status === "refused") {
      log(`wave ${k} (${wave.name}) is ${decision.status === "refused" ? "refused by its policy" : `waiting on ${decision.heldOn?.gate ?? decision.gate}`}; nothing applied. ${decision.approve ?? ""}`.trim());
      return { end: { ...result, exitCode: decision.status === "refused" ? refusedExit(decision) : 3 } };
    }
    // The share runs the hooks its deciding job read at base, around its own slice.
    if (wave.discover) {
      // #3821: a discovering wave's runs are the ones its deciding job planned.
      wave = { ...wave, runs: decision.members.map((m) => ({ target: m.member, ...(m.op !== spec.op ? { op: m.op } : {}) })) };
      ctx.wave = wave;
    }
    const slice = opWaveShare(group ? opWaveGroupRuns(group, wave.runs) : wave.runs, options.share ?? 1, shares);
    if (group && slice.length === 0) {
      log(`${part} of wave ${k} (${wave.name}) holds none of the wave's runs; nothing to apply`);
      return { end: result };
    }
    const before = await runHooks(ctx, "before-plan", decision.hooks?.["before-plan"], slice);
    if (before.failed) return { end: failed(ctx, `a hook before the plan failed, so nothing in ${part} of wave ${k} was planned or applied`) };
    if (before.waitingOn) return { end: await waitOnOther(ctx, decision, before.waitingOn) };
    const { members } = planRuns(ctx, slice);
    const planned = new Map(members.map((m) => [m.member, m]));
    const after = await runHooks(ctx, "after-plan", decision.hooks?.["after-plan"], slice, planned);
    if (after.failed) return { end: failed(ctx, `a hook after the plan failed, so nothing in ${part} of wave ${k} was applied`) };
    if (after.waitingOn) return { end: await waitOnOther(ctx, decision, after.waitingOn) };
    return { go: { kind: "share", ctx, decision, slice, planned, holds: [...before.holds, ...after.holds] } };
  }

  // The policy, the approval mode and the hooks, read at base before anything runs.
  const rules = readOpWavePolicy(options.specFile, wave.name, options.base ?? spec.base ?? "HEAD^1", cwd, options.show);
  const { policy, approval, source, base } = rules;
  const neverOverMcp = rules.neverOverMcp || spec.neverOverMcp === true;
  ctx.gateRule = { approval, base, neverOverMcp };
  noteHooksAtBase(ctx, rules);
  // #3836: a point at base that cannot be asked fails the wave; the ledger never stands in for it.
  if (rules.pointRefused) return { end: failed(ctx, `wave ${k} (${wave.name}): ${rules.pointRefused}, so nothing in it was planned or applied`) };
  const own = opWavePointAt(spec, wave.name);
  if (JSON.stringify(own) !== JSON.stringify(rules.point)) {
    log(`wave ${k} (${wave.name}): its gate's decision point is read at ${base.slice(0, 12)} (${rules.point?.name ?? "none"}), and this change's differs (${own?.name ?? "none"}); the one at base holds`);
  }
  const holds: string[] = [];
  if (rules.hooksRefused) {
    holds.push(rules.hooksRefused);
    log(`wave ${k} (${wave.name}): ${rules.hooksRefused}, so none run and the wave waits for an approval`);
  }
  const gate = opWaveGateName(spec, k);
  const hooks = Object.fromEntries(Object.entries(rules.hooks).filter(([, list]) => list.length > 0));
  const decision: OpWaveDecision = {
    wave: k,
    name: wave.name,
    op: spec.name,
    gate,
    policy,
    approval,
    policySource: source,
    base,
    digest: "",
    members: [],
    status: "not-required",
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(rules.spend ? { spend: "base" as const } : spec.approvals?.spend === true ? { spend: "change" as const } : {}),
    ...(rules.applyHooksRunBy === "apply" ? { applyHooksRunBy: "apply" as const } : {}),
    ...(spec.digest?.over === "changing" ? { digestOver: "changing" as const } : {}),
    ...(neverOverMcp ? { neverOverMcp: true as const } : {}),
    ...(rules.point ? { point: { ...rules.point } } : {}),
  };
  const before = await runHooks(ctx, "before-plan", rules.hooks["before-plan"], wave.runs);
  if (before.failed) return { end: failed(ctx, `a hook before the plan failed, so nothing in wave ${k} was planned or applied`) };
  if (before.waitingOn) return { end: await decided(ctx, decision, recordPath, before.waitingOn) };
  const { members, pending, overriders, overridersSource, extras, waves: found } = planRuns(ctx, wave.runs, wave.discover === true);
  if (wave.discover) {
    wave = { ...wave, runs: members.map((m) => ({ target: m.member, ...(m.op !== spec.op ? { op: m.op } : {}) })) };
    ctx.wave = wave;
    decision.discovered = { ...(found !== undefined ? { waves: found } : {}) };
    log(`wave ${k} (${wave.name}): the plan found ${members.length} run${members.length === 1 ? "" : "s"}${found !== undefined ? ` of ${found} waves` : ""}${members.length ? `: ${members.map((m) => m.member).join(", ")}` : ""}`);
    // #3914: each run found is in exactly one job group, or no group's job could apply it.
    const problem = wave.jobs ? opWaveGroupsProblem(wave, members.map((m) => m.member)) : undefined;
    if (problem) return { end: failed(ctx, `wave ${k} (${wave.name}): ${problem}, so nothing in it was applied`) };
  }
  const planned = new Map(members.map((m) => [m.member, m]));
  return {
    go: {
      kind: "decide",
      ctx,
      recordPath,
      rules,
      decision,
      holds,
      before: before.holds,
      members,
      planned,
      ...(pending ? { pending } : {}),
      ...(overriders ? { overriders } : {}),
      ...(overridersSource ? { overridersSource } : {}),
      ...(extras ? { extras } : {}),
    },
  };
}

/**
 * A share job's decision is its deciding job's: it applies the runs of its
 * slice whose plan has not moved since, and names each one that has.
 */
async function shareUnmoved(planned: Extract<OpWavePlanned, { kind: "share" }>): Promise<WaveStep<OpWaveDecided, RunOpWaveResult>> {
  const { ctx, decision, slice, holds } = planned;
  const decidedDigests = new Map(decision.members.map((m) => [m.member, m.planDigest]));
  const unmoved: OpWaveRun[] = [];
  for (const run of slice) {
    const now = planned.planned.get(run.target)!;
    if (decidedDigests.get(run.target) !== now.planDigest) {
      ctx.log(
        `${run.target}: its plan moved since wave ${ctx.k} was decided, so it was not applied. ` +
          `decided: ${decidedDigests.get(run.target) ?? "(not in the decision)"}; planned now: ${now.planDigest}`,
      );
      ctx.result.moved.push(run.target);
      continue;
    }
    unmoved.push(run);
  }
  return { go: { runs: unmoved, earlierHolds: holds } };
}

/**
 * Decide wave `k` against its set digest: run the after-plan hooks, settle
 * the product's denials and the gate under the rules read at base, write the
 * decision record and run the after-gate hooks. Ends the wave when it waits,
 * is refused or failed, and for a deciding job (`--decide`), which spends the
 * approval and overrides its shares apply under and applies nothing.
 */
async function decideOpWave(
  options: RunOpWaveOptions,
  { prior }: WaveAttempt<RunOpWaveResult>,
  planned: Extract<OpWavePlanned, { kind: "decide" }>,
  digest: string,
): Promise<WaveStep<OpWaveDecided, RunOpWaveResult>> {
  const { ctx, recordPath, decision, holds, members, pending, overriders, overridersSource, extras } = planned;
  const { k, wave, log, result } = ctx;
  const { policy, source, base } = planned.rules;
  decision.digest = digest;
  decision.members = members;
  if (extras) decision.extras = extras;
  if (pending) decision.pending = pending;
  const after = await runHooks(ctx, "after-plan", planned.rules.hooks["after-plan"], wave.runs, planned.planned, digest);
  if (after.failed) return { end: failed(ctx, `a hook after the plan failed, so nothing in wave ${k} was applied`) };
  holds.push(...planned.before, ...after.holds);
  if (holds.length > 0) decision.heldBy = holds;
  if (after.waitingOn) return { end: await decided(ctx, decision, recordPath, after.waitingOn) };
  // #3821: a run the product's policy denied applies only under an override; with none the wave is refused, and no approval is waited for.
  const was = prior?.decision;
  const kept = was !== undefined && (was.status === "approved" || was.status === "not-required") && was.digest === digest;
  if (kept) {
    // The overrides this job applied under, and spent, still let the same plans through.
    const byRun = new Map(was.members.map((m) => [m.member, m.override]));
    for (const m of members) if (m.denied && byRun.get(m.member)) m.override = byRun.get(m.member);
    if (was.overridesSpentAt) decision.overridesSpentAt = was.overridesSpentAt;
  }
  if (members.some((m) => m.denied && !m.override)) await settleDenials(ctx, decision, overriders, overridersSource);
  if (kept && was.status === "approved" && decision.status !== "refused") {
    // #3821: planned again after the apply asked to, to the same digest: the approval this job found still holds, and is not spent twice.
    for (const key of ["via", "approvedBy", "approvedAt", "review", "spentAt"] as const) if (was[key] !== undefined) (decision as unknown as Record<string, unknown>)[key] = was[key];
    decision.status = "approved";
    log(`wave ${k} (${wave.name}): planned again to the same digest, so the approval by ${was.approvedBy} still holds`);
  } else if (decision.status !== "refused" && (opWaveNeedsApproval(policy, members) || holds.length > 0)) await settleGate(options, ctx, decision);
  const code = await decided(ctx, decision, recordPath);
  if (code.exitCode !== 0) return { end: code };
  log(
    `wave ${k} (${wave.name}): gate ${policy} (read at ${base.slice(0, 12)}${source === "absent-at-base" ? ", where the wave is absent" : ""}), ` +
      `digest ${digest}: ${decision.status}${decision.approvedBy ? ` by ${decision.approvedBy}` : ""}` +
      (decision.via === "pr-review" ? ` (review of #${decision.review?.pr})` : "") +
      (holds.length > 0 ? `; held by ${holds.join(", ")}` : ""),
  );
  // A wide wave's shares apply under the deciding job's approval and overrides, so they are spent here, once.
  if (options.decide) {
    if (!(await spendApproval(options, ctx, decision)) || !(await spendOverrides(ctx, decision))) return { end: ctx.result };
    if (decision.spentAt || decision.overridesSpentAt) writeRecord(recordPath, decision, result);
    return { end: result };
  }
  return { go: { runs: wave.runs, earlierHolds: [], recordPath } };
}

/** Apply a decided wave, or a share's unmoved runs (exit 4 when any moved). */
async function applyOpWave(options: RunOpWaveOptions, planned: OpWavePlanned, decidedWave: OpWaveDecided): Promise<RunOpWaveResult> {
  const { ctx, decision } = planned;
  await applyStage(options, ctx, decision, decidedWave.runs, planned.planned, decidedWave.earlierHolds, decidedWave.recordPath);
  if (planned.kind === "share" && ctx.result.exitCode === 0 && ctx.result.moved.length > 0) ctx.result.exitCode = 4;
  return ctx.result;
}

/**
 * The gate has decided (#3821): write the decision record, run the
 * `after-gate` hooks with the decision in their environment, and say whether
 * the wave goes on. Returns the result with exit 3 when it waits, 7 when its
 * policy refused it, 1 when an `after-gate` hook failed on a wave that would
 * apply; exit 0 to go on. A hook that fails while the wave waits or is
 * refused is logged and leaves the exit code alone.
 */
async function decided(ctx: WaveContext, decision: OpWaveDecision, recordPath: string, heldOn?: OpWaveHeldOn): Promise<RunOpWaveResult> {
  const { k, wave, log, result } = ctx;
  if (heldOn) markHeldOn(decision, heldOn);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeRecord(recordPath, decision, result);
  result.decision = decision;
  if (decision.approval === "pr-review" && decision.status === "waiting" && decision.review?.reason) {
    log(`The pull request's review does not approve wave ${k}: ${decision.review.reason}`);
  }
  const hook = await runGateHooks(ctx, decision, recordPath);
  if (decision.status === "waiting") {
    log(`Nothing in wave ${k} or after it ran. ${decision.heldOn ? `It waits on ${decision.heldOn.op} / ${decision.heldOn.gate}.` : "Read the plans, then"} approve: ${decision.approve} (with --resume, the approval also starts this job again)`);
    return { ...result, exitCode: 3 };
  }
  if (decision.status === "refused" && decision.refused?.reason === "point") {
    log(`Nothing in wave ${k} (${wave.name}) or after it ran: ${decision.refused.message}`);
    return { ...result, exitCode: 8 };
  }
  if (decision.status === "refused") {
    log(`Nothing in wave ${k} (${wave.name}) or after it ran: the policy denied ${decision.refused?.runs.join(", ")}, and no override counts for ${decision.refused?.runs.length === 1 ? "it" : "them"}.`);
    return { ...result, exitCode: 7 };
  }
  if (hook.failed) return failed(ctx, `wave ${k} (${wave.name}): ${hook.failed}, so nothing in it was applied`);
  return result;
}

/** A hold on another gate that waits makes the wave wait on it (#3821). */
function markHeldOn(decision: OpWaveDecision, heldOn: OpWaveHeldOn): void {
  decision.heldOn = heldOn;
  decision.status = "waiting";
  decision.approve = heldOn.approve;
  if (heldOn.waitingSince) decision.waitingSince = heldOn.waitingSince;
  if (heldOn.recorded !== undefined) decision.recorded = heldOn.recorded;
}

/** A share job held on another gate that waits (#3821). */
async function waitOnOther(ctx: WaveContext, decision: OpWaveDecision, heldOn: OpWaveHeldOn): Promise<RunOpWaveResult> {
  markHeldOn(decision, heldOn);
  ctx.log(`${shareLabel(ctx.options)} of wave ${ctx.k} (${ctx.wave.name}) waits on ${heldOn.op} / ${heldOn.gate}; nothing in it applied. Approve: ${heldOn.approve}`);
  return { ...ctx.result, decision, exitCode: 3 };
}

/**
 * Run the `after-gate` hooks (#3821) once the gate decided. Their
 * environment carries the decision: `CHANT_GATE_STATUS` (`approved`,
 * `not-required`, `waiting` or `refused`), `CHANT_GATE_OP`, `CHANT_GATE`,
 * `CHANT_GATE_DIGEST`, `CHANT_DECISION` (the decision record, with the
 * standing pending fact, the approval of another digest and the denials),
 * and when set `CHANT_GATE_APPROVE`, `CHANT_GATE_WAITING_SINCE` and
 * `CHANT_GATE_RECORDED` (`true` when this run recorded the pending fact).
 */
async function runGateHooks(ctx: WaveContext, decision: OpWaveDecision, recordPath: string): Promise<HooksOutcome> {
  const list = decision.hooks?.["after-gate"];
  if (!list?.length) return { holds: [] };
  const on = decision.heldOn;
  const env: Record<string, string> = {
    CHANT_GATE_STATUS: decision.status,
    CHANT_GATE_OP: on?.op ?? decision.op,
    CHANT_GATE: on?.gate ?? decision.gate,
    CHANT_GATE_DIGEST: on?.digest ?? decision.digest,
    CHANT_DECISION: relativeTo(ctx.cwd, recordPath),
    ...(decision.approve ? { CHANT_GATE_APPROVE: decision.approve } : {}),
    ...(decision.waitingSince ? { CHANT_GATE_WAITING_SINCE: decision.waitingSince } : {}),
    ...(decision.recorded !== undefined ? { CHANT_GATE_RECORDED: String(decision.recorded) } : {}),
  };
  const planned = new Map(decision.members.map((m) => [m.member, m]));
  const out = await runHooks(ctx, "after-gate", list, ctx.wave.runs, planned.size > 0 ? planned : undefined, decision.digest || undefined, env);
  writeRecord(recordPath, decision, ctx.result);
  if (out.failed && decision.status !== "approved" && decision.status !== "not-required") ctx.log(`${out.failed}; the wave is ${decision.status} whatever the hook came to`);
  return out;
}

function relativeTo(cwd: string, path: string): string {
  return path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

/**
 * Decide each run the product's policy denied (#3821) against the override
 * ledger, `_gates/policy-override.jsonl`, as `@intentius/chant/override-gate`
 * decides: an override counts when a listed overrider wrote it for this run,
 * its plan digest and its rules, gave a reason, and (under `sealed`) sealed
 * it. Overridden runs carry their override; with any run still denied the
 * decision is `refused`, and each such run gets a pending fact on the
 * override ledger unless one stands.
 */
async function settleDenials(ctx: WaveContext, decision: OpWaveDecision, listed: string[] | undefined, source?: string): Promise<void> {
  const { spec, k, wave, cwd, log, options } = ctx;
  const og = await import("../override-gate");
  const port = options.gates ?? gitGateLedgerPort({ cwd });
  const path = spec.override?.overriders ?? og.OVERRIDERS_PATH;
  const overriders = listed ?? og.overridersAt(cwd, decision.base, path).principals;
  const sealed = decision.approval === "sealed";
  const signers = sealed ? (options.signers ?? (await import("../gate-decision")).gateSignersAt.bind(null, cwd))(decision.base) : undefined;
  const ledger = await port.read(og.OVERRIDE_OP);
  const applied = ((await port.readApplied?.(og.OVERRIDE_OP)) ?? []) as unknown as import("../override-gate").AppliedOverrideRecord[];
  const now = options.now ?? new Date().toISOString();
  const still: string[] = [];
  let moved = false;
  for (const m of decision.members) {
    if (!m.denied || m.override) continue;
    const verdict = og.decideOverride({
      ledger,
      applied,
      subject: m.member,
      planDigest: m.planDigest,
      rules: m.denied.rules,
      overriders,
      overridersPath: listed ? (source ?? "the overriders the plans file names") : path,
      mode: sealed ? "sealed" : "ledger",
      ...(signers ? { signers } : {}),
      now,
    });
    if (verdict.status === "overridden") {
      const o = verdict.override;
      m.override = { by: o.by, at: o.at, digest: o.digest, reason: o.reason };
      log(`${m.member}: the policy denial (${o.rules.join(", ")}) is overridden by ${o.by} at ${o.at}${o.sealed ? ", sealed" : ""}: ${o.reason}`);
      continue;
    }
    still.push(m.member);
    for (const why of verdict.refusals) log(`${m.member}: an override does not count: ${why}`);
    if (verdict.status === "moved") {
      moved = true;
      log(`${m.member}: ${verdict.by} overrode an earlier plan or other rules (${verdict.was ?? "no digest"}); this plan and its rules give ${verdict.digest}, so that override counts for nothing`);
    }
    if (!verdict.standing) {
      const { version: _v, kind: _k, ...fact } = og.overridePending({
        subject: m.member,
        planDigest: m.planDigest,
        rules: m.denied.rules,
        timestamp: now,
        expiresAt: new Date(new Date(now).getTime() + 48 * 3600 * 1000).toISOString(),
        description: m.denied.reason ?? `wave ${k} (${wave.name}) of ${spec.name}: ${m.member}: plan ${m.planDigest} denied by ${og.sortedRules(m.denied.rules).join(", ")}`,
      });
      try {
        await port.appendPending({ ...fact, members: [{ member: m.member, planDigest: m.planDigest }], wave: { number: k, name: wave.name, op: spec.name } } as typeof fact);
      } catch (err) {
        log(`${m.member}: the denial was not recorded for an override: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log(`${m.member}: ${overriders.length ? `${overriders.join(", ")} may` : "nobody listed may"} override it with: ${og.overrideCommand(m.member, m.denied.rules, sealed)}`);
  }
  if (still.length > 0) {
    decision.status = "refused";
    decision.refused = { reason: moved ? "override-moved" : "policy", runs: still.sort(), ...(listed && source ? { overridersSource: source } : {}) };
  }
}

/**
 * Throws unless a spend's record reached the remote the next run reads
 * (#3985). Without that, the next run reads the approval or override as
 * unspent. A ledger with no remote is the whole ledger, so a line recorded
 * there is spent.
 */
function requireSpendPushed(result: { pushed: boolean; pushWarning?: string }): void {
  if (result.pushed || isLifecycleLocalNote(result.pushWarning)) return;
  throw new Error(`the record did not reach the remote the next run reads: ${result.pushWarning ?? "the push did not land"}`);
}

/**
 * Record each override the wave is about to apply under (#3821), in
 * `_gates/policy-override/applied.jsonl`, which spends it: written before
 * anything applies, once. False when the lines could not be written or did
 * not reach the remote (#3985): the wave then fails and applies nothing.
 */
async function spendOverrides(ctx: WaveContext, decision: OpWaveDecision): Promise<boolean> {
  const used = decision.members.filter((m) => m.override);
  if (used.length === 0 || decision.overridesSpentAt) return true;
  const { k, wave, cwd, log, options } = ctx;
  const og = await import("../override-gate");
  const port = options.gates ?? gitGateLedgerPort({ cwd });
  const now = options.now ?? new Date().toISOString();
  try {
    if (!port.appendApplied) throw new Error("this gate ledger cannot record an applied override");
    for (const m of used) {
      const record = og.appliedOverride({ subject: m.member, digest: m.override!.digest, at: m.override!.at, by: m.override!.by }, { timestamp: now });
      requireSpendPushed(await port.appendApplied(record as unknown as AppliedGateRecord));
    }
  } catch (err) {
    failed(ctx, `wave ${k} (${wave.name}) could not record the overrides it applies under, so nothing applied: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  decision.overridesSpentAt = now;
  log(`wave ${k} (${wave.name}) applies ${used.map((m) => m.member).join(", ")} under their overrides, which are now spent`);
  return true;
}

/** The exit code of a refused wave: 8 when its decision point refused it (#3836), 7 when the product's policy did (#3821). */
function refusedExit(decision: OpWaveDecision): number {
  return decision.refused?.reason === "point" ? 8 : 7;
}

function failed(ctx: WaveContext, line: string): RunOpWaveResult {
  ctx.log(line);
  ctx.result.exitCode = 1;
  return ctx.result;
}

/**
 * Decide whether an approval of the decision's digest stands, whatever its
 * policy: sets its status to `approved` or `waiting`. Called when the policy
 * asks for one, or when a hook holds the wave (#3762).
 */
async function settleGate(options: RunOpWaveOptions, ctx: WaveContext, decision: OpWaveDecision): Promise<void> {
  if (decision.point) return settlePointGate(options, ctx, decision, decision.point);
  const { spec, k, wave, cwd } = ctx;
  const { gate, digest, approval, base, policy, members } = decision;
  const { ledger, port } = await gatePort(options, cwd, gate, approval, base);
  const now = options.now ?? new Date().toISOString();
  // #3784: under the spend rule at base, an approval a wave already applied under counts for nothing.
  const spent: AppliedGateRecord[] | undefined = decision.spend === "base" ? ((await ledger.readApplied?.(spec.name)) ?? []).filter((a) => a.gate === gate) : undefined;
  const held = decision.heldBy?.length ? `, held by ${decision.heldBy.join(", ")}` : "";
  const check = await decideWaveGate(port, {
    op: spec.name,
    gate,
    digest,
    description: (typeof decision.pending?.description === "string" ? decision.pending.description : undefined) ?? `wave ${k} (${wave.name}): ${members.length} run${members.length === 1 ? "" : "s"}, gate ${policy}, approval ${approval}${held}`,
    now,
    ...(spent ? { spent } : {}),
    // #3861: the approval mode the wave asked under, for readers deciding which approvals count.
    fields: { ...decision.pending, approvalMode: approval },
    ...(decision.neverOverMcp ? { neverOverMcp: true } : {}),
  });
  if (check.satisfied) {
    decision.status = "approved";
    decision.via = "ledger";
    decision.approvedBy = check.resolution.resolvedBy;
    decision.approvedAt = check.resolution.timestamp;
    return;
  }
  logRefused(ctx.log, `wave ${k} (${wave.name})`, check);
  // #3821: what the wait is, for the after-gate hooks and the record.
  decision.pendingFact = check.pending;
  decision.recorded = check.recorded;
  decision.waitingSince = check.pending.timestamp;
  if (check.mismatch) decision.mismatch = check.mismatch;
  const used = spent?.filter((a) => isApprovalSpent([a], { gate, planDigest: digest, timestamp: a.approvedAt })).pop();
  if (used) {
    ctx.log(`wave ${k} (${wave.name}): the approval of ${digest} by ${used.approvedBy} at ${used.approvedAt} is spent: a wave applied under it at ${used.timestamp}. Applying it again needs a new approval`);
  }
  if (approval === "pr-review") {
    const byReview = await approveByReview(options, { op: spec.name, gate, k, digest, cwd, now, port: ledger, ...(spent ? { spent } : {}) });
    decision.review = byReview.review;
    if (byReview.approved) {
      for (const key of ["pendingFact", "recorded", "waitingSince", "mismatch"] as const) delete decision[key];
      decision.status = "approved";
      decision.via = "pr-review";
      decision.approvedBy = byReview.review.approvers!.join(", ");
      decision.approvedAt = now;
      return;
    }
    decision.status = "waiting";
    decision.approve = approveCommand(spec.name, gate, undefined, digest);
    return;
  }
  decision.status = "waiting";
  decision.approve = approveCommand(spec.name, gate, undefined, digest, approval === "sealed");
}

/**
 * Decide a gate that asks a decision point (#3836), as an Op gate with a
 * `point` is decided (#3170): ask it with `gate.planDigest` set to the set
 * digest, then wait on an open question, pass on an answer the gate passes
 * on, or refuse the wave on any other. The wave's `approval` mode and spent
 * approvals do not apply: the point's deciders and quorum decide, and a
 * `chant approve` of the digest does not pass it.
 */
async function settlePointGate(options: RunOpWaveOptions, ctx: WaveContext, decision: OpWaveDecision, point: NonNullable<OpWaveDecision["point"]>): Promise<void> {
  const { spec, k, wave, cwd, log } = ctx;
  const { gate, digest, policy, members } = decision;
  if (decision.approval !== "ledger") log(`wave ${k} (${wave.name}): its gate asks decision point ${point.name}, so its approval mode (${decision.approval}) does not apply`);
  const { evaluatePointGate } = await import("../point-decision");
  const asker = options.points ?? (await import("./gate-point-run")).workspaceGatePointAsker(cwd);
  const held = decision.heldBy?.length ? `, held by ${decision.heldBy.join(", ")}` : "";
  const check = await evaluatePointGate(options.gates ?? gitGateLedgerPort({ cwd }), asker, {
    op: spec.name,
    gate,
    point: { name: point.name, ...(point.pass ? { pass: point.pass } : {}), ...(point.store ? { store: point.store } : {}) },
    ...(point.inputs ? { inputs: point.inputs } : {}),
    description: (typeof decision.pending?.description === "string" ? decision.pending.description : undefined) ?? `wave ${k} (${wave.name}): ${members.length} run${members.length === 1 ? "" : "s"}, gate ${policy}, decision point ${point.name}${held}`,
    ...(point.timeout ? { timeout: point.timeout } : {}),
    planDigest: digest,
    ...(options.now ? { now: options.now } : {}),
    // #3863: the plans file's pending fields and the spec's neverOverMcp, as settleGate passes them.
    fields: { ...decision.pending, approvalMode: decision.approval },
    ...(decision.neverOverMcp ? { neverOverMcp: true } : {}),
  });
  if (check.satisfied) {
    decision.status = "approved";
    decision.via = "point";
    decision.approvedBy = check.resolution.resolvedBy;
    decision.approvedAt = check.resolution.timestamp;
    point.answer = check.answer;
    return;
  }
  if ("refused" in check) {
    decision.status = "refused";
    decision.refused = { reason: "point", runs: members.map((m) => m.member), message: check.refused };
    point.answer = check.answer;
    return;
  }
  decision.status = "waiting";
  decision.pendingFact = check.pending;
  decision.recorded = check.recorded;
  decision.waitingSince = check.pending.timestamp;
  point.question = check.waiting;
  decision.approve = `chant workspace points answer ${check.waiting.id} --answer <answer> --by <your name>`;
  log(`wave ${k} (${wave.name}) asks decision point ${point.name} about ${digest}: question ${check.waiting.id} is ${check.waiting.state}`);
}

/** Write the decision record, with every hook's outcome so far (#3804). */
function writeRecord(recordPath: string, decision: OpWaveDecision, result: RunOpWaveResult): void {
  if (result.hooks.length > 0) decision.outcomes = [...result.hooks];
  writeWaveRecordFile(recordPath, decision);
}

/**
 * A hold waits only when nobody approved the decided digest: settle the gate
 * once for `holds`. False when the wave now waits (exit 3).
 */
async function settleHolds(
  options: RunOpWaveOptions,
  ctx: WaveContext,
  decision: OpWaveDecision,
  holds: readonly string[],
  recordPath?: string,
): Promise<boolean> {
  const { k, wave, log, result } = ctx;
  if (holds.length === 0 || decision.status === "approved") return true;
  decision.heldBy = [...(decision.heldBy ?? []), ...holds];
  await settleGate(options, ctx, decision);
  if (recordPath) writeRecord(recordPath, decision, result);
  if (decision.status === "refused") {
    // #3836: the gate's decision point refused the held wave.
    if (recordPath) await runGateHooks(ctx, decision, recordPath);
    log(`wave ${k} (${wave.name}) is held by ${holds.join(", ")}; nothing applied: ${decision.refused?.message ?? "refused"}`);
    result.exitCode = refusedExit(decision);
    return false;
  }
  if (decision.status === "waiting") {
    // #3821: the gate decided again, and the wave now waits: the after-gate hooks hear so.
    if (recordPath) await runGateHooks(ctx, decision, recordPath);
    log(`wave ${k} (${wave.name}) is held by ${holds.join(", ")}, and nobody approved ${decision.digest}; nothing applied. Approve: ${decision.approve}`);
    result.exitCode = 3;
    return false;
  }
  log(`wave ${k} (${wave.name}) is held by ${holds.join(", ")}, and ${decision.approvedBy} approved its digest`);
  return true;
}

/** How one apply call came out. `applied` with a `problem`: the runs applied, and the wave still fails. `applied-nothing`: the apply said why (#3821). */
type ApplyCall = { outcome: "applied"; problem?: string } | { outcome: "failed" | "waiting" } | { outcome: "applied-nothing"; said: OpWaveApplyOutcome };

/** Read what an apply wrote to `CHANT_APPLY_OUTCOME` (#3821), or undefined when it wrote nothing. A file that says something else is logged and ignored. */
function readApplyOutcome(path: string, label: string, log: (line: string) => void): OpWaveApplyOutcome | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const o = JSON.parse(readFileSync(path, "utf-8")) as Partial<OpWaveApplyOutcome>;
    if (!OP_WAVE_APPLY_OUTCOMES.includes(o.outcome as "held")) throw new Error(`outcome ${JSON.stringify(o.outcome)} is none of ${OP_WAVE_APPLY_OUTCOMES.join(", ")}`);
    if (o.reason !== undefined && typeof o.reason !== "string") throw new Error("its reason is not text");
    const holder = o.holder && typeof o.holder === "object" && typeof o.holder.run === "string" ? { run: o.holder.run, ...(typeof o.holder.url === "string" ? { url: o.holder.url } : {}) } : undefined;
    return { outcome: o.outcome as OpWaveApplyOutcome["outcome"], ...(o.reason ? { reason: o.reason } : {}), ...(holder ? { holder } : {}) };
  } catch (err) {
    log(`${label}: the apply wrote an outcome that cannot be read (${err instanceof Error ? err.message : String(err)}), so its exit code decides`);
    return undefined;
  }
}

/**
 * Call one apply command (#3804) with `CHANT_HOOKS` and `CHANT_HOOKS_RESULT`.
 * When the apply runs the apply-stage hooks, read their outcomes back: a hold
 * with no approval standing settles the gate and, once approved, calls the
 * apply again; an `after-apply` failure means the runs applied and the wave
 * fails; an apply that exited 0 without running its hooks fails the wave.
 */
async function callApply(
  options: RunOpWaveOptions,
  ctx: WaveContext,
  decision: OpWaveDecision,
  runs: readonly OpWaveRun[],
  planned: ReadonlyMap<string, OpWaveMember>,
  argv: string[],
  call: { label: string; key: string; runsPath: string },
  recordPath?: string,
): Promise<ApplyCall> {
  const { spec, k, wave, cwd, exec, log, result } = ctx;
  const byApply = decision.applyHooksRunBy === "apply";
  const dir = `.chant/op-waves/${spec.name}/wave-${k}`;
  const filePath = `${dir}/${call.key}.json`;
  const resultPath = `${dir}/${call.key}-result.json`;
  const outcomePath = `${dir}/${call.key}-outcome.json`;
  const handed: Partial<Record<OpWaveHookMoment, OpWaveHook[]>> = {};
  if (byApply) {
    for (const m of ["before-apply", "after-apply"] as const) if (decision.hooks?.[m]?.length) handed[m] = decision.hooks[m];
  }
  for (let pass = 0; pass < 2; pass++) {
    const approved = decision.status === "approved";
    const file: OpWaveHooksFile = {
      version: 1,
      opWaves: spec.name,
      op: spec.op,
      wave: wave.name,
      number: k,
      base: decision.base,
      digest: decision.digest,
      approved,
      ...(decision.heldBy?.length ? { heldBy: decision.heldBy } : {}),
      runBy: byApply ? "apply" : "chant",
      runs: hookRuns(spec, k, runs, planned),
      runsFile: call.runsPath,
      hooks: handed,
      outcomes: [...result.hooks],
      ...(byApply ? { result: resultPath } : {}),
    };
    mkdirSync(join(cwd, dir), { recursive: true });
    writeFileSync(join(cwd, filePath), JSON.stringify(file, null, 2) + "\n");
    rmSync(join(cwd, resultPath), { force: true });
    rmSync(join(cwd, outcomePath), { force: true });
    let code: number;
    try {
      code = exec(argv, cwd, { CHANT_HOOKS: filePath, CHANT_APPLY_OUTCOME: outcomePath, ...(byApply ? { CHANT_HOOKS_RESULT: resultPath } : {}) });
    } catch (err) {
      log(`${call.label}: the apply did not run: ${err instanceof Error ? err.message : String(err)}`);
      code = 127;
    }
    // #3821: an apply that applied nothing, and says why, is not a failure.
    const said = readApplyOutcome(join(cwd, outcomePath), call.label, log);
    if (said) {
      if (byApply) {
        try {
          const back = JSON.parse(readFileSync(join(cwd, resultPath), "utf-8")) as OpWaveHooksResult;
          if (Array.isArray(back?.outcomes)) result.hooks.push(...back.outcomes);
        } catch {
          // No hooks ran.
        }
      }
      log(`${call.label}: the apply applied nothing: ${said.outcome}${said.reason ? ` (${said.reason})` : ""}${said.holder ? `, held by run ${said.holder.run}` : ""}`);
      return { outcome: "applied-nothing", said };
    }
    if (!byApply) return { outcome: code === 0 ? "applied" : "failed" };
    let back: OpWaveHooksResult | null = null;
    try {
      back = JSON.parse(readFileSync(join(cwd, resultPath), "utf-8")) as OpWaveHooksResult;
    } catch {
      back = null;
    }
    const outcomes = Array.isArray(back?.outcomes) ? back!.outcomes : [];
    const moments = Array.isArray(back?.moments) ? back!.moments : [];
    result.hooks.push(...outcomes);
    const holds = outcomes.filter((o) => o.moment === "before-apply" && o.outcome === "held").map((o) => `${o.moment} hook ${o.name}${o.target ? ` (${o.target})` : ""}`);
    if (holds.length > 0 && !approved) {
      if (code === 0) {
        log(`${call.label}: the apply exited 0 although ${holds.join(", ")} held it and no approval stood; an apply applies nothing on a hold`);
        return { outcome: "failed" };
      }
      if (pass > 0 || !(await settleHolds(options, ctx, decision, holds, recordPath))) return { outcome: "waiting" };
      if (!(await spendApproval(options, ctx, decision))) return { outcome: "failed" };
      if (recordPath && decision.spentAt) writeRecord(recordPath, decision, result);
      continue;
    }
    const afterFailed = outcomes.find((o) => o.moment === "after-apply" && o.outcome === "failed");
    if (afterFailed) return { outcome: "applied", problem: `${call.label} applied, and then the after-apply hook ${afterFailed.name} failed` };
    if (code !== 0) return { outcome: "failed" };
    const skipped = (["before-apply", "after-apply"] as const).filter((m) => handed[m] && !moments.includes(m));
    if (skipped.length > 0) {
      return { outcome: "applied", problem: `${call.label}: the apply exited 0 without running its ${skipped.join(" and ")} hooks (runOpWaveApplyHooks with CHANT_HOOKS), which the spec at base hands it` };
    }
    return { outcome: "applied" };
  }
  return { outcome: "failed" };
}

/**
 * Apply `runs` of a decided wave: the before-apply hooks, the apply (one call
 * per run, or one `applyWave` call for the set), then the after-apply hooks.
 * A hook that holds the wave here, or held a share job's plan, makes it wait
 * for an approval of the decided digest unless one already stands. Under
 * `hooks.apply.runBy: "apply"` the apply call runs the apply-stage hooks
 * itself, under its lock (#3804).
 */
async function applyStage(
  options: RunOpWaveOptions,
  ctx: WaveContext,
  decision: OpWaveDecision,
  runs: readonly OpWaveRun[],
  planned: ReadonlyMap<string, OpWaveMember>,
  earlierHolds: readonly string[],
  recordPath?: string,
): Promise<void> {
  const { spec, k, wave, log, result } = ctx;
  if (runs.length === 0) return;
  const byApply = decision.applyHooksRunBy === "apply";
  const holds = [...earlierHolds];
  if (!byApply) {
    const before = await runHooks(ctx, "before-apply", decision.hooks?.["before-apply"], runs, planned, decision.digest);
    if (before.failed) {
      failed(ctx, `a hook before the apply failed, so nothing in wave ${k} was applied`);
      return;
    }
    if (before.waitingOn) {
      markHeldOn(decision, before.waitingOn);
      if (recordPath) {
        writeRecord(recordPath, decision, result);
        await runGateHooks(ctx, decision, recordPath);
      }
      result.decision = decision;
      result.exitCode = 3;
      return;
    }
    holds.push(...before.holds);
  }
  if (!(await settleHolds(options, ctx, decision, holds, recordPath))) return;
  if (!(await spendApproval(options, ctx, decision))) return;
  if (!(await spendOverrides(ctx, decision))) return;
  if (recordPath && (decision.spentAt || decision.overridesSpentAt)) writeRecord(recordPath, decision, result);
  const problems: string[] = [];
  let waiting = false;
  let nothing: OpWaveApplyOutcome | undefined;
  if (spec.applyWave) {
    const runsPath = writeRunsFile(ctx, runs, planned, decision.digest);
    const argv = opWaveArgv(spec.applyWave, { op: spec.op, wave: wave.name, runs: runsPath, plans: opWavePlansPath(spec, k) });
    const got = await callApply(options, ctx, decision, runs, planned, argv, { label: `wave ${k} (${wave.name})`, key: "hooks", runsPath }, recordPath);
    if (got.outcome === "applied-nothing") nothing = got.said;
    else if (got.outcome === "applied") {
      result.applied.push(...runs.map((r) => r.target));
      if (got.problem) problems.push(got.problem);
    } else if (got.outcome === "waiting") waiting = true;
    else {
      log(`wave ${k} (${wave.name}): apply failed, so none of ${runs.map((r) => r.target).join(", ")} counts as applied`);
      result.failed.push(...runs.map((r) => r.target));
    }
  } else {
    for (const run of runs) {
      const key = run.target.replace(/[^A-Za-z0-9._-]/g, "_");
      // Under runBy "apply" each run's apply runs its own apply-stage hooks, over a runs file of that run alone.
      const runsPath = byApply ? writeRunsFile(ctx, [run], planned, decision.digest, `.chant/op-waves/${spec.name}/wave-${k}/${key}.runs.json`) : opWaveRunsPath(spec, k);
      const argv = opWaveArgv(spec.apply ?? OP_WAVE_DEFAULT_APPLY, { op: run.op ?? spec.op, target: run.target, wave: wave.name, plan: opWavePlanPath(spec, k, run.target) });
      const got = await callApply(options, ctx, decision, [run], planned, argv, { label: run.target, key: `${key}.hooks`, runsPath }, recordPath);
      if (got.outcome === "applied-nothing") {
        nothing = got.said;
        break;
      }
      if (got.outcome === "waiting") {
        waiting = true;
        break;
      }
      if (got.outcome === "applied") {
        result.applied.push(run.target);
        if (got.problem) problems.push(got.problem);
      } else {
        log(`${run.target}: apply failed`);
        result.failed.push(run.target);
      }
    }
  }
  if (recordPath && byApply) writeRecord(recordPath, decision, result);
  if (nothing) {
    // #3821: no run counts as failed; the wave stops here, or plans again.
    if (nothing.outcome === "replan") {
      result.replan = { ...(nothing.reason ? { reason: nothing.reason } : {}) };
      return;
    }
    result.outcome = nothing;
    result.exitCode = nothing.outcome === "stood-down" ? 6 : 5;
    if (recordPath) writeRecord(recordPath, decision, result);
    return;
  }
  if (waiting) {
    result.exitCode = decision.status === "refused" ? refusedExit(decision) : 3;
    return;
  }
  if (result.failed.length > 0) {
    result.exitCode = 1;
    return;
  }
  if (problems.length > 0) {
    for (const p of problems) log(p);
    result.exitCode = 1;
    return;
  }
  if (!byApply) {
    const after = await runHooks(ctx, "after-apply", decision.hooks?.["after-apply"], runs, planned, decision.digest);
    if (after.failed) failed(ctx, `wave ${k} (${wave.name}) applied, and then a hook after the apply failed`);
  }
  if (recordPath && result.hooks.length > 0) writeRecord(recordPath, decision, result);
}

/**
 * Record that the wave applies under its approval (#3784), which spends it:
 * one line in `_gates/<name>/applied.jsonl`, before anything applies, as
 * terragucci's wave gate writes it. Only an approved wave under the spend
 * rule records, and only once. False when the line could not be written, or
 * was written but did not reach the remote the next run reads (#3985): the
 * wave then fails and applies nothing, since an apply the record misses
 * would leave its approval standing. A ledger with no remote is the whole
 * ledger, so a line recorded there is spent.
 */
async function spendApproval(options: RunOpWaveOptions, ctx: WaveContext, decision: OpWaveDecision): Promise<boolean> {
  if (!decision.spend || decision.status !== "approved" || decision.spentAt || !decision.approvedAt) return true;
  const { spec, k, wave, cwd, log } = ctx;
  const port = options.gates ?? gitGateLedgerPort({ cwd });
  const now = options.now ?? new Date().toISOString();
  const record: AppliedGateRecord = {
    version: 1,
    kind: "applied",
    op: spec.name,
    gate: decision.gate,
    planDigest: decision.digest,
    approvedAt: decision.approvedAt,
    approvedBy: decision.approvedBy ?? "",
    timestamp: now,
    wave: { number: k, name: wave.name },
    ...(decision.via === "pr-review" && decision.review ? { review: { ...(decision.review.pr !== undefined ? { pr: decision.review.pr } : {}), ...(decision.review.head ? { head: decision.review.head } : {}) } } : {}),
  };
  try {
    if (!port.appendApplied) throw new Error("this gate ledger cannot record an applied approval");
    const pushed = await port.appendApplied(record);
    requireSpendPushed(pushed);
    if (!pushed.pushed && pushed.pushWarning) log(`wave ${k} (${wave.name}): ${pushed.pushWarning}`);
  } catch (err) {
    failed(ctx, `wave ${k} (${wave.name}) could not record that it applies under the approval by ${record.approvedBy}, so nothing applied: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  decision.spentAt = now;
  log(`wave ${k} (${wave.name}) applies under the approval by ${record.approvedBy} at ${record.approvedAt}, which is now spent`);
  return true;
}

/** What {@link approveByReview} found. */
type ReviewOutcome = ReviewApproval;

/**
 * Under `pr-review` (#3684): the merged pull request's review approves the
 * wave when a writer other than the author approved its head, and the head
 * planned this wave's digest. The approval is then written to the ledger as a
 * resolution that names the review, so the record says how the wave passed.
 */
async function approveByReview(
  options: RunOpWaveOptions,
  at: { op: string; gate: string; k: number; digest: string; cwd: string; now: string; port: GateLedgerPort; spent?: readonly AppliedGateRecord[] },
): Promise<ReviewOutcome> {
  const review = await import("./gate-review");
  const head = options.head ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: at.cwd, encoding: "utf-8" }).trim();
  let merged: MergedReview | null;
  try {
    merged = await (options.reviews ?? review.reviewSourceFromEnv()).mergedReview(head);
  } catch (err) {
    return { approved: false, review: { reason: `the forge's review could not be read: ${err instanceof Error ? err.message : String(err)}` } };
  }
  if (!merged) return { approved: false, review: { reason: `no merged pull request produced ${head.slice(0, 12)}` } };
  // The head's plans are read only when a writer approved it.
  const plans = merged.approvers.length === 0 ? null : await (options.headPlans ?? ((name, h) => readHeadPlans(name, h, at.cwd)))(options.spec.name, merged.head);
  const { reviewApproval } = await import("../gate-decision");
  const outcome = reviewApproval(merged, plans?.waves.find((w) => w.wave === at.k)?.digest, at.digest);
  if (!outcome.approved) return outcome;
  // #3784: a review a wave already applied this digest under is spent, so it is not recorded again.
  if (at.spent && isApprovalSpent(at.spent, { gate: at.gate, planDigest: at.digest, review: { head: merged.head } })) {
    return {
      approved: false,
      review: { ...outcome.review, reason: `a wave already applied ${at.digest} under the review of #${merged.pr} at ${merged.head.slice(0, 12)}, so the review is spent` },
    };
  }
  const note = `approved by the review of #${merged.pr} at ${merged.head.slice(0, 12)}: ${merged.approvers.join(", ")}`;
  await at.port.appendResolution?.({
    op: at.op,
    gate: at.gate,
    resolvedBy: merged.approvers[0]!,
    timestamp: at.now,
    planDigest: at.digest,
    approver: { kind: "human" },
    // #4020: the commit the wave applies, and the CI run applying it.
    gitSha: head,
    ...(ciRunIdFromEnv() ? { runId: ciRunIdFromEnv()! } : {}),
    note,
    ...(merged.url ? { url: merged.url } : {}),
    review: { pr: merged.pr, head: merged.head, approvers: merged.approvers },
  });
  return outcome;
}

async function readHeadPlans(name: string, head: string, cwd: string): Promise<HeadPlans | null> {
  const { gitLedgerReadPort, requireLifecycleLedger } = await import("../lifecycle/git");
  const { readHeadPlans: read } = await import("../lifecycle/wave-plans");
  await requireLifecycleLedger({ cwd });
  return read(gitLedgerReadPort({ cwd }), name, head);
}

export interface RecordHeadPlansOptions {
  spec: OpWavesSpec;
  cwd?: string;
  exec?: OpWaveExec;
  /** The commit the plans are for. Default: the pull request's head from the CI job's environment, else `git rev-parse HEAD`. */
  head?: string;
  now?: string;
  /** Write the record. Default: append to `chant/lifecycle` and push. */
  write?: (plans: HeadPlans) => Promise<void>;
}

/**
 * `chant run wave --spec <file> --record-plans` (#3684): plan every wave at a
 * pull request's head and record each wave's digest on `chant/lifecycle`,
 * `_wave-plans/<name>/<head>.json`. A `pr-review` wave reads it after the
 * merge: the review of that head approves the digests it planned, and only
 * those.
 */
export async function recordOpWaveHeadPlans(options: RecordHeadPlansOptions): Promise<HeadPlans> {
  const { spec } = options;
  assertOpWavesSpec(spec);
  const cwd = options.cwd ?? process.cwd();
  const exec = options.exec ?? spawnExec;
  const review = await import("./gate-review");
  const head = options.head ?? review.pullRequestHeadFromEnv() ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim();
  const plans: HeadPlans = {
    version: 1,
    name: spec.name,
    head,
    timestamp: options.now ?? new Date().toISOString(),
    waves: [],
  };
  // A `rest` wave (#3821) goes on through the waves the plan command found.
  const last = spec.waves[spec.waves.length - 1]!;
  for (let k = 1; ; k++) {
    const wave = spec.waves[k - 1] ?? last;
    const { members, extras, waves: found } = planRuns({ spec, k, wave, cwd, exec }, wave.runs, wave.discover === true);
    plans.waves.push({ wave: k, name: wave.name, digest: opWaveSetDigest(spec, members, extras) });
    if (k >= spec.waves.length && !(last.rest && found !== undefined && k < found)) break;
  }
  await (options.write ?? ((p) => writeHeadPlans(p, cwd)))(plans);
  return plans;
}

async function writeHeadPlans(plans: HeadPlans, cwd: string): Promise<void> {
  const { pushLifecycle, requireLifecycleLedger, writeBlobToPath } = await import("../lifecycle/git");
  const { headPlansPath } = await import("./gate-review");
  await requireLifecycleLedger({ cwd });
  const { dir, file } = headPlansPath(plans.name, plans.head);
  await writeBlobToPath(dir, file, JSON.stringify(plans, null, 2) + "\n", `Op waves plans of ${plans.name} at ${plans.head.slice(0, 12)}`, { cwd });
  if (!(await pushLifecycle({ cwd }))) throw new Error("the plans were recorded locally only: chant/lifecycle has no remote to push to");
}
