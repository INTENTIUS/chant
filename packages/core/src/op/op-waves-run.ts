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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import { CHANT_EXIT } from "../exit-codes";
import type { ResolvedGatePolicySource } from "../policy-source";
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
import {
  blockedMembers,
  blockedWords,
  earlierWaveOutcomes,
  passesThrough,
  readWaveOutcomeFile,
  waveOutcomeFileName,
  writeWaveOutcomeFile,
  type WaveMemberOutcome,
} from "../wave-blocked";
import { approveCommand, evaluateGate, gitGateLedgerPort, type GateCheck, type GateDigestMismatch, type GateLedgerPort } from "./gate";
import type { GateAnswerRef, PendingGateInput, PendingGateRecord } from "../lifecycle/gate-ledger";
import type { GatePointAsker } from "../point-decision";
import type { WaitingPoint } from "./steward-points";
import { isApprovalSpent, type AppliedGateRecord, type FinishedGateRecord } from "../lifecycle/gate-applied";
import { samePlanDigest } from "../lifecycle/plan-digest";
import { isLifecycleLocalNote } from "../lifecycle/local-note";
import type { HeadPlans, MergedReview, ReviewSource } from "./gate-review";
import type { TrustPolicy } from "../workspace/trust/policy";
import type { GateSigners } from "../lifecycle/gate-seal";
import { ciRunIdFromEnv } from "./gate-run-locator";
import { appendRunRecord, DEFAULT_RUN_ENV } from "../lifecycle/run-ledger";
import { pushLifecycleReport } from "../lifecycle/git";
import { resolveCiJob } from "../lifecycle/release-ledger";
import type { OpRunPolicyRow, OpRunRecordInput, OpRunStepRecord, OpRunWave, OpRunWavePlan, OpRunWaveTarget } from "./runtime";
import { foldPolicyRows, opWaveAfterPlanProblems, runOpWaveAfterPlanHooks, type OpWaveAfterPlanHook, type OpWaveAfterPlanRun } from "./op-waves-after-plan";
import { activeOtlp, RunEventTrace, type CapabilityTraceFacts, type OtlpExporter } from "../otlp";
import { joinRunEventSinks, resolveRunEventRun, type RunEventSink } from "../run-event-stream";
import { OpWaveRunEvents } from "./op-waves-events";
import type { ChangeSetDocument, ChangeSetPart } from "../change-set";
import type { CapabilityRegistry } from "../components/capability";
import type { RunEventResource } from "../run-event";
import { opWaveReleaseNames, type OpWaveReleaseOutcome, type OpWaveReleasePort, type OpWaveReleaseRequest } from "./op-waves-release";
import { gitOpWaveReleasePort } from "./op-waves-release-port";
import type { LockGrain } from "../lifecycle/lock-rows";
import type { LockLiveness } from "../lifecycle/resource-lock";
import type { GatePolicyExec } from "../gate-policy";
import { gitOpWaveNewerCommit, opWaveStandDownReason, tipAppliesTargets, type OpWaveNewerCommitPort } from "./op-waves-stand-down";
import { mapLimited } from "../parallelism";
import {
  applyOpWaveStep,
  opWaveCosts,
  opWaveCostVerdict,
  opWaveHoldsAt,
  opWaveHoldsProblems,
  opWavePolicyVerdicts,
  opWaveRegistry,
  opWaveStepChangeSet,
  planJsonOf,
  planOpWaveStep,
  type OpWaveHolds,
  type OpWaveStepPlan,
} from "./op-waves-capability";
import { NEXT_RELEASE } from "../release-floors";
import {
  changeInvolvement, quorumProblems, quorumRuleLine, quorumRulesFor, quorumWaiting, recordedReviewApprovals, ruleNeedsProof, samePrincipal, trustQuorumJudge,
  type GateQuorumJudge, type GateQuorumRule, type GateQuorumRuleProgress, type QuorumJudgement,
} from "./gate-quorum";
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
  opWaveHookRuns,
  opWaveOutcomeDir,
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
  type OpWavesInvolved,
  type OpWavesSpec,
  OP_LEDGER_NAME,
  opWavesInvolvedProblems,
} from "./op-waves";
import {
  OP_WAVE_PENDING_RESERVED,
  opWaveArgv,
  pendingFields,
  holdFinishedPath,
  readHoldFinished,
  readHoldRequest,
  runHookList,
  runHookListAsync,
  runStageHooks,
  runStageHooksAsync,
  spawnExec,
  spawnExecAsync,
  type HookPlace,
  type OpWaveAsyncExec,
  type OpWaveExec,
  type OpWaveHoldFinished,
  type OpWaveHoldRequest,
  type OpWaveHookOutcome,
  type OpWaveHookRun,
  type OtherGateHold,
  type RunStageHooksAsyncOptions,
  type RunStageHooksOptions,
  type StageHooksRun,
} from "./stage-hooks";

export { OP_WAVE_PENDING_RESERVED, opWaveArgv, runStageHooks, runStageHooksAsync, spawnExecAsync };
export type { OpWaveAsyncExec, OpWaveExec, OpWaveHoldFinished, OpWaveHoldRequest, OpWaveHookOutcome, OpWaveHookRun, RunStageHooksAsyncOptions, RunStageHooksOptions, StageHooksRun };

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
  /**
   * The product's policy holds this plan for a person (#4294): the ids of
   * the hold rules that matched. The wave waits for an approval of its set
   * digest whatever its gate policy says, as a hook with `onFailure:
   * approve` holds it. `@intentius/chant/gate-policy` gives the rules.
   */
  held?: { rules: string[]; reason?: string };
  /** The run's change-set part (#4545), which a `holds.policy` hold runs the policy over. A `step` writes it itself. */
  changeSet?: ChangeSetPart;
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
  /**
   * The change-set document the product composed for the wave's plans
   * (#4551, `composeChangeSet`). chant stores it under its digest in
   * `_change-sets/` before the wave's pending fact, which cites it as
   * `changeSet`, so the plans an approval was asked for stay readable. A
   * document whose content does not hash to its digest is logged and left
   * out; it never blocks the gate.
   */
  changeSet?: ChangeSetDocument;
}

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
  /** The product's policy holds the plan for a person (#4294). */
  held?: { rules: string[]; reason?: string };
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
  /**
   * How the approval arrived: a resolution on the ledger, the merged pull
   * request's review (#3684), a decision point's answer (#3836), or the pull
   * request's approval covering the wave's plans (#4550).
   */
  via?: "ledger" | "pr-review" | "point" | "pull-request";
  /** Under `pull-request` (#4550): the gate the pull request's approval is recorded at, read at base. */
  pullRequestGate?: string;
  /** Under `pull-request`: the approved change set that covered the wave, or why none did. */
  coveredBy?: { digest?: string; reason?: string };
  /**
   * The decision point the gate asks, as read at base (#3836), and what it
   * said: the open `question` while the wave waits, the `answer` once it is
   * answered (the one that passed, or the one that refused the wave).
   */
  point?: OpWavePoint & { question?: WaitingPoint; answer?: GateAnswerRef };
  /** The review that approved the wave, or why the review did not, under `pr-review`. */
  review?: { pr?: number; head?: string; approvers?: string[]; url?: string; reason?: string };
  /** The approval rules at base the wave's targets take (#4290). Absent when it takes none. */
  quorum?: GateQuorumRule[];
  /** The op whose ledger holds the product's own reviews, read at base (#4333). */
  reviewLedger?: string;
  /** Who else counts as involved in the change, read at base (#4333). */
  involved?: OpWavesInvolved;
  /** Where each of those rules stands (#4290), while the wave waits. */
  quorumProgress?: GateQuorumRuleProgress[];
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
  /** The digest of the change set the plans file gave, stored in `_change-sets/` and cited by the pending fact (#4551). */
  changeSet?: string;
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
  /**
   * `ci.policy.source` as `holds.policy` fetched it (#4613): the shared
   * repository, its ref and the commit the ref named, so the decision names
   * the rules its runs were judged by. Absent when the rules came from the
   * workspace at base, or no policy ran.
   */
  ciPolicySource?: ResolvedGatePolicySource;
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
  /** The approval rules at base (#4290), `approvals.quorum`. */
  quorum?: GateQuorumRule[];
  /** Set when the rules at base cannot be read: the wave fails rather than wait on fewer approvers than they ask. */
  quorumRefused?: string;
  /** `approvals.reviewLedger` at base (#4333): the op whose ledger holds a product's own reviews. */
  reviewLedger?: string;
  /** `approvals.involved` at base (#4333). */
  involved?: OpWavesInvolved;
  /** `holds` at base (#4545): the policy and cost holds the wave runs over its plans. */
  holds?: OpWaveHolds;
  /** Set when `holds` at base cannot be read: none runs, and the wave waits for a person. */
  holdsRefused?: string;
  /** `approvals.pullRequest.gate` at base (#4550): the pull request's gate a `pull-request` wave takes its approval from. */
  pullRequestGate?: string;
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
  const asks = { ...pointAtBase(spec, name, `${specFile} at ${sha.slice(0, 12)}`), ...quorumAtBase(spec, `${specFile} at ${sha.slice(0, 12)}`), ...holdsAtBase(spec, `${specFile} at ${sha.slice(0, 12)}`), ...pullRequestGateAtBase(spec) };
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

/** `approvals.pullRequest.gate` at base (#4550), when it names a gate. */
function pullRequestGateAtBase(spec: OpWavesSpec): Pick<OpWaveBaseRules, "pullRequestGate"> {
  const gate = (spec as { approvals?: { pullRequest?: { gate?: unknown } } }).approvals?.pullRequest?.gate;
  return typeof gate === "string" && OP_LEDGER_NAME.test(gate) ? { pullRequestGate: gate } : {};
}

/** The approval rules at base (#4290), or why they cannot be read. A spec at base with none has none. */
function quorumAtBase(spec: OpWavesSpec, where: string): Pick<OpWaveBaseRules, "quorum" | "quorumRefused" | "reviewLedger" | "involved"> {
  const a = (spec as { approvals?: { quorum?: unknown; reviewLedger?: unknown; involved?: unknown } }).approvals;
  const raw = a?.quorum;
  // #4333: where a product's reviews are, and who counts as involved, read at base with the rules.
  const extra: Pick<OpWaveBaseRules, "reviewLedger" | "involved"> = {};
  if (a?.reviewLedger !== undefined) {
    if (typeof a.reviewLedger !== "string" || !OP_LEDGER_NAME.test(a.reviewLedger)) return { quorumRefused: `the approval rules in ${where} cannot be read (approvals.reviewLedger must name an op)` };
    extra.reviewLedger = a.reviewLedger;
  }
  if (a?.involved !== undefined) {
    const bad = opWavesInvolvedProblems(a.involved);
    if (bad.length > 0) return { quorumRefused: `the approval rules in ${where} cannot be read (${bad.join("; ")})` };
    extra.involved = structuredClone(a.involved as OpWavesInvolved);
  }
  if (raw === undefined) return {};
  const problems = Array.isArray(raw) ? quorumProblems(raw, "approvals.quorum", { notAuthor: true }) : ["`approvals.quorum` must be a list of rules"];
  if (problems.length > 0) return { quorumRefused: `the approval rules in ${where} cannot be read (${problems.join("; ")})` };
  return (raw as GateQuorumRule[]).length > 0 ? { quorum: raw as GateQuorumRule[], ...extra } : {};
}

/** The holds at base (#4545), or why they cannot be read. */
function holdsAtBase(spec: OpWavesSpec, where: string): Pick<OpWaveBaseRules, "holds" | "holdsRefused"> {
  const raw = (spec as { holds?: unknown }).holds;
  if (raw === undefined) return {};
  const problems = opWaveHoldsProblems(raw);
  if (problems.length > 0) return { holdsRefused: `the holds in ${where} cannot be read (${problems.join("; ")})` };
  return { holds: structuredClone(raw as OpWaveHolds) };
}

/** The point wave `name` asks at base (#3836), or why it cannot be asked. */
function pointAtBase(spec: OpWavesSpec, name: string, where: string): Pick<OpWaveBaseRules, "point" | "pointRefused"> {
  const raw = spec.waves.find((w) => w.name === name)?.point ?? spec.point;
  if (raw === undefined) return {};
  const problems = opWavePointProblems(raw);
  if (problems.length > 0) return { pointRefused: `the decision point at base cannot be asked (${where}: ${problems.join("; ")})` };
  return { point: opWavePointAt(spec, name)! };
}

/** The first chant whose op entry exports {@link opWavePlanPath} (terragucci#1304). */
export const OP_WAVE_PLAN_PATH_FLOOR = NEXT_RELEASE;

/** Where a run's plan file goes: one target's plan, as opposed to {@link opWavePlansPath}, the wave's `plans.json`. */
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
  /**
   * The change set stored under a digest, for a `pull-request` gate (#4550):
   * the one the pull request's approval names. Default: `_change-sets/` on
   * the local `chant/lifecycle`.
   */
  changeSets?: (digest: string) => Promise<ChangeSetDocument | undefined>;
  /** The signers policy at base, for a `sealed` gate. Default: read from the base commit. */
  trust?: (base: string) => TrustPolicy;
  /** The signers at base, for a sealed override of a policy denial (#3821). Default: `gateSignersAt` from `@intentius/chant/gate-decision`. */
  signers?: (base: string) => GateSigners;
  /** How a gate with a `point` asks it (#3836). Default: `workspaceGatePointAsker` over `cwd`. A tool that bundles chant passes `chantGatePointAsker`. */
  points?: GatePointAsker;
  /**
   * Where the jobs' outcome files are (#4322), from `cwd`: the job reads the
   * earlier waves' (a share job, its deciding job's) at any depth under it,
   * and writes its own there. Default {@link opWaveOutcomeDir}.
   */
  outcomeDir?: string;
  /** The commits after base up to the applied head, for `Requested-by:` trailers (#4333). Default: `git log`. */
  commits?: (base: string, head: string) => { sha: string; message: string }[];
  /**
   * Where the job's run record goes (#4551): one record per job, on every
   * way it ends. Default {@link gitOpWaveRunPort} over `cwd` when `gates` is
   * not given; a caller that passes its own `gates` port passes this too, or
   * the job records no run.
   */
  runs?: OpWaveRunPort;
  /**
   * Where the release records of the runs a `step` applied go (#4615), so
   * `chant components rollback` reads them. Default
   * {@link gitOpWaveReleasePort} over `cwd` when `gates` is not given, as
   * `runs` defaults; `false` writes none. See `./op-waves-release.ts`.
   */
  releases?: OpWaveReleasePort | false;
  /**
   * The capabilities a spec's `step` plans and applies through (#4545).
   * Default: the project's at `cwd`, as `chant run --components` builds it.
   * A product that runs chant in process passes its own.
   */
  capabilities?: CapabilityRegistry;
  /** How a hold's policy engine and cost estimator run (#4545). Default: spawned in `cwd`. */
  holdExec?: GatePolicyExec;
  /**
   * How the `planWave` and `applyWave` commands run (#4588), when the caller
   * runs them itself, such as `pr-apply --wave-gate` running the component
   * plan-wave and apply-wave steps in its own process. Default: `exec`.
   */
  waveExec?: OpWaveAsyncExec;
  /**
   * The lock grain a `step`'s runs take (#4552). Default: `ci.lockGrain` of
   * the member holding `cwd`, read from the declaration at the wave's base,
   * else each run's lexicon default.
   */
  lockGrain?: LockGrain;
  /**
   * The gate whose rows file (`_locks/rows/<gate>.json`, #4552) a `step`'s
   * runs lease on the resource grain. Default `pr-apply`, the pull-request
   * loop's, so an apply on merge and an apply before merge read one file; a
   * pipeline whose loop names another gate passes it.
   */
  lockGate?: string;
  /** Whether a run holding rows still runs (#4552). Default: the forge's answer, with the lease's age. */
  lockLiveness?: LockLiveness;
  /** Overrides the spec's `standDown` (#4581). */
  standDown?: boolean;
  /** How the job finds a newer commit on its branch (#4581). Default: fetch the branch from `origin` ({@link gitOpWaveNewerCommit}). */
  newerCommit?: OpWaveNewerCommitPort;
  /**
   * Where the job's run events go (#4555), on the run-event contract: a
   * phase `wave-<k>` per wave and a step per run target, settled as the
   * run record says. `chant run wave --events-json` passes its stream.
   */
  events?: RunEventSink;
  /**
   * The OTLP exporter the job's trace goes through (#4555). Default: the
   * process's ({@link activeOtlp}), which is off unless the environment
   * names an endpoint. `false` sends none.
   */
  otlp?: OtlpExporter | false;
  /**
   * After-plan hooks in the job's own process (#4614): each is called once
   * per planned run, in order, after the wave's holds and before the set
   * digest and the gate, with the run's plan digest, `{plan}` and
   * `{planJson}`. Its policy rows deny or hold the run, and its rows and
   * files go on the run record. See `./op-waves-after-plan.ts`.
   */
  afterPlan?: OpWaveAfterPlanHook | readonly OpWaveAfterPlanHook[];
  /**
   * How the spec's command hooks run (#4614), when they call back into the
   * caller's own process: a product that runs the wave in process and serves
   * its hooks from that process passes an exec that lets the event loop run
   * while a hook does. Default: `exec`, which waits with `spawnSync`.
   */
  hookExec?: OpWaveAsyncExec;
}

/** Where an op wave job's run record goes (#4551). */
export interface OpWaveRunPort {
  append(record: OpRunRecordInput): Promise<{ pushWarning?: string } | void>;
}

/** The run ledger on `chant/lifecycle` (#4551): `appendRunRecord`, then a push. Honours `--no-record` through the git layer. */
export function gitOpWaveRunPort(opts?: { cwd?: string }): OpWaveRunPort {
  return {
    async append(record) {
      await appendRunRecord(record, opts);
      const { pushWarning } = await pushLifecycleReport(opts);
      return pushWarning ? { pushWarning } : {};
    },
  };
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
  /** The newer commit on the branch the apply stood down for (#4581), with `outcome` `stood-down` and exit 6. */
  supersededBy?: { branch: string; commit: string };
  /** The waves a `rest` wave's job ran (#3821), in order, with how each ended. */
  rest?: Array<{ wave: number; exitCode: number; digest?: string }>;
  decision?: OpWaveDecision;
  applied: string[];
  failed: string[];
  /** Runs a share job refused because their plan moved since the decision. */
  moved: string[];
  /**
   * The runs a failure blocked (#4322), each with the run whose failure
   * blocked it: a run of an earlier wave, or one listed before it in this
   * wave. None of them was planned or applied.
   */
  blocked?: Record<string, string>;
  /** The hooks that ran (#3762). */
  hooks: OpWaveHookOutcome[];
  /** Each target the job applied or tried to (#4555): when, how long, and what its capability knew. */
  targets?: Record<string, OpRunWaveTarget>;
  /** Each planned run with policy rows or an after-plan hook's files (#4614), as the run record's `wave.plans`. */
  plans?: Record<string, OpRunWavePlan>;
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
  /** With a `step` (#4545): each run's plan through it, by target, which its apply hands back. */
  steps?: Map<string, OpWaveStepPlan>;
  /** The plans file's change set (#4551), which a `pull-request` gate checks the pull request's approval against (#4550). */
  changeSetDoc?: ChangeSetDocument;
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
  for (const key of ["denied", "held"] as const) {
    const value = file[key] as unknown;
    if (value === undefined) continue;
    const d = value as { rules?: unknown; reason?: unknown } | null;
    if (!d || typeof d !== "object" || !Array.isArray(d.rules) || d.rules.length === 0 || !d.rules.every((r) => typeof r === "string" && r.trim() !== "") || (d.reason !== undefined && typeof d.reason !== "string")) {
      throw new Error(`the plan of ${target} has ${key} ${JSON.stringify(value)}; ${key === "denied" ? "a denial" : "a hold"} is { "rules": ["<rule id>", ...], "reason"?: "<text>" }`);
    }
  }
  return {
    member: target,
    planDigest: file.planDigest,
    op,
    ...(file.destructive === true ? { destructive: true } : {}),
    ...(file.empty === true ? { empty: true } : {}),
    ...(file.denied ? { denied: { rules: file.denied.rules, ...(file.denied.reason ? { reason: file.denied.reason } : {}) } } : {}),
    ...(file.held ? { held: { rules: [...new Set(file.held.rules)].sort(), ...(file.held.reason ? { reason: file.held.reason } : {}) } } : {}),
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
async function planRuns(at: { spec: OpWavesSpec; k: number; wave: OpWave; cwd: string; exec: OpWaveExec; waveExec?: OpWaveAsyncExec }, runs: readonly OpWaveRun[], discover = false): Promise<PlannedRuns> {
  const { spec, k, wave, cwd, exec } = at;
  if (!spec.planWave) {
    const members = runs.map((run) => planRun({ spec, wave: k, cwd, exec }, wave.name, run));
    // #4545: a plan file's `changeSet` part, which a policy hold reads.
    const parts = new Map(runs.flatMap((run) => {
      const part = partOf(readPlanFileField(join(cwd, opWavePlanPath(spec, k, run.target)), "changeSet"));
      return part ? [[run.target, part] as const] : [];
    }));
    return { members, ...(parts.size > 0 ? { parts } : {}) };
  }
  const runsPath = writeRunsFile(at, runs, undefined, undefined, undefined, discover);
  const plans = opWavePlansPath(spec, k);
  rmSync(join(cwd, plans), { force: true });
  const planArgv = opWaveArgv(spec.planWave, { op: spec.op, wave: wave.name, runs: runsPath, plans });
  const code = at.waveExec ? await at.waveExec(planArgv, cwd) : exec(planArgv, cwd);
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
  const changeSetDoc = Array.isArray(parsed) ? undefined : (parsed as { changeSet?: unknown }).changeSet;
  if (changeSetDoc !== undefined && (changeSetDoc === null || typeof changeSetDoc !== "object" || Array.isArray(changeSetDoc))) {
    throw new Error(`the plans file of wave ${k} (${plans}): \`changeSet\` must be a change-set document`);
  }
  const parts = new Map(runs.flatMap((run) => {
    const part = partOf((byTarget.get(run.target) as { changeSet?: unknown } | undefined)?.changeSet);
    return part ? [[run.target, part] as const] : [];
  }));
  const members = runs.map((run) => {
    const m = member(run.target, run.op ?? spec.op, byTarget.get(run.target)!);
    const path = join(cwd, opWavePlanPath(spec, k, run.target));
    writeFileSync(path, JSON.stringify({ planDigest: m.planDigest, ...(m.destructive ? { destructive: true } : {}), ...(m.empty ? { empty: true } : {}), ...(m.denied ? { denied: m.denied } : {}), ...(m.held ? { held: m.held } : {}) }) + "\n");
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
    ...(parts.size > 0 ? { parts } : {}),
    ...(pending ? { pending } : {}),
    ...(overriders ? { overriders: overriders as string[] } : {}),
    ...(overriders && overridersSource ? { overridersSource: overridersSource as string } : {}),
    ...(extras ? { extras } : {}),
    ...(count !== undefined ? { waves: count as number } : {}),
    ...(changeSetDoc !== undefined ? { changeSet: changeSetDoc as ChangeSetDocument } : {}),
  };
}

/**
 * Plan `runs` of wave `k` (#4545): through the spec's `step` when it names
 * one, each run's plan kept on `at.steps` for its apply, else with the
 * commands ({@link planRuns}).
 */
async function planWaveRuns(
  at: { spec: OpWavesSpec; k: number; wave: OpWave; cwd: string; exec: OpWaveExec; options: Pick<RunOpWaveOptions, "capabilities" | "lockGrain" | "base" | "waveExec">; steps?: Map<string, OpWaveStepPlan> },
  runs: readonly OpWaveRun[],
  discover = false,
): Promise<PlannedRuns> {
  const { spec, k, wave, cwd } = at;
  if (!spec.step) return planRuns({ ...at, ...(at.options.waveExec ? { waveExec: at.options.waveExec } : {}) }, runs, discover);
  const registry = await opWaveRegistry(at.options, cwd, at.options.capabilities);
  const base = (at as { gateRule?: { base: string } }).gateRule?.base ?? at.options.base;
  const lockGrain = at.options.lockGrain ?? (await declaredLockGrain(cwd, base));
  // #4613: a step's own policy engine (CrossGuard) reads its packs at the base the wave's rules were read at.
  const policyBase = base && base !== "HEAD" ? base : undefined;
  const plans: OpWaveStepPlan[] = [];
  for (const run of runs) {
    const plan = await planOpWaveStep({ spec, wave, cwd, registry, planPath: opWavePlanPath(spec, k, run.target), lockGrain, ...(policyBase ? { policyBase } : {}) }, run);
    at.steps?.set(run.target, plan);
    plans.push(plan);
  }
  const members = plans.map((p) => ({
    member: p.target,
    planDigest: p.planDigest,
    op: runs.find((r) => r.target === p.target)?.op ?? spec.op,
    ...(p.destructive ? { destructive: true } : {}),
    ...(p.empty ? { empty: true } : {}),
  }));
  const parts = new Map(plans.flatMap((p) => (p.part ? [[p.target, p.part] as const] : [])));
  const changeSet = opWaveStepChangeSet(plans);
  return { members, ...(parts.size > 0 ? { parts } : {}), ...(changeSet ? { changeSet } : {}) };
}

/**
 * `ci.lockGrain` of the member holding `cwd` (#4552), read at `base`, behind
 * a dynamic import so the wave-job runtime bundle leaves the declaration
 * reader out. Null when none is declared or the declaration cannot be read
 * there: each run then takes its lexicon's default.
 */
async function declaredLockGrain(cwd: string, base: string | undefined): Promise<LockGrain | null> {
  try {
    const { ciLockGrainAt } = await import("../workspace/ci-lock-grain");
    return ciLockGrainAt(cwd, base);
  } catch {
    return null;
  }
}

/**
 * Lease the rows of a wave's runs on the resource grain (#4552), before
 * anything of the wave applies, all in one take. A held row makes the wave
 * apply nothing with the `held` outcome, exit 5, naming the run that holds it.
 */
async function leaseWaveRows(
  options: RunOpWaveOptions,
  ctx: WaveContext,
  runs: readonly OpWaveRun[],
): Promise<{ release(): Promise<boolean> } | OpWaveApplyOutcome | { failed: string } | undefined> {
  const rows = runs.flatMap((r) => {
    const lock = ctx.steps?.get(r.target)?.lock;
    return lock?.grain === "resource" ? lock.rows : [];
  });
  if (rows.length === 0) return undefined;
  const { leaseLockRows } = await import("../lifecycle/resource-lock");
  const { PR_APPLY_GATE } = await import("../pr-loop");
  const gate = options.lockGate ?? PR_APPLY_GATE;
  let leased: Awaited<ReturnType<typeof leaseLockRows>>;
  try {
    leased = await leaseLockRows(gate, rows, { cwd: ctx.cwd, ...(options.lockLiveness ? { alive: options.lockLiveness } : {}) });
  } catch (err) {
    return { failed: `wave ${ctx.k} (${ctx.wave.name}): could not hold the rows its runs change in ${gate}, so nothing was applied: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!leased.ok) {
    const first = leased.held[0]!.holder;
    return { outcome: "held", reason: leased.message, holder: { run: first.run, ...(first.url ? { url: first.url } : {}) } };
  }
  for (const h of leased.tookOver) ctx.log(`wave ${ctx.k} (${ctx.wave.name}): took over the rows of run ${h.run}, which is gone`);
  ctx.log(`wave ${ctx.k} (${ctx.wave.name}): holds ${leased.lease.keys.length} row${leased.lease.keys.length === 1 ? "" : "s"} of ${gate} while it applies`);
  return leased.lease;
}

/** A wave's cost hold over its plans (#4545): each changing run priced, the sum against `approveAbove`. */
function costVerdictOf(
  hold: NonNullable<OpWaveHolds["cost"]>,
  spec: OpWavesSpec,
  k: number,
  members: readonly OpWaveMember[],
  steps: ReadonlyMap<string, OpWaveStepPlan> | undefined,
  cwd: string,
  exec?: GatePolicyExec,
) {
  const runs = members.map((m) => ({ target: m.member, plan: opWavePlanPath(spec, k, m.member), artifact: steps?.get(m.member)?.artifact, empty: m.empty === true }));
  return opWaveCostVerdict(hold, opWaveCosts(hold, runs, cwd, exec));
}

/**
 * Run a wave's holds over its plans (#4545): the policy marks each run it
 * denies or holds (the gate then settles them as a product's plan file
 * would), and the cost adds its digest member and, over its amount, a hold.
 * `failed` when the policy cannot run, or a run gave it no change set.
 */
async function runWaveHolds(
  ctx: WaveContext,
  holds: OpWaveHolds | undefined,
  members: OpWaveMember[],
  parts: ReadonlyMap<string, ChangeSetPart> | undefined,
  base: string,
): Promise<{ holds: string[]; extras: WaveMember[]; rows: Map<string, OpRunPolicyRow>; policySource?: ResolvedGatePolicySource } | { failed: string }> {
  const { spec, k, wave, cwd, log, options } = ctx;
  // #4614: each run's ci.policy row, which the after-plan hooks and the run record read.
  const out: { holds: string[]; extras: WaveMember[]; rows: Map<string, OpRunPolicyRow>; policySource?: ResolvedGatePolicySource } = { holds: [], extras: [], rows: new Map<string, OpRunPolicyRow>() };
  if (!holds) return out;
  if (holds.policy) {
    const missing = members.filter((m) => !parts?.has(m.member)).map((m) => m.member);
    if (missing.length > 0) return { failed: `wave ${k} (${wave.name}): holds.policy reads each run's change set, and the plans of ${missing.join(", ")} gave none, so nothing in it was applied` };
    let head = options.head;
    if (!head) {
      try {
        head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch {
        head = "";
      }
    }
    let got: Awaited<ReturnType<typeof opWavePolicyVerdicts>>;
    try {
      got = await opWavePolicyVerdicts({ spec, gate: opWaveGateName(spec, k), env: spec.labels?.Env ?? wave.name, base, head, cwd, ...(options.holdExec ? { exec: options.holdExec } : {}) }, parts!);
    } catch (err) {
      return { failed: `wave ${k} (${wave.name}): ${err instanceof Error ? err.message : String(err)}, so nothing in it was applied` };
    }
    if ("note" in got) log(`wave ${k} (${wave.name}): ${got.note}`);
    else {
      if (got.source) {
        out.policySource = got.source;
        log(`wave ${k} (${wave.name}): ci.policy read from ${got.source.repo}@${got.source.ref} at commit ${got.source.commit}`);
      }
      for (const m of members) {
        const v = got.verdicts.get(m.member);
        if (v && v.result !== "error") {
          const rules = v.result === "held" ? v.holds : v.result === "denied" ? v.rules : [];
          out.rows.set(m.member, { source: "ci.policy", result: v.result, rules, ...(v.reason ? { reason: v.reason } : {}) });
        }
        if (!v || v.result === "passed") continue;
        if (v.result === "error") return { failed: `wave ${k} (${wave.name}): the policy did not run on ${m.member} (${v.reason ?? "no answer"}), so nothing in it was applied` };
        if (v.result === "denied") m.denied = { rules: v.rules, ...(v.reason ? { reason: v.reason } : {}) };
        else m.held = { rules: v.holds, ...(v.reason ? { reason: v.reason } : {}) };
      }
    }
  }
  if (holds.cost) {
    const verdict = costVerdictOf(holds.cost, spec, k, members, ctx.steps, cwd, options.holdExec);
    out.extras.push(verdict.member);
    log(`wave ${k} (${wave.name}): cost ${verdict.monthlyDelta >= 0 ? "+" : ""}${verdict.monthlyDelta.toFixed(2)} ${verdict.currency} a month${verdict.unestimated.length ? `, ${verdict.unestimated.length} run${verdict.unestimated.length === 1 ? "" : "s"} not priced` : ""}`);
    if (verdict.hold) out.holds.push(verdict.hold);
  }
  return out;
}

/** The job's after-plan hooks (#4614), as a list. */
function afterPlanHooks(options: RunOpWaveOptions): readonly OpWaveAfterPlanHook[] {
  const given = options.afterPlan;
  if (given === undefined) return [];
  return Array.isArray(given) ? (given as readonly OpWaveAfterPlanHook[]) : [given as OpWaveAfterPlanHook];
}

/**
 * Run the after-plan hooks in the job's process over a wave's plans (#4614),
 * fold their policy rows into each run's denial and hold, and put each run's
 * rows and files on the result for the run record. With no hook, the rows
 * chant's `holds.policy` gave still go on the result.
 */
async function runAfterPlan(
  ctx: WaveContext,
  members: OpWaveMember[],
  parts: ReadonlyMap<string, ChangeSetPart> | undefined,
  policyRows: ReadonlyMap<string, OpRunPolicyRow>,
): Promise<{ failed?: string; holds: string[] }> {
  const { spec, k, wave, cwd, options, result } = ctx;
  const hooks = afterPlanHooks(options);
  const job: OpWaveAfterPlanRun["job"] = options.decide ? "decide" : options.group !== undefined ? "group" : options.share !== undefined ? "share" : "wave";
  const runs: OpWaveAfterPlanRun[] = members.map((m) => {
    const plan = opWavePlanPath(spec, k, m.member);
    const step = ctx.steps?.get(m.member);
    const planJson = runPlanJson(ctx, m.member, plan);
    const part = parts?.get(m.member) ?? step?.part;
    const row = policyRows.get(m.member);
    return {
      spec: spec.name,
      op: spec.op,
      wave: k,
      waveName: wave.name,
      job,
      target: m.member,
      runOp: m.op,
      planDigest: m.planDigest,
      plan,
      ...(planJson ? { planJson } : {}),
      ...(step?.artifact !== undefined ? { artifact: step.artifact } : {}),
      ...(part ? { changeSet: part } : {}),
      empty: m.empty === true,
      destructive: m.destructive === true,
      policy: row ? [row] : [],
      cwd,
    };
  });
  const out = hooks.length > 0 && runs.length > 0 ? await runOpWaveAfterPlanHooks(hooks, runs, ctx.log) : undefined;
  if (out) result.hooks.push(...out.outcomes);
  const plans: Record<string, OpRunWavePlan> = { ...(result.plans ?? {}) };
  for (const m of members) {
    const mine = out?.runs.get(m.member);
    const chant = policyRows.get(m.member);
    const rows = [...(chant ? [chant] : []), ...(mine?.policy ?? [])];
    if (mine?.policy.length) {
      const folded = foldPolicyRows(mine.policy, { ...(m.denied ? { denied: m.denied } : {}), ...(m.held ? { held: m.held } : {}) });
      if (folded.denied) m.denied = folded.denied;
      if (folded.held) m.held = folded.held;
    }
    if (rows.length === 0 && !mine?.files.length) continue;
    plans[m.member] = { planDigest: m.planDigest, ...(rows.length ? { policy: rows } : {}), ...(mine?.files.length ? { files: [...mine.files] } : {}) };
  }
  if (Object.keys(plans).length > 0) result.plans = plans;
  return { ...(out?.failed ? { failed: out.failed } : {}), holds: out?.holds ?? [] };
}

/** One field of a plan file, or undefined when the file or the field is missing. */
function readPlanFileField(path: string, field: string): unknown {
  try {
    return (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

/** A plan file's change-set part (#4545), when it gives one of the right shape. */
function partOf(value: unknown): ChangeSetPart | undefined {
  const p = value as Partial<ChangeSetPart> | undefined;
  return p && typeof p === "object" && p.member && typeof p.member.member === "string" && Array.isArray(p.entries) ? (p as ChangeSetPart) : undefined;
}

/** What planning a wave's runs gave: each run's plan, and the product's pending-fact fields (#3821). */
interface PlannedRuns {
  members: OpWaveMember[];
  /** Each run's change-set part, by target, when its plan gave one (#4545): what a policy hold reads. */
  parts?: Map<string, ChangeSetPart>;
  pending?: Record<string, unknown>;
  /** The plans file's overriders (#3821). */
  overriders?: string[];
  /** A label for where those overriders come from, used in refusals (#3848). */
  overridersSource?: string;
  /** Digest members that are not runs, such as the wave's cost (#3821). */
  extras?: WaveMember[];
  /** The change-set document the plans file gave (#4551). */
  changeSet?: ChangeSetDocument;
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

const placeOf = (ctx: WaveContext): HookPlace => ({ name: ctx.spec.name, op: ctx.spec.op, waveName: ctx.wave.name, k: ctx.k, cwd: ctx.cwd, exec: ctx.exec, log: ctx.log });

const hookRuns = (ctx: WaveContext, runs: readonly OpWaveRun[], members?: ReadonlyMap<string, OpWaveMember>): OpWaveHookRun[] =>
  runs.map((run) => {
    const { spec, k } = ctx;
    const m = members?.get(run.target);
    if (!m) return { target: run.target, op: run.op ?? spec.op };
    const plan = opWavePlanPath(spec, k, run.target);
    // #4614: the engine's plan document, from the step's artifact or the plan file's.
    const planJson = runPlanJson(ctx, run.target, plan);
    return { target: run.target, op: run.op ?? spec.op, plan, planDigest: m.planDigest, ...(planJson ? { planJson } : {}) };
  });

/** The engine's plan document a run's plan names (#4614): the step's artifact, else the plan file's `artifact`. */
function runPlanJson(ctx: Pick<WaveContext, "cwd" | "steps">, target: string, plan: string): string | undefined {
  const artifact = ctx.steps?.get(target)?.artifact ?? readPlanFileField(join(ctx.cwd, plan), "artifact");
  return planJsonOf(artifact, ctx.cwd);
}

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
  const hookExec = ctx.options.hookExec;
  const out = hookExec
    ? await runHookListAsync({ ...placeOf(ctx), exec: hookExec }, moment, hooks, hookRuns(ctx, runs, members), runsPath, extraEnv)
    : runHookList(placeOf(ctx), moment, hooks, hookRuns(ctx, runs, members), runsPath, extraEnv);
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
      const target = hold.target ? { target: hold.target } : {};
      const approvedEnv: Record<string, string> = {
        ...hold.env,
        CHANT_HOLD_APPROVED: JSON.stringify(now),
        // Every hold this hook call was approved through so far, oldest first (#3847).
        CHANT_HOLDS_APPROVED: JSON.stringify(approved),
      };
      const holdPath = join(ctx.cwd, hold.env.CHANT_HOLD!);
      rmSync(holdPath, { force: true });
      // #4623: a hold that asks chant to record its gate is spent here, before the re-run acts under the approval.
      let spent: AppliedGateRecord | undefined;
      let finishedAt: string | undefined;
      if (hold.request.record) {
        const got = await spendHeldGate(ctx, hold, now);
        if ("failed" in got) {
          ctx.result.hooks.push({ moment, name: hold.name, ...target, exit: 1, outcome: "failed" });
          back.failed = got.failed;
          ctx.log(back.failed);
          return back;
        }
        spent = got.record;
        const finishedRel = holdFinishedPath(hold.env.CHANT_HOLD!);
        finishedAt = join(ctx.cwd, finishedRel);
        rmSync(finishedAt, { force: true });
        approvedEnv.CHANT_HOLD_FINISHED = finishedRel;
      }
      let code: number;
      try {
        code = hookExec ? await hookExec(hold.argv, ctx.cwd, approvedEnv) : ctx.exec(hold.argv, ctx.cwd, approvedEnv);
      } catch (err) {
        ctx.log(`${hold.label} did not run: ${err instanceof Error ? err.message : String(err)}`);
        code = 127;
      }
      if (spent && finishedAt) await finishHeldGate(ctx, hold, spent, readHoldFinished(finishedAt, ctx.log, hold.label), code);
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

/**
 * The hooks that run before a job plans (#4288): `before-observe`, then
 * `before-plan`. A failure or a hold on another gate in the first ends it
 * there; the holds of both add up.
 */
async function runBeforePlanHooks(ctx: WaveContext, hooks: Partial<Record<OpWaveHookMoment, OpWaveHook[]>> | undefined, runs: readonly OpWaveRun[]): Promise<HooksOutcome> {
  const observe = await runHooks(ctx, "before-observe", hooks?.["before-observe"], runs);
  if (observe.failed || observe.waitingOn) return observe;
  const plan = await runHooks(ctx, "before-plan", hooks?.["before-plan"], runs);
  return { ...plan, holds: [...observe.holds, ...plan.holds] };
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
 * Spend a held gate's approval before the hook runs again under it (#4623),
 * when the hold asked chant to `record` the gate: an applied line in
 * `_gates/<op>/applied.jsonl`, as a gated request's (#4551). A digest that
 * already applied under this gate does not apply again, and a line that did
 * not reach the remote stops the re-run, so two jobs never act on one
 * approval.
 */
async function spendHeldGate(ctx: WaveContext, hold: OtherGateHold, approval: OpWaveHeldOnApproval): Promise<{ record: AppliedGateRecord } | { failed: string }> {
  const { k, wave, cwd, options } = ctx;
  const port = options.gates ?? gitGateLedgerPort({ cwd });
  const label = `${approval.op} / ${approval.gate}`;
  try {
    if (!port.appendApplied) throw new Error("this gate ledger cannot record an applied approval");
    const prior = ((await port.readApplied?.(approval.op)) ?? []).filter((a) => a.gate === approval.gate && samePlanDigest(a.planDigest, approval.digest)).at(-1);
    if (prior) return { failed: `${hold.label}: ${label} at ${approval.digest} applied already under the approval by ${prior.approvedBy} (${prior.timestamp}); a held request applies once, so the hook did not run again` };
    const commit = typeof hold.request.pending?.commit === "string" ? hold.request.pending.commit : undefined;
    const runId = ciRunIdFromEnv();
    const record: AppliedGateRecord = {
      version: 1,
      kind: "applied",
      op: approval.op,
      gate: approval.gate,
      planDigest: approval.digest,
      approvedAt: approval.approvedAt,
      approvedBy: approval.approvedBy,
      timestamp: options.now ?? new Date().toISOString(),
      wave: { number: k, name: wave.name },
      ...(runId ? { runId } : {}),
      ...(commit ? { commit } : {}),
    };
    requireSpendPushed(await port.appendApplied(record));
    ctx.log(`${hold.label}: ${label} applies under the approval by ${record.approvedBy} at ${record.approvedAt}, which is now spent`);
    return { record };
  } catch (err) {
    return { failed: `${hold.label}: could not record that ${label} applies under the approval by ${approval.approvedBy}, so the hook did not run again: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Write the finished line of a held gate the hook ran again under (#4623):
 * how it ended, from the hook's `CHANT_HOLD_FINISHED` file, else from its
 * exit code, with the file's detail. A line that is not written is logged;
 * the work under the approval is done either way.
 */
async function finishHeldGate(ctx: WaveContext, hold: OtherGateHold, spent: AppliedGateRecord, wrote: OpWaveHoldFinished | undefined, code: number): Promise<void> {
  const port = ctx.options.gates ?? gitGateLedgerPort({ cwd: ctx.cwd });
  const record: FinishedGateRecord = {
    version: 1,
    kind: "finished",
    op: spent.op,
    gate: spent.gate,
    planDigest: spent.planDigest,
    applied: spent.timestamp,
    result: wrote?.result ?? (code === 0 ? "applied" : "failed"),
    timestamp: ctx.options.now ?? new Date().toISOString(),
    ...(wrote?.detail ? { detail: wrote.detail } : {}),
  };
  try {
    if (!port.appendFinished) throw new Error("this gate ledger keeps no finished lines");
    const pushed = await port.appendFinished(record);
    if (!pushed.pushed && pushed.pushWarning && !isLifecycleLocalNote(pushed.pushWarning)) ctx.log(`${hold.label}: the finished line of ${spent.op} / ${spent.gate} was written and not pushed: ${pushed.pushWarning}`);
  } catch (err) {
    ctx.log(`${hold.label}: the finished line of ${spent.op} / ${spent.gate} was not written: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  // #4623: the file the request carries, stored once before the pending fact, which names its SHA-256.
  const attachment = hold.request.attachment;
  if (attachment !== undefined) {
    try {
      if (!port.storeRequestAttachment) throw new Error("this gate ledger keeps no request files");
      await port.storeRequestAttachment(op, hold.request.digest, attachment);
    } catch (err) {
      log(`${op} / ${hold.request.gate}: the file ${hold.label} attached was not stored beside the pending fact: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const proof = attachment !== undefined ? { proof: `sha256:${createHash("sha256").update(attachment).digest("hex")}` } : {};
  const check = await evaluateGate(port, {
    op,
    gate: hold.request.gate,
    planDigest: hold.request.digest,
    description: hold.request.description ?? `wave ${k} (${wave.name}) of ${spec.name} is held on it by ${hold.label}`,
    now,
    // #3839: the wave a hold belongs to, as a field, whatever the hook's own description says.
    fields: { ...hold.request.pending, ...proof, approvalMode: rules.approval, wave: { number: k, name: wave.name, op: spec.name }, heldBy: { hook: hold.name, moment: hold.moment, ...(hold.target ? { target: hold.target } : {}) } },
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
  assertOpWavesSpec(options.spec);
  const afterPlanWrong = opWaveAfterPlanProblems(options.afterPlan);
  if (afterPlanWrong.length > 0) throw new Error(`Op waves "${options.spec.name}": ${afterPlanWrong.join("; ")}`);
  // #4551: one run record per job, on every way the job ends.
  const started = new Date().toISOString();
  // #4555: the job's run events and its trace, when a reader or an exporter wants them.
  const events = await openOpWaveEvents(options);
  if (events) jobEvents.set(options, events);
  events?.start();
  let result: RunOpWaveResult;
  try {
    result = await runOpWaveJob(options);
  } catch (err) {
    const record = await recordOpWaveRun(options, started, { error: err });
    await closeOpWaveEvents(options, events, record);
    throw err;
  }
  const record = await recordOpWaveRun(options, started, { result });
  await closeOpWaveEvents(options, events, record, result);
  return result;
}

/** Each running job's events (#4555), by its options, which every step of the job is handed. */
const jobEvents = new WeakMap<RunOpWaveOptions, OpWaveRunEvents>();

/** The job's run events (#4555): to `options.events`, and to a trace when the exporter is on. Undefined when neither wants them. */
async function openOpWaveEvents(options: RunOpWaveOptions): Promise<OpWaveRunEvents | undefined> {
  const log = options.log ?? ((line: string) => console.error(line));
  let exporter: OtlpExporter | undefined;
  try {
    exporter = options.otlp === false ? undefined : (options.otlp ?? activeOtlp());
  } catch (err) {
    log(`wave ${options.wave}: no trace is sent: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!options.events && !exporter) return undefined;
  let trace: RunEventTrace | undefined;
  if (exporter) {
    const run = await resolveRunEventRun({ kind: "op", name: options.spec.name, cwd: options.cwd ?? process.cwd() });
    trace = new RunEventTrace(run, { exporter });
  }
  return new OpWaveRunEvents(joinRunEventSinks(options.events, trace?.sink)!, trace);
}

/** Settle the job's events from its run record and send its trace (#4555). A trace that does not go out is a line in the log, never a change of exit code. */
async function closeOpWaveEvents(options: RunOpWaveOptions, events: OpWaveRunEvents | undefined, record: OpRunRecordInput, result?: RunOpWaveResult): Promise<void> {
  if (!events) return;
  jobEvents.delete(options);
  events.finish(record, { ...(result ? { moved: result.moved } : {}), ...(result?.blocked ? { blocked: result.blocked } : {}) });
  const problem = await events.trace?.flush();
  if (problem) (options.log ?? ((line: string) => console.error(line)))(`wave ${options.wave}: the trace was not sent: ${problem}`);
}

/** A target's apply began (#4555): its start time for the record, and its `step-start`. */
function targetStarted(options: RunOpWaveOptions, k: number, target: string): number {
  jobEvents.get(options)?.stepStart(k, target);
  return Date.now();
}

/** A target's apply ended (#4555): its time and facts on the result, and its `step-settle`. */
function targetSettled(options: RunOpWaveOptions, result: RunOpWaveResult, k: number, target: string, startedMs: number, status: "ok" | "failed" | "skipped", opts: { error?: string; facts?: CapabilityTraceFacts } = {}): void {
  const durationMs = Math.max(0, Date.now() - startedMs);
  result.targets = {
    ...result.targets,
    [target]: {
      startedAt: new Date(startedMs).toISOString(),
      durationMs,
      ...(opts.facts?.attributes ? { attributes: opts.facts.attributes } : {}),
      ...(opts.facts?.spans?.length ? { spans: opts.facts.spans } : {}),
      // #4629: what the failed-apply triage reads back from the run record.
      ...(status === "failed" && opts.error ? { error: opts.error } : {}),
      ...(status === "failed" && opts.facts?.resources?.some((r) => r.status === "failed")
        ? { failedResources: opts.facts.resources.filter((r) => r.status === "failed").map((r) => r.name ?? r.resource) }
        : {}),
    },
  };
  jobEvents.get(options)?.stepSettle(k, target, status, durationMs, opts);
  // #4615: one log line per resource the engine reported.
  if (opts.facts?.resources?.length) {
    const log = options.log ?? ((line: string) => console.error(line));
    for (const line of opWaveResourceLines(target, opts.facts.resources)) log(line);
  }
}

/** The log lines for what a target's engine reported per resource (#4615): `<target>: <resource> (<type>) ok in 412 ms, 3 calls`. */
export function opWaveResourceLines(target: string, resources: readonly RunEventResource[]): string[] {
  return resources.map((r) => {
    const what = r.name ? `${r.name}${r.type ? ` (${r.type})` : ""}` : `${r.resource}${r.type ? ` (${r.type})` : ""}`;
    const took = r.durationMs === null ? "" : ` in ${Math.round(r.durationMs)} ms`;
    const calls = r.calls !== undefined ? `, ${r.calls} call${r.calls === 1 ? "" : "s"}` : "";
    return `${target}: ${what} ${r.status === "ok" ? "ok" : "failed"}${took}${calls}`;
  });
}

/** The run ledger's status and failure for a job's exit code (#4551), by chant's exit-code table. */
function opWaveRunStatus(result: RunOpWaveResult): { status: OpRunRecordInput["status"]; failure?: { code: string; reason: string } } {
  const d = result.decision;
  switch (result.exitCode) {
    case CHANT_EXIT.done:
    case CHANT_EXIT.held:
    case CHANT_EXIT.superseded:
      return { status: "ok" };
    case CHANT_EXIT.waiting:
      return { status: d?.point?.question ? "waiting" : "gated" };
    case CHANT_EXIT.moved:
      return { status: "fail", failure: { code: "moved", reason: `plans moved since the decision: ${result.moved.join(", ") || "(none named)"}` } };
    case CHANT_EXIT.denied:
      return { status: "fail", failure: { code: "denied", reason: d?.refused?.message ?? `the policy denied ${d?.refused?.runs.join(", ") ?? "a run"}, and no override counts` } };
    case CHANT_EXIT.declined:
      return { status: "fail", failure: { code: "point-refused", reason: d?.refused?.message ?? "the gate's decision point was answered with an answer it does not pass on" } };
    default:
      return { status: "fail", failure: { code: "command-failed", reason: result.failed.length > 0 ? `failed: ${result.failed.join(", ")}` : "the wave job failed" } };
  }
}

/**
 * The run record of one `chant run wave` job (#4551): one phase per wave the
 * job walked, one step per run target. A run that applied is `ok`, one that
 * failed `fail`, and one that moved, was blocked or waited `skipped`.
 */
export function opWaveRunRecord(
  options: Pick<RunOpWaveOptions, "spec" | "wave" | "decide" | "share" | "group">,
  times: { started: string; ended: string; gitSha?: string; runOrigin?: OpRunRecordInput["runOrigin"] },
  outcome: { result: RunOpWaveResult } | { error: unknown },
): OpRunRecordInput {
  const { spec } = options;
  const result: RunOpWaveResult = "result" in outcome ? outcome.result : { exitCode: CHANT_EXIT.failed, applied: [], failed: [], moved: [], hooks: [] };
  const d = result.decision;
  const applied = new Set(result.applied);
  const failedRuns = new Set(result.failed);
  const walked = result.rest?.length ? result.rest.map((r) => r.wave) : [options.wave];
  const last = walked[walked.length - 1];
  const phases = walked.map((k) => {
    const targets = k === last && d ? d.members.map((m) => m.member) : (spec.waves[k - 1]?.runs ?? []).map((r) => r.target);
    const steps: OpRunStepRecord[] = targets.map((t) => ({
      fn: t,
      status: failedRuns.has(t) ? "fail" : applied.has(t) ? "ok" : "skipped",
      durationMs: result.targets?.[t]?.durationMs ?? 0,
    }));
    const status: "ok" | "fail" | "skipped" = steps.some((x) => x.status === "fail") ? "fail" : steps.length > 0 && steps.every((x) => x.status === "skipped") ? "skipped" : "ok";
    return { name: `wave-${k}`, status, steps };
  });
  const verdict: ReturnType<typeof opWaveRunStatus> = "error" in outcome
    ? { status: "fail", failure: { code: "command-failed", reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) } }
    : opWaveRunStatus(result);
  const wave: OpRunWave = {
    spec: spec.name,
    number: options.wave,
    name: spec.waves[options.wave - 1]?.name ?? `wave-${options.wave}`,
    job: options.decide ? "decide" : options.group !== undefined ? "group" : options.share !== undefined ? "share" : "wave",
    ...(options.share !== undefined ? { share: options.share } : {}),
    ...(options.group !== undefined ? { group: options.group } : {}),
    ...(d?.digest ? { digest: d.digest } : {}),
    exitCode: result.exitCode,
    ...(result.outcome && result.outcome.outcome !== "replan" ? { outcome: result.outcome.outcome } : {}),
    ...(result.supersededBy ? { supersededBy: { ...result.supersededBy } } : {}),
    applied: [...result.applied],
    failed: [...result.failed],
    moved: [...result.moved],
    ...(result.blocked && Object.keys(result.blocked).length > 0 ? { blocked: { ...result.blocked } } : {}),
    ...(result.targets && Object.keys(result.targets).length > 0 ? { targets: { ...result.targets } } : {}),
    ...(result.plans && Object.keys(result.plans).length > 0 ? { plans: { ...result.plans } } : {}),
  };
  const labels = { ...(spec.labels ?? {}) };
  return {
    op: spec.name,
    env: labels.Env ?? DEFAULT_RUN_ENV,
    started: times.started,
    ended: times.ended,
    status: verdict.status,
    labels,
    outcomes: {},
    phases,
    ...(verdict.status === "gated" && d ? { gate: { name: d.gate, since: d.waitingSince ?? times.ended, ...(d.op !== spec.name ? { op: d.op } : {}) } } : {}),
    ...(verdict.status === "waiting" && d?.point?.question ? { point: { ...d.point.question, since: d.waitingSince ?? times.ended } } : {}),
    ...(times.gitSha ? { gitSha: times.gitSha } : {}),
    ...(times.runOrigin ? { runOrigin: times.runOrigin } : {}),
    ...(verdict.failure ? { failure: { ...verdict.failure, exitCode: result.exitCode } } : {}),
    wave,
  };
}

/** Append the job's run record (#4551). A failed write warns and never changes the job's exit code. */
async function recordOpWaveRun(options: RunOpWaveOptions, started: string, outcome: { result: RunOpWaveResult } | { error: unknown }): Promise<OpRunRecordInput> {
  const cwd = options.cwd ?? process.cwd();
  const port = options.runs ?? (options.gates ? undefined : gitOpWaveRunPort({ cwd }));
  const log = options.log ?? ((line: string) => console.error(line));
  let gitSha = options.head;
  if (gitSha === undefined) {
    try {
      gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      gitSha = undefined;
    }
  }
  const ci = resolveCiJob();
  const record = opWaveRunRecord(options, { started, ended: new Date().toISOString(), ...(gitSha ? { gitSha } : {}), ...(ci ? { runOrigin: ci.runOrigin } : {}) }, outcome);
  // The record is built either way: the job's run events settle from it (#4555).
  if (!port) return record;
  try {
    const wrote = await port.append(record);
    if (wrote && wrote.pushWarning) log(`wave ${options.wave}: the run record was written and not pushed: ${wrote.pushWarning}`);
  } catch (err) {
    log(`wave ${options.wave}: could not record the run on the run ledger: ${err instanceof Error ? err.message : String(err)}`);
  }
  return record;
}

/**
 * Store the change-set document a wave's plans file gave (#4551), so the
 * pending fact can cite it. A document that is not one, or does not hash to
 * its digest, is logged and left out; it never blocks the gate.
 */
async function storeWaveChangeSet(options: RunOpWaveOptions, ctx: WaveContext, decision: OpWaveDecision, doc: ChangeSetDocument): Promise<void> {
  const ledger = options.gates ?? gitGateLedgerPort({ cwd: ctx.cwd });
  if (!ledger.storeChangeSet) return;
  try {
    await ledger.storeChangeSet(doc);
    decision.changeSet = doc.digest;
  } catch (err) {
    ctx.log(`wave ${ctx.k} (${ctx.wave.name}): the plans file's change set was not stored, so the pending fact cites none: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One job's plan, decide and apply, which {@link runOpWave} records. */
async function runOpWaveJob(options: RunOpWaveOptions): Promise<RunOpWaveResult> {
  const { spec } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const cwd = options.cwd ?? process.cwd();
  const outcomeDir = options.outcomeDir ?? opWaveOutcomeDir(spec);
  const dir = isAbsolute(outcomeDir) ? outcomeDir : join(cwd, outcomeDir);
  // #4322: what the earlier jobs' outcome files say: an earlier wave that stopped stops this one, and a failure blocks its dependents.
  const before = opWaveBefore(options, dir);
  const blocked = before.blocked;
  if (before.stop) {
    log(before.stop.line);
    const stopped: RunOpWaveResult = { exitCode: before.stop.exitCode, applied: [], failed: [], moved: [], hooks: [], ...(blocked.size > 0 ? { blocked: Object.fromEntries(blocked) } : {}) };
    writeOpWaveOutcome(options, dir, stopped, before.stop.members);
    return stopped;
  }
  if (blocked.size > 0) log(`wave ${options.wave}: ${blockedWords(blocked)}, so not planned or applied`);
  const mine = jobRuns(options);
  if (mine.length > 0 && mine.every((t) => blocked.has(t))) {
    // Every run of this job is blocked: nothing to plan, decide or apply.
    const none: RunOpWaveResult = { exitCode: options.decide ? 0 : 1, applied: [], failed: [], moved: [], hooks: [], blocked: Object.fromEntries(blocked) };
    writeOpWaveOutcome(options, dir, none);
    return none;
  }
  let result: RunOpWaveResult;
  const applied: string[] = [];
  try {
    result = await runOpWaveLoop(options, log, applied, blocked);
  } catch (err) {
    writeOpWaveOutcome(options, dir, { exitCode: 1, applied, failed: [], moved: [], hooks: [], ...(blocked.size > 0 ? { blocked: Object.fromEntries(blocked) } : {}) });
    throw err;
  }
  const all = { ...Object.fromEntries(blocked), ...(result.blocked ?? {}) };
  if (Object.keys(all).length > 0) {
    result.blocked = all;
    // A deciding job applies nothing; its share jobs fail for the blocked runs of their slices.
    if (result.exitCode === 0 && !options.decide) {
      log(`wave ${options.wave}: the runs that could apply did; ${blockedWords(new Map(Object.entries(all)))}, so this job fails`);
      result.exitCode = 1;
    }
  }
  writeOpWaveOutcome(options, dir, result);
  return result;
}

/** The wave engine's loop over this module's steps, from `options.wave` on, with the runs in `skip` left out of that wave. */
async function runOpWaveLoop(options: RunOpWaveOptions, log: (line: string) => void, applied: string[], skip: ReadonlyMap<string, string>): Promise<RunOpWaveResult> {
  const { spec } = options;
  const last = spec.waves[spec.waves.length - 1]!;
  const rest: NonNullable<RunOpWaveResult["rest"]> = [];
  // #4555: each wave a `rest` job walks keeps its targets' times.
  const targets: Record<string, OpRunWaveTarget> = {};
  const result = await runWaveLoop<OpWavePlanned, OpWaveDecided, RunOpWaveResult>({
    first: options.wave,
    plan: (at) => planOpWave(options, at, at.k === options.wave ? skip : undefined),
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
      Object.assign(targets, outcome.targets ?? {});
      // #3821: a `rest` wave goes on through the waves its plan command found.
      const found = outcome.decision?.discovered?.waves;
      const onward = k >= spec.waves.length && last.rest === true && options.share === undefined && options.group === undefined && !options.decide && outcome.exitCode === 0 && found !== undefined && k < found;
      if (rest.length > 0 || onward) rest.push({ wave: k, exitCode: outcome.exitCode, ...(outcome.decision ? { digest: outcome.decision.digest } : {}) });
      if (onward) log(`wave ${k} applied; the plan found ${found} waves, so this job goes on to wave ${k + 1}`);
      return onward;
    },
  });
  const timed = { ...targets, ...(result.targets ?? {}) };
  return { ...result, applied, ...(rest.length > 0 ? { rest } : {}), ...(Object.keys(timed).length > 0 ? { targets: timed } : {}) };
}

/** What the earlier outcome files hold for a job (#4322): the runs they block, or why the job does not run at all. */
interface OpWaveBefore {
  /** Each blocked run of this wave, with the run whose failure blocked it. */
  blocked: Map<string, string>;
  /** Set when the job runs nothing: its exit code, the log line, and the outcomes it writes. */
  stop?: { exitCode: number; line: string; members: Record<string, WaveMemberOutcome> };
}

/**
 * Read the outcome files under `dir` for wave `k`'s job (#4322). A wave or
 * deciding job reads the earlier waves': with none at all (a pipeline
 * rendered before #4322, or a job run by hand) every earlier run counts as
 * applied, as `needs:` used to promise. An earlier run that waits at its gate
 * stops this wave (exit 3), and one that was refused, held, stood down or
 * moved, or whose share never reported, stops it too (exit 1): only a failure
 * lets the waves after it go on. Otherwise a run whose `dependsOn` names a
 * run that failed or was blocked is blocked, and so is one that depends on
 * it. A share job reads its deciding job's file instead: the runs it blocked
 * stay blocked, and a run that job failed on stops the share (exit 1), so a
 * decision record it left behind before failing applies nothing.
 */
function opWaveBefore(options: RunOpWaveOptions, dir: string): OpWaveBefore {
  const { spec, wave: k } = options;
  const wave = spec.waves[k - 1];
  if (!wave) return { blocked: new Map() };
  if (options.share !== undefined || options.group !== undefined) {
    const decided = readWaveOutcomeFile([dir], waveOutcomeFileName(k));
    if (!decided) return { blocked: new Map() };
    const blocked = new Map<string, string>();
    const held: Array<[string, WaveMemberOutcome]> = [];
    for (const [target, o] of Object.entries(decided.members)) {
      if (o.status === "blocked") blocked.set(target, o.by ?? target);
      // A wave that waits or was refused says so in its decision record, which the share reads as before.
      else if (o.status !== "decided" && o.status !== "waiting" && o.status !== "refused") held.push([target, o]);
    }
    if (held.length === 0) return { blocked };
    const line = `${shareLabel(options)} of wave ${k} (${wave.name}) applies nothing: its deciding job did not decide ${held.map(([t, o]) => `${t} (${o.status})`).join(", ")}`;
    return { blocked, stop: { exitCode: 1, line, members: { ...decided.members } } };
  }
  if (k === 1) return { blocked: new Map() };
  const { members } = earlierWaveOutcomes([dir], k);
  if (members.size === 0) return { blocked: new Map() };
  const held = [...members].filter(([, o]) => !passesThrough(o) && o.status !== "failed" && o.status !== "blocked");
  if (held.length > 0) {
    const waiting = held.filter(([, o]) => o.status === "waiting");
    const shown = (waiting.length > 0 ? waiting : held).map(([t, o]) => `${t} (wave ${o.wave}${waiting.length > 0 ? "" : `, ${o.status}`})`).join(", ");
    const line = waiting.length > 0
      ? `Nothing in wave ${k} (${wave.name}) ran: ${shown} waits at its gate. Approve it and run that wave's job again, then this one.`
      : `Nothing in wave ${k} (${wave.name}) ran: ${shown} did not apply, and only a failure lets the waves after it go on.`;
    const status = waiting.length > 0 ? "waiting" : "not-applied";
    return { blocked: new Map(), stop: { exitCode: waiting.length > 0 ? CHANT_EXIT.waiting : CHANT_EXIT.failed, line, members: Object.fromEntries((wave.runs ?? []).map((r) => [r.target, { status }])) } };
  }
  const runs = wave.runs ?? [];
  const index = new Map(runs.map((r, i) => [r.target, i]));
  const ownBefore = (i: number, dep: string): boolean => (index.get(dep) ?? Infinity) < i;
  const upstreams = new Map(runs.map((r, i) => [r.target, (r.dependsOn ?? []).filter((d) => !ownBefore(i, d))]));
  const blocked = blockedMembers(runs.map((r) => r.target), upstreams, new Set([...upstreams.values()].flat()), members);
  // A run listed before this one in its own wave and blocked blocks it too, by the same failure.
  runs.forEach((run, i) => {
    if (blocked.has(run.target)) return;
    const dep = (run.dependsOn ?? []).filter((d) => ownBefore(i, d) && blocked.has(d)).sort()[0];
    if (dep !== undefined) blocked.set(run.target, blocked.get(dep)!);
  });
  return { blocked };
}

/** The runs of wave `options.wave` this job holds (#4322): its slice for a share job, every run otherwise. Empty for a discovering wave. */
function jobRuns(options: RunOpWaveOptions, runs?: readonly OpWaveRun[]): string[] {
  const wave = options.spec.waves[options.wave - 1];
  if (!wave) return [];
  const all = runs ?? (wave.discover ? [] : wave.runs);
  if (options.share === undefined && options.group === undefined) return all.map((r) => r.target);
  const group = options.group === undefined ? undefined : wave.jobs?.find((g) => g.name === options.group);
  if (options.group !== undefined && !group) return [];
  const shares = group ? (group.shares ?? 1) : (wave.shares ?? 1);
  return opWaveShare(group ? opWaveGroupRuns(group, all) : all, options.share ?? 1, shares).map((r) => r.target);
}

/**
 * Write this job's outcome file (#4322): each of its runs' outcome, from how
 * the job ended. `members`, when given, is written as it is.
 */
function writeOpWaveOutcome(options: RunOpWaveOptions, dir: string, result: RunOpWaveResult, members?: Record<string, WaveMemberOutcome>): void {
  const out: Record<string, WaveMemberOutcome> = { ...(members ?? {}) };
  if (!members) {
    const found = result.decision?.discovered !== undefined ? result.decision.members.map((m) => ({ target: m.member })) : undefined;
    const targets = new Set([...jobRuns(options, found), ...result.applied, ...result.failed, ...result.moved, ...Object.keys(result.blocked ?? {})]);
    const applied = new Set(result.applied);
    const failed = new Set(result.failed);
    const moved = new Set(result.moved);
    const otherwise: WaveMemberOutcome["status"] =
      result.exitCode === 0 ? (options.decide ? "decided" : "unchanged")
      : result.exitCode === CHANT_EXIT.waiting ? "waiting"
      : result.exitCode === CHANT_EXIT.denied || result.exitCode === CHANT_EXIT.declined ? "refused"
      : result.exitCode >= CHANT_EXIT.moved && result.exitCode <= CHANT_EXIT.superseded ? "not-applied"
      : "failed";
    for (const t of targets) {
      const by = result.blocked?.[t];
      out[t] = by !== undefined ? { status: "blocked", by } : applied.has(t) ? { status: "applied" } : failed.has(t) ? { status: "failed" } : moved.has(t) ? { status: "not-applied" } : { status: otherwise };
    }
  }
  const part = { ...(options.group !== undefined ? { group: options.group } : {}), ...(options.share !== undefined ? { share: options.share } : {}) };
  try {
    mkdirSync(dir, { recursive: true });
    writeWaveOutcomeFile(dir, options.wave, part, out, options.now ?? new Date().toISOString());
  } catch (err) {
    (options.log ?? ((line: string) => console.error(line)))(`wave ${options.wave}: could not write its outcome file in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
      changeSet?: ChangeSetDocument;
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
async function planOpWave(options: RunOpWaveOptions, { k, pass }: WaveAttempt<RunOpWaveResult>, skip?: ReadonlyMap<string, string>): Promise<WaveStep<OpWavePlanned, RunOpWaveResult>> {
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
      return { end: { ...result, exitCode: decision.status === "refused" ? refusedExit(decision) : CHANT_EXIT.waiting } };
    }
    // The share runs the hooks its deciding job read at base, around its own slice.
    if (wave.discover) {
      // #3821: a discovering wave's runs are the ones its deciding job planned.
      wave = { ...wave, runs: decision.members.map((m) => ({ target: m.member, ...(m.op !== spec.op ? { op: m.op } : {}) })) };
      ctx.wave = wave;
    }
    const whole = opWaveShare(group ? opWaveGroupRuns(group, wave.runs) : wave.runs, options.share ?? 1, shares);
    if (group && whole.length === 0) {
      log(`${part} of wave ${k} (${wave.name}) holds none of the wave's runs; nothing to apply`);
      return { end: result };
    }
    // #4322: the runs its deciding job blocked are neither planned nor applied here.
    const slice = whole.filter((r) => !skip?.has(r.target));
    if (slice.length === 0) return { end: result };
    const before = await runBeforePlanHooks(ctx, decision.hooks, slice);
    if (before.failed) return { end: failed(ctx, `a hook before the plan failed, so nothing in ${part} of wave ${k} was planned or applied`) };
    if (before.waitingOn) return { end: await waitOnOther(ctx, decision, before.waitingOn) };
    if (spec.step) ctx.steps = new Map();
    const { members, parts: sliceParts } = await planWaveRuns(ctx, slice);
    // #4614: the after-plan hooks in the job's process, over the share's own plans.
    const inProcess = await runAfterPlan(ctx, members, sliceParts, new Map());
    if (inProcess.failed) return { end: failed(ctx, `${inProcess.failed}, so nothing in ${part} of wave ${k} was applied`) };
    const planned = new Map(members.map((m) => [m.member, m]));
    const after = await runHooks(ctx, "after-plan", decision.hooks?.["after-plan"], slice, planned);
    if (after.failed) return { end: failed(ctx, `a hook after the plan failed, so nothing in ${part} of wave ${k} was applied`) };
    if (after.waitingOn) return { end: await waitOnOther(ctx, decision, after.waitingOn) };
    return { go: { kind: "share", ctx, decision, slice, planned, holds: [...before.holds, ...inProcess.holds, ...after.holds] } };
  }

  // The policy, the approval mode and the hooks, read at base before anything runs.
  const rules = readOpWavePolicy(options.specFile, wave.name, options.base ?? spec.base ?? "HEAD^1", cwd, options.show);
  const { policy, approval, source, base } = rules;
  const neverOverMcp = rules.neverOverMcp || spec.neverOverMcp === true;
  ctx.gateRule = { approval, base, neverOverMcp };
  noteHooksAtBase(ctx, rules);
  // #3836: a point at base that cannot be asked fails the wave; the ledger never stands in for it.
  if (rules.pointRefused) return { end: failed(ctx, `wave ${k} (${wave.name}): ${rules.pointRefused}, so nothing in it was planned or applied`) };
  // #4290: rules at base that cannot be read fail the wave; fewer approvers never stand in for them.
  if (rules.quorumRefused) return { end: failed(ctx, `wave ${k} (${wave.name}): ${rules.quorumRefused}, so nothing in it was planned or applied`) };
  if (rules.quorum && rules.point) return { end: failed(ctx, `wave ${k} (${wave.name}): approvals.quorum and a decision point are both set at ${base.slice(0, 12)}; a gate that asks a point takes its deciders from the point, so nothing in it was planned or applied`) };
  if (JSON.stringify(spec.approvals?.quorum ?? null) !== JSON.stringify(rules.quorum ?? null)) {
    log(`wave ${k} (${wave.name}): its approval rules are read at ${base.slice(0, 12)}, and this change's differ; the ones at base hold`);
  }
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
  if (skip?.size && !wave.discover) {
    // #4322: a run a failure blocked is neither planned nor in the set digest.
    wave = { ...wave, runs: wave.runs.filter((r) => !skip.has(r.target)) };
    ctx.wave = wave;
  }
  const before = await runBeforePlanHooks(ctx, rules.hooks, wave.runs);
  if (before.failed) return { end: failed(ctx, `a hook before the plan failed, so nothing in wave ${k} was planned or applied`) };
  if (before.waitingOn) return { end: await decided(ctx, decision, recordPath, before.waitingOn) };
  if (spec.step) ctx.steps = new Map();
  const { members, pending, overriders, overridersSource, extras: planExtras, waves: found, changeSet, parts } = await planWaveRuns(ctx, wave.runs, wave.discover === true);
  // #4545: the holds at base (else the change's), run over the plans before the gate decides.
  let extras = planExtras;
  let policyRows = new Map<string, OpRunPolicyRow>();
  if (rules.holdsRefused) {
    holds.push(rules.holdsRefused);
    log(`wave ${k} (${wave.name}): ${rules.holdsRefused}, so none runs and the wave waits for an approval`);
  } else {
    const held = await runWaveHolds(ctx, opWaveHoldsAt(rules.holds, spec.holds), members, parts, base);
    if ("failed" in held) return { end: failed(ctx, held.failed) };
    holds.push(...held.holds);
    if (held.extras.length > 0) extras = [...(extras ?? []), ...held.extras];
    policyRows = held.rows;
    // #4613: the decision names the shared policy commit its runs were judged by.
    if (held.policySource) decision.ciPolicySource = held.policySource;
  }
  // #4614: the after-plan hooks in the job's process, before the set digest and the gate.
  const inProcess = await runAfterPlan(ctx, members, parts, policyRows);
  if (inProcess.failed) return { end: failed(ctx, `${inProcess.failed}, so nothing in wave ${k} was approved or applied`) };
  holds.push(...inProcess.holds);
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
      ...(changeSet ? { changeSet } : {}),
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
  // #4290: the rules at base whose targets glob matches one of the wave's runs.
  const takes = planned.rules.quorum ? quorumRulesFor(planned.rules.quorum, members.map((m) => m.member)) : [];
  if (takes.length > 0) {
    decision.quorum = takes;
    if (planned.rules.reviewLedger) decision.reviewLedger = planned.rules.reviewLedger;
    if (planned.rules.involved) decision.involved = planned.rules.involved;
  }
  if (extras) decision.extras = extras;
  if (pending) decision.pending = pending;
  if (planned.changeSet) await storeWaveChangeSet(options, ctx, decision, planned.changeSet);
  // #4550: a pull-request wave checks the pull request's approval against the plans file's change set.
  if (planned.changeSet) ctx.changeSetDoc = planned.changeSet;
  if (decision.approval === "pull-request" && planned.rules.pullRequestGate) decision.pullRequestGate = planned.rules.pullRequestGate;
  const after = await runHooks(ctx, "after-plan", planned.rules.hooks["after-plan"], wave.runs, planned.planned, digest);
  if (after.failed) return { end: failed(ctx, `a hook after the plan failed, so nothing in wave ${k} was applied`) };
  holds.push(...planned.before, ...after.holds);
  // #4294: a run the product's policy holds makes the wave wait for a person, as a held hook does.
  for (const m of members) if (m.held) holds.push(`policy on ${m.member} (${m.held.rules.join(", ")})${m.held.reason ? `: ${m.held.reason}` : ""}`);
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
  if (planned.kind === "share" && ctx.result.exitCode === 0 && ctx.result.moved.length > 0) ctx.result.exitCode = CHANT_EXIT.moved;
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
    return { ...result, exitCode: CHANT_EXIT.waiting };
  }
  if (decision.status === "refused" && decision.refused?.reason === "point") {
    log(`Nothing in wave ${k} (${wave.name}) or after it ran: ${decision.refused.message}`);
    return { ...result, exitCode: CHANT_EXIT.declined };
  }
  if (decision.status === "refused") {
    log(`Nothing in wave ${k} (${wave.name}) or after it ran: the policy denied ${decision.refused?.runs.join(", ")}, and no override counts for ${decision.refused?.runs.length === 1 ? "it" : "them"}.`);
    return { ...result, exitCode: CHANT_EXIT.denied };
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
  return { ...ctx.result, decision, exitCode: CHANT_EXIT.waiting };
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
  return decision.refused?.reason === "point" ? CHANT_EXIT.declined : CHANT_EXIT.denied;
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
  if (decision.quorum?.length) return settleQuorumGate(options, ctx, decision, decision.quorum);
  const { spec, k, wave, cwd } = ctx;
  const { gate, digest, approval, base, policy, members } = decision;
  const { ledger, port } = await gatePort(options, cwd, gate, approval, base);
  const now = options.now ?? new Date().toISOString();
  // #3784: under the spend rule at base, an approval a wave already applied under counts for nothing.
  const spent: AppliedGateRecord[] | undefined = decision.spend === "base" ? ((await ledger.readApplied?.(spec.name)) ?? []).filter((a) => a.gate === gate) : undefined;
  const held = decision.heldBy?.length ? `, held by ${decision.heldBy.join(", ")}` : "";
  // Under the pull request's approval the pending fact waits for the coverage check: a wave the
  // pull request's approval covers applies with no pending line at its own gate (#4588).
  let deferred: PendingGateInput | undefined;
  const deciding: typeof port = approval !== "pull-request" ? port : {
    ...port,
    async appendPending(input) {
      deferred = input;
      return { record: { version: 1, kind: "pending", ...input } as PendingGateRecord, pushed: false };
    },
  };
  const check = await decideWaveGate(deciding, {
    op: spec.name,
    gate,
    digest,
    description: (typeof decision.pending?.description === "string" ? decision.pending.description : undefined) ?? `wave ${k} (${wave.name}): ${members.length} run${members.length === 1 ? "" : "s"}, gate ${policy}, approval ${approval}${held}`,
    now,
    ...(spent ? { spent } : {}),
    // #3861: the approval mode the wave asked under, for readers deciding which approvals count.
    fields: { ...decision.pending, ...(decision.changeSet ? { changeSet: decision.changeSet } : {}), approvalMode: approval },
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
  if (approval === "pull-request") {
    const covered = await approveByPullRequest(options, ctx, decision, ledger);
    decision.coveredBy = covered.digest ? { digest: covered.digest } : { reason: covered.reason };
    if (covered.digest) {
      for (const key of ["pendingFact", "recorded", "waitingSince", "mismatch"] as const) delete decision[key];
      decision.status = "approved";
      decision.via = "pull-request";
      decision.approvedBy = covered.approvedBy;
      decision.approvedAt = covered.approvedAt;
      ctx.log(`wave ${k} (${wave.name}) applies under the pull request's approval of ${covered.digest} at ${decision.pullRequestGate}, which covers its plans`);
      return;
    }
    if (deferred) {
      const written = await port.appendPending(deferred);
      decision.pendingFact = written.record;
      decision.waitingSince = written.record.timestamp;
    }
    ctx.log(`wave ${k} (${wave.name}): the pull request's approval does not cover it (${covered.reason}), so it waits at its own gate ${gate}`);
    decision.status = "waiting";
    decision.approve = approveCommand(spec.name, gate, undefined, digest);
    return;
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
 * Under `approval: "pull-request"` (#4550, ruling B): find an approval of the
 * pull request's gate, under the spec's op, whose change set covers every
 * member of this wave's plans (`planCoveredBy`, as a resume checks a wave
 * against the pull request's approval). The newest such approval wins. A
 * spent one counts for nothing under the spend rule. Needs the plans file's
 * change set; without one the wave waits at its own gate.
 */
async function approveByPullRequest(
  options: RunOpWaveOptions,
  ctx: WaveContext,
  decision: OpWaveDecision,
  ledger: GateLedgerPort,
): Promise<{ digest?: string; approvedBy?: string; approvedAt?: string; reason: string }> {
  const prGate = decision.pullRequestGate;
  if (!prGate) return { reason: "the spec at base names no approvals.pullRequest.gate" };
  const fresh = ctx.changeSetDoc;
  if (!fresh) return { reason: "the plans file carries no change set to check the approval against" };
  const { planCoveredBy } = await import("../components/pr-run");
  const read = options.changeSets ?? (async (d: string) => {
    const { readStoredChangeSet } = await import("../lifecycle/change-set-store");
    const got = await readStoredChangeSet(d, { cwd: ctx.cwd });
    return got.status === "found" ? got.document : undefined;
  });
  const { resolutions } = await ledger.read(ctx.spec.name);
  const spent = decision.spend === "base" ? ((await ledger.readApplied?.(ctx.spec.name)) ?? []).filter((a) => a.gate === prGate) : [];
  const approvals = resolutions.filter((r) => r.gate === prGate && (r.changeSet ?? r.planDigest)).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  if (approvals.length === 0) return { reason: `no approval stands at ${prGate}` };
  let reason = `no approval at ${prGate} covers it`;
  for (const r of approvals) {
    const digest = (r.changeSet ?? r.planDigest)!;
    if (spent.some((a) => a.planDigest === digest && a.approvedAt === r.timestamp)) {
      reason = `the approval of ${digest} at ${prGate} is spent`;
      continue;
    }
    const approved = await read(digest).catch(() => undefined);
    if (!approved) {
      reason = `the change set ${digest} the approval names is not stored`;
      continue;
    }
    const why = fresh.members.map((m) => planCoveredBy(approved, fresh, m.member)).find((w) => w !== undefined);
    if (why === undefined) return { digest, approvedBy: r.resolvedBy, approvedAt: r.timestamp, reason: "" };
    reason = why;
  }
  return { reason };
}

/** The commits after `base` up to `head`, merge commits left out, for the `Requested-by:` trailers on them (#4333). */
const gitCommitsBetween = (cwd: string) => (base: string, head: string): { sha: string; message: string }[] => {
  try {
    const out = execFileSync("git", ["log", "--no-merges", "--format=%H%x00%B%x01", `${base}..${head}`], { cwd, encoding: "utf-8" });
    return out.split("\x01").map((c) => c.replace(/^\n/, "")).filter((c) => c.includes("\x00")).map((c) => ({ sha: c.slice(0, c.indexOf("\x00")), message: c.slice(c.indexOf("\x00") + 1) }));
  } catch {
    return [];
  }
};

/**
 * Decide a gate under approval rules (#4290): the rules at base the wave's
 * targets take, each met by distinct human approvers of the digest. Roles
 * come from `.chant/trust.json` at base, for an approver a seal proves, or
 * under `pr-review` the merged pull request's review read from the forge in
 * this run. That review is written to the ledger once per approving
 * reviewer, so each counts on their own. `notAuthor` reads the author from
 * the same pull request; with none, no approver can show they are someone
 * else and the rule waits.
 */
async function settleQuorumGate(options: RunOpWaveOptions, ctx: WaveContext, decision: OpWaveDecision, rules: GateQuorumRule[]): Promise<void> {
  const { spec, k, wave, cwd, log } = ctx;
  const { gate, digest, approval, base, policy, members } = decision;
  const { ledger, port } = await gatePort(options, cwd, gate, approval, base);
  const now = options.now ?? new Date().toISOString();
  const spent: AppliedGateRecord[] | undefined = decision.spend === "base" ? ((await ledger.readApplied?.(spec.name)) ?? []).filter((a) => a.gate === gate) : undefined;
  const review = await import("./gate-review");
  const trust = (options.trust ?? ((b) => review.trustPolicyAt(cwd, b)))(base);
  const label = `wave ${k} (${wave.name})`;

  // The merged pull request: its author for notAuthor, and its review under pr-review.
  let merged: MergedReview | null = null;
  let unknown: string | undefined;
  const asks = approval === "pr-review" || rules.some((r) => r.notAuthor) || decision.involved !== undefined;
  const head = asks ? (options.head ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim()) : "";
  if (asks) {
    try {
      merged = await (options.reviews ?? review.reviewSourceFromEnv()).mergedReview(head);
      if (!merged) unknown = `no merged pull request produced ${head.slice(0, 12)}`;
    } catch (err) {
      unknown = `the forge's review could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (unknown && rules.some((r) => r.notAuthor)) log(`${label}: ${unknown}, so the change's author is not known`);
  if (approval === "pr-review" && unknown) decision.review = { reason: unknown };

  let reviewed: { head: string; approvers: string[] } | undefined;
  if (approval === "pr-review" && merged) {
    const plans = merged.approvers.length === 0 ? null : await (options.headPlans ?? ((name, h) => readHeadPlans(name, h, cwd)))(spec.name, merged.head);
    const { reviewApproval } = await import("../gate-decision");
    const outcome = reviewApproval(merged, plans?.waves.find((w) => w.wave === k)?.digest, digest);
    decision.review = outcome.review;
    const reviewSpent = spent !== undefined && isApprovalSpent(spent, { gate, planDigest: digest, review: { head: merged.head } });
    if (reviewSpent) decision.review = { ...outcome.review, reason: `a wave already applied ${digest} under the review of #${merged.pr} at ${merged.head.slice(0, 12)}, so the review is spent` };
    if (outcome.approved && !reviewSpent) {
      reviewed = { head: merged.head, approvers: merged.approvers };
      // Each approving reviewer once, so the rules count them one by one.
      const had = (await ledger.read(spec.name)).resolutions.filter((r) => r.gate === gate && r.review?.head === merged!.head && samePlanDigest(r.planDigest, digest));
      const note = `approved by the review of #${merged.pr} at ${merged.head.slice(0, 12)}: ${merged.approvers.join(", ")}`;
      for (const who of merged.approvers) {
        if (had.some((r) => samePrincipal(r.resolvedBy, who))) continue;
        await ledger.appendResolution?.({
          op: spec.name,
          gate,
          resolvedBy: who,
          timestamp: now,
          planDigest: digest,
          approver: { kind: "human" },
          gitSha: head,
          ...(ciRunIdFromEnv() ? { runId: ciRunIdFromEnv()! } : {}),
          note,
          ...(merged.url ? { url: merged.url } : {}),
          review: { pr: merged.pr, head: merged.head, approvers: merged.approvers },
        });
      }
    }
  }

  // #4333: reviews a product recorded itself, on the ledger the spec at base names. The ledger is
  // the lifecycle branch's, never the change's, and proves a reviewer only under `pr-review`.
  const principal = review.forgePrincipalFromEnv();
  let recorded: { head: string; approvers: string[] }[] = [];
  if (decision.reviewLedger && approval === "pr-review") {
    const lines = (await ledger.read(decision.reviewLedger)).resolutions.filter((r) => r.gate === gate && samePlanDigest(r.planDigest, digest));
    const read = recordedReviewApprovals(lines, principal);
    recorded = read.reviews.filter((x) => !(spent !== undefined && isApprovalSpent(spent, { gate, planDigest: digest, review: { head: x.head } })));
    const had = (await ledger.read(spec.name)).resolutions.filter((r) => r.gate === gate && samePlanDigest(r.planDigest, digest));
    for (const rec of read.records) {
      if (!rec.review || !recorded.some((x) => x.head === rec.review!.head) || had.some((r) => r.review?.head === rec.review!.head && samePrincipal(r.resolvedBy, rec.resolvedBy))) continue;
      await ledger.appendResolution?.({
        ...rec,
        op: spec.name,
        gate,
        timestamp: now,
        planDigest: digest,
        note: `approved by a review ${decision.reviewLedger} recorded for ${rec.review.head.slice(0, 12)}: ${rec.review.approvers.join(", ")}`,
      });
    }
    if (recorded.length > 0) log(`${label}: ${decision.reviewLedger} recorded a review of ${digest} by ${[...new Set(recorded.flatMap((x) => x.approvers))].join(", ")}`);
  }

  // #4333: everyone involved in the change, from the commits after base and the agents' accounts at base.
  const involved = decision.involved || merged ? changeInvolvement({
    ...(merged ? { author: merged.author } : {}),
    commits: decision.involved ? (options.commits ?? gitCommitsBetween(cwd))(base, head) : [],
    ...(decision.involved?.agents ? { agents: decision.involved.agents.map(principal) } : {}),
    principal,
  }) : [];
  const said = new Set<string>();
  const sayExcluded = (j: QuorumJudgement): QuorumJudgement => {
    if (j.excluded !== undefined && !said.has(j.excluded)) {
      said.add(j.excluded);
      log(`${label}: ${j.excluded}`);
    }
    return j;
  };
  const judgeBase = trustQuorumJudge({
    signers: trust,
    roles: trust.roles,
    ...(merged ? { authors: [merged.author] } : {}),
    ...(involved.length > 0 ? { involved } : {}),
    ...(decision.involved?.exclude ? { excludeInvolved: true } : {}),
    ...(reviewed ? { review: reviewed } : {}),
    ...(recorded.length > 0 ? { recorded } : {}),
  });
  const judge: GateQuorumJudge = (r) => sayExcluded(judgeBase(r));
  const held = decision.heldBy?.length ? `, held by ${decision.heldBy.join(", ")}` : "";
  const check = await decideWaveGate(port, {
    op: spec.name,
    gate,
    digest,
    description: (typeof decision.pending?.description === "string" ? decision.pending.description : undefined) ?? `wave ${k} (${wave.name}): ${members.length} run${members.length === 1 ? "" : "s"}, gate ${policy}, approval ${approval}${held}`,
    now,
    ...(spent ? { spent } : {}),
    fields: { ...decision.pending, ...(decision.changeSet ? { changeSet: decision.changeSet } : {}), approvalMode: approval },
    ...(decision.neverOverMcp ? { neverOverMcp: true } : {}),
    approval: { quorum: rules, mode: "log-only" },
    judge,
  });
  if (check.satisfied) {
    const by = (check.approvals ?? [check.resolution]).map((r) => r.resolvedBy);
    decision.status = "approved";
    decision.via = reviewed && check.resolution.review?.head === reviewed.head ? "pr-review" : "ledger";
    decision.approvedBy = by.join(", ");
    decision.approvedAt = check.resolution.timestamp;
    log(`${label}: the approval rules at ${base.slice(0, 12)} are met by ${by.join(", ")}`);
    return;
  }
  logRefused(log, label, check);
  decision.pendingFact = check.pending;
  decision.recorded = check.recorded;
  decision.waitingSince = check.pending.timestamp;
  if (check.mismatch) decision.mismatch = check.mismatch;
  if (check.quorum?.rules) {
    decision.quorumProgress = check.quorum.rules;
    for (const p of check.quorum.rules) log(`${label}: approval rule ${quorumRuleLine(p)}`);
    log(`${label}: the approval rules at ${base.slice(0, 12)} are not met (${quorumWaiting(check.quorum.rules)}), so it waits for more approvals of ${digest}`);
  }
  decision.status = "waiting";
  decision.approve = approveCommand(spec.name, gate, undefined, digest, approval === "sealed" || rules.some(ruleNeedsProof));
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
    fields: { ...decision.pending, ...(decision.changeSet ? { changeSet: decision.changeSet } : {}), approvalMode: decision.approval },
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
    result.exitCode = CHANT_EXIT.waiting;
    return false;
  }
  log(`wave ${k} (${wave.name}) is held by ${holds.join(", ")}, and ${decision.approvedBy} approved its digest`);
  return true;
}

/** How one apply call came out. `applied` with a `problem`: the runs applied, and the wave still fails. `applied-nothing`: the apply said why (#3821). */
type ApplyCall =
  | { outcome: "applied"; problem?: string }
  | { outcome: "failed"; applied?: string[] }
  | { outcome: "waiting" }
  | { outcome: "applied-nothing"; said: OpWaveApplyOutcome };

/**
 * The runs a failed `applyWave` call says it applied (#4291 on op waves):
 * `{ "applied": [<target>...] }` at `CHANT_APPLY_RUNS_RESULT`. Absent or
 * unreadable, none did, as before.
 */
function readAppliedRuns(path: string, label: string, log: (line: string) => void): string[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const got = JSON.parse(readFileSync(path, "utf-8")) as { applied?: unknown };
    if (Array.isArray(got?.applied) && got.applied.every((t) => typeof t === "string")) return got.applied as string[];
  } catch {
    // Read as absent below.
  }
  log(`${label}: CHANT_APPLY_RUNS_RESULT is not { "applied": [<target>...] }, so no run counts as applied`);
  return undefined;
}

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
  call: { label: string; key: string; runsPath: string; wave?: boolean },
  recordPath?: string,
): Promise<ApplyCall> {
  const { spec, k, wave, cwd, exec, log, result } = ctx;
  const byApply = decision.applyHooksRunBy === "apply";
  const dir = `.chant/op-waves/${spec.name}/wave-${k}`;
  const filePath = `${dir}/${call.key}.json`;
  const resultPath = `${dir}/${call.key}-result.json`;
  const outcomePath = `${dir}/${call.key}-outcome.json`;
  const appliedRunsPath = `${dir}/${call.key}-runs-result.json`;
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
      runs: hookRuns(ctx, runs, planned),
      runsFile: call.runsPath,
      hooks: handed,
      outcomes: [...result.hooks],
      ...(byApply ? { result: resultPath } : {}),
    };
    mkdirSync(join(cwd, dir), { recursive: true });
    writeFileSync(join(cwd, filePath), JSON.stringify(file, null, 2) + "\n");
    rmSync(join(cwd, resultPath), { force: true });
    rmSync(join(cwd, outcomePath), { force: true });
    if (call.wave) rmSync(join(cwd, appliedRunsPath), { force: true });
    let code: number;
    try {
      const env = { CHANT_HOOKS: filePath, CHANT_APPLY_OUTCOME: outcomePath, ...(call.wave ? { CHANT_APPLY_RUNS_RESULT: appliedRunsPath } : {}), ...(byApply ? { CHANT_HOOKS_RESULT: resultPath } : {}) };
      // #4588: an applyWave its caller runs in process.
      code = call.wave && options.waveExec ? await options.waveExec(argv, cwd, env) : exec(argv, cwd, env);
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
    // #4291: a failed applyWave that says which runs applied fails only the others.
    const failedCall = (): ApplyCall => {
      const applied = call.wave ? readAppliedRuns(join(cwd, appliedRunsPath), call.label, log) : undefined;
      return { outcome: "failed", ...(applied?.length ? { applied } : {}) };
    };
    if (!byApply) return code === 0 ? { outcome: "applied" } : failedCall();
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
    if (code !== 0) return failedCall();
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
      result.exitCode = CHANT_EXIT.waiting;
      return;
    }
    holds.push(...before.holds);
  }
  if (!(await settleHolds(options, ctx, decision, holds, recordPath))) return;
  // #4552: on the resource grain the wave holds the rows its runs change, before its approval is spent.
  const lease = spec.step ? await leaseWaveRows(options, ctx, runs) : undefined;
  if (lease && "failed" in lease) {
    failed(ctx, lease.failed);
    return;
  }
  if (lease && "outcome" in lease) {
    log(`wave ${k} (${wave.name}): applied nothing: ${lease.reason}`);
    result.outcome = lease;
    result.exitCode = CHANT_EXIT.held;
    if (recordPath) writeRecord(recordPath, decision, result);
    return;
  }
  try {
    // #4581: under the lease the grain took, a newer commit that applies the same targets makes this apply stand down.
    if (await standDownForNewer(options, ctx, decision, runs, recordPath)) return;
    await applyLeased(options, ctx, decision, runs, planned, byApply, recordPath);
  } finally {
    if (lease && !(await lease.release())) log(`wave ${k} (${wave.name}): could not let go of the rows it held; the next apply takes them over once this run is gone`);
  }
}

/**
 * Stand down for a newer commit (#4581), when the spec's `standDown` (or
 * the job's option) asks: a newer commit on the branch whose spec at the
 * tip applies every one of `runs` in this wave makes the wave apply
 * nothing, with the `stood-down` outcome and exit 6. The approval is left
 * unspent. True when it stood down.
 */
async function standDownForNewer(options: RunOpWaveOptions, ctx: WaveContext, decision: OpWaveDecision, runs: readonly OpWaveRun[], recordPath?: string): Promise<boolean> {
  const { spec, k, wave, cwd, log, result } = ctx;
  if (!(options.standDown ?? spec.standDown === true)) return false;
  const newer = await (options.newerCommit ?? gitOpWaveNewerCommit)(cwd, options.head);
  if (!newer) return false;
  const targets = runs.map((r) => r.target);
  let atTip: OpWavesSpec | null;
  try {
    const { text } = (options.show ?? gitShowAtBase)(newer.tip, options.specFile.replace(/^\.\//, "").split("\\").join(posix.sep), cwd);
    atTip = text === null ? null : parseOpWavesSpec(text, `${options.specFile} at ${newer.tip.slice(0, 12)}`);
  } catch (err) {
    log(`wave ${k} (${wave.name}): ${newer.branch} has a newer commit ${newer.tip.slice(0, 12)}, and its spec cannot be read (${err instanceof Error ? err.message : String(err)}), so this job applies`);
    return false;
  }
  if (!tipAppliesTargets(atTip, newer.branch, wave.name, targets)) {
    log(`wave ${k} (${wave.name}): ${newer.branch} has a newer commit ${newer.tip.slice(0, 12)}, and its wave does not apply every target of this job, so this job applies`);
    return false;
  }
  const reason = opWaveStandDownReason(newer, targets);
  log(`wave ${k} (${wave.name}): standing down, nothing applied: ${reason}`);
  result.outcome = { outcome: "stood-down", reason };
  result.supersededBy = { branch: newer.branch, commit: newer.tip };
  result.exitCode = CHANT_EXIT.superseded;
  if (recordPath) writeRecord(recordPath, decision, result);
  return true;
}

/** {@link applyStage} once its holds are settled and, on the resource grain, its rows held. */
async function applyLeased(
  options: RunOpWaveOptions,
  ctx: WaveContext,
  decision: OpWaveDecision,
  runs: readonly OpWaveRun[],
  planned: ReadonlyMap<string, OpWaveMember>,
  byApply: boolean,
  recordPath?: string,
): Promise<void> {
  const { spec, k, wave, log, result } = ctx;
  if (!(await spendApproval(options, ctx, decision))) return;
  if (!(await spendOverrides(ctx, decision))) return;
  if (recordPath && (decision.spentAt || decision.overridesSpentAt)) writeRecord(recordPath, decision, result);
  const problems: string[] = [];
  let waiting = false;
  let nothing: OpWaveApplyOutcome | undefined;
  if (spec.applyWave) {
    const runsPath = writeRunsFile(ctx, runs, planned, decision.digest);
    const argv = opWaveArgv(spec.applyWave, { op: spec.op, wave: wave.name, runs: runsPath, plans: opWavePlansPath(spec, k) });
    // #4555: one call applies every run, so each run's step spans that call.
    const startedMs = runs.map((r) => targetStarted(options, k, r.target))[0] ?? Date.now();
    const got = await callApply(options, ctx, decision, runs, planned, argv, { label: `wave ${k} (${wave.name})`, key: "hooks", runsPath, wave: true }, recordPath);
    const said = new Set(got.outcome === "failed" ? (got.applied ?? []) : []);
    const settle = (target: string): "ok" | "failed" | "skipped" => (got.outcome === "applied" || said.has(target) ? "ok" : got.outcome === "failed" ? "failed" : "skipped");
    for (const r of runs) targetSettled(options, result, k, r.target, startedMs, settle(r.target));
    if (got.outcome === "applied-nothing") nothing = got.said;
    else if (got.outcome === "applied") {
      result.applied.push(...runs.map((r) => r.target));
      if (got.problem) problems.push(got.problem);
    } else if (got.outcome === "waiting") waiting = true;
    else if (said.size > 0) {
      // #4291: the apply said which runs applied, so a failure blocks only what depends on the others.
      const applied = runs.filter((r) => said.has(r.target)).map((r) => r.target);
      const failedRuns = runs.filter((r) => !said.has(r.target)).map((r) => r.target);
      log(`wave ${k} (${wave.name}): apply failed for ${failedRuns.join(", ")}; ${applied.join(", ")} applied`);
      result.applied.push(...applied);
      result.failed.push(...failedRuns);
    } else {
      log(`wave ${k} (${wave.name}): apply failed, so none of ${runs.map((r) => r.target).join(", ")} counts as applied`);
      result.failed.push(...runs.map((r) => r.target));
    }
  } else if (spec.step && (wave.parallelism ?? spec.parallelism ?? 1) > 1) {
    // #4625: the step's runs apply several at once.
    await applyStepRunsAtOnce(options, ctx, runs, wave.parallelism ?? spec.parallelism!);
  } else {
    const order = new Map(runs.map((r, i) => [r.target, i]));
    for (const [i, run] of runs.entries()) {
      // #4322: a run listed before this one that failed, or was blocked, blocks it.
      const dep = (run.dependsOn ?? []).filter((d) => (order.get(d) ?? Infinity) < i && (result.failed.includes(d) || result.blocked?.[d] !== undefined)).sort()[0];
      if (dep !== undefined) {
        const by = result.blocked?.[dep] ?? dep;
        result.blocked = { ...result.blocked, [run.target]: by };
        log(`${run.target}: blocked by ${by}, so not applied`);
        continue;
      }
      if (spec.step) {
        // #4545: the run applies through its step, with the plan the gate decided.
        const plan = ctx.steps?.get(run.target);
        if (!plan) {
          log(`${run.target}: this job holds no plan of it to apply`);
          result.failed.push(run.target);
          continue;
        }
        const registry = await opWaveRegistry(options, ctx.cwd, options.capabilities);
        const startedMs = targetStarted(options, k, run.target);
        const got = await applyOpWaveStep({ spec, wave, registry }, run, plan);
        targetSettled(options, result, k, run.target, startedMs, got.outcome === "applied" ? "ok" : got.outcome === "moved" ? "skipped" : "failed", {
          ...(got.outcome !== "applied" ? { error: got.reason } : {}),
          ...(got.facts ? { facts: got.facts } : {}),
        });
        if (got.outcome === "applied") result.applied.push(run.target);
        else if (got.outcome === "moved") {
          log(`${run.target}: its plan moved since wave ${k} was decided, so it was not applied: ${got.reason}`);
          result.moved.push(run.target);
        } else {
          log(`${run.target}: apply failed: ${got.reason}`);
          result.failed.push(run.target);
        }
        continue;
      }
      const key = run.target.replace(/[^A-Za-z0-9._-]/g, "_");
      // Under runBy "apply" each run's apply runs its own apply-stage hooks, over a runs file of that run alone.
      const runsPath = byApply ? writeRunsFile(ctx, [run], planned, decision.digest, `.chant/op-waves/${spec.name}/wave-${k}/${key}.runs.json`) : opWaveRunsPath(spec, k);
      const argv = opWaveArgv(spec.apply ?? OP_WAVE_DEFAULT_APPLY, { op: run.op ?? spec.op, target: run.target, wave: wave.name, plan: opWavePlanPath(spec, k, run.target) });
      const startedMs = targetStarted(options, k, run.target);
      const got = await callApply(options, ctx, decision, [run], planned, argv, { label: run.target, key: `${key}.hooks`, runsPath }, recordPath);
      targetSettled(options, result, k, run.target, startedMs, got.outcome === "applied" ? "ok" : got.outcome === "failed" ? "failed" : "skipped");
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
  if (spec.step) await recordStepReleases(options, ctx, decision, runs);
  if (recordPath && byApply) writeRecord(recordPath, decision, result);
  if (nothing) {
    // #3821: no run counts as failed; the wave stops here, or plans again.
    if (nothing.outcome === "replan") {
      result.replan = { ...(nothing.reason ? { reason: nothing.reason } : {}) };
      return;
    }
    result.outcome = nothing;
    result.exitCode = nothing.outcome === "stood-down" ? CHANT_EXIT.superseded : CHANT_EXIT.held;
    if (recordPath) writeRecord(recordPath, decision, result);
    return;
  }
  if (waiting) {
    result.exitCode = decision.status === "refused" ? refusedExit(decision) : CHANT_EXIT.waiting;
    return;
  }
  if (result.failed.length > 0) {
    result.exitCode = 1;
    return;
  }
  // #4545: a run its step refused as moved applied nothing, so the wave exits moved and its after-apply hooks do not run.
  if (spec.step && result.moved.length > 0) {
    result.exitCode = CHANT_EXIT.moved;
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
 * A wave's step runs applied at most `limit` at once (#4625). A run waits
 * for each run the wave lists before it that it depends on, and is blocked,
 * as one at a time, when that one failed or was blocked. The outcomes land
 * in the result in the wave's order.
 */
async function applyStepRunsAtOnce(options: RunOpWaveOptions, ctx: WaveContext, runs: readonly OpWaveRun[], limit: number): Promise<void> {
  const { spec, k, wave, log, result } = ctx;
  type Outcome = { applied: true } | { failed: true } | { moved: true } | { blockedBy: string };
  const order = new Map(runs.map((r, i) => [r.target, i]));
  const registry = await opWaveRegistry(options, ctx.cwd, options.capabilities);
  const settled = new Map<string, Promise<Outcome>>();
  const outcomes = await mapLimited(runs, limit, (run, i) => {
    const going = (async (): Promise<Outcome> => {
      const earlier = (run.dependsOn ?? []).filter((d) => (order.get(d) ?? Infinity) < i).sort();
      for (const dep of earlier) {
        const got = await settled.get(dep)!;
        if ("failed" in got || "blockedBy" in got) {
          const by = "blockedBy" in got ? got.blockedBy : dep;
          log(`${run.target}: blocked by ${by}, so not applied`);
          return { blockedBy: by };
        }
      }
      const plan = ctx.steps?.get(run.target);
      if (!plan) {
        log(`${run.target}: this job holds no plan of it to apply`);
        return { failed: true };
      }
      const startedMs = targetStarted(options, k, run.target);
      const got = await applyOpWaveStep({ spec, wave, registry }, run, plan);
      targetSettled(options, result, k, run.target, startedMs, got.outcome === "applied" ? "ok" : got.outcome === "moved" ? "skipped" : "failed", {
        ...(got.outcome !== "applied" ? { error: got.reason } : {}),
        ...(got.facts ? { facts: got.facts } : {}),
      });
      if (got.outcome === "applied") return { applied: true };
      if (got.outcome === "moved") {
        log(`${run.target}: its plan moved since wave ${k} was decided, so it was not applied: ${got.reason}`);
        return { moved: true };
      }
      log(`${run.target}: apply failed: ${got.reason}`);
      return { failed: true };
    })();
    settled.set(run.target, going);
    return going;
  });
  for (const [i, got] of outcomes.entries()) {
    const target = runs[i]!.target;
    if ("applied" in got) result.applied.push(target);
    else if ("moved" in got) result.moved.push(target);
    else if ("failed" in got) result.failed.push(target);
    else result.blocked = { ...result.blocked, [target]: got.blockedBy };
  }
}

/**
 * The release records of the runs this wave applied through its step
 * (#4615), one per run, on the environment ledger each names. A record that
 * is not written is a line in the log; the job's exit code stays.
 */
async function recordStepReleases(options: RunOpWaveOptions, ctx: WaveContext, decision: OpWaveDecision, runs: readonly OpWaveRun[]): Promise<void> {
  const { spec, k, wave, log, result } = ctx;
  if (options.releases === false) return;
  const port = options.releases ?? (options.gates ? undefined : gitOpWaveReleasePort({ cwd: ctx.cwd }));
  if (!port) return;
  const applied = new Set(result.applied);
  let gitSha = options.head;
  const requests: OpWaveReleaseRequest[] = [];
  for (const run of runs) {
    if (!applied.has(run.target)) continue;
    const names = opWaveReleaseNames(spec, wave, run);
    const plan = ctx.steps?.get(run.target);
    if (!names || !plan) continue;
    if (gitSha === undefined) {
      try {
        gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        gitSha = "";
      }
    }
    requests.push({ ...names, target: run.target, planDigest: plan.planDigest, ...(gitSha ? { gitSha } : {}), ...(decision.approvedBy ? { approver: decision.approvedBy } : {}) });
  }
  if (requests.length === 0) return;
  let outcomes: OpWaveReleaseOutcome[];
  try {
    outcomes = await port.record(requests);
  } catch (err) {
    log(`wave ${k} (${wave.name}): applied, and no release record was written: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const [i, req] of requests.entries()) {
    const got = outcomes[i];
    if (got?.recorded) log(`${req.target}: recorded on the "${got.env}" release ledger as ${got.component} ${got.digest}${got.releaseDigest ? ` under release ${got.releaseDigest}` : ""}`);
    else log(`${req.target}: applied, and no release record was written for ${req.component} in "${req.env}": ${got?.reason ?? "the port gave no answer"}`);
  }
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
  /** The capabilities a spec's `step` plans through (#4545). Default: the project's at `cwd`. */
  capabilities?: CapabilityRegistry;
  /** How a cost hold's estimator runs (#4545). */
  holdExec?: GatePolicyExec;
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
    const steps = new Map<string, OpWaveStepPlan>();
    const { members, extras: planExtras, waves: found } = await planWaveRuns({ spec, k, wave, cwd, exec, options, steps }, wave.runs, wave.discover === true);
    // #4545: a cost hold's member is in the digest the merged wave decides, so the head's digest carries it too.
    const cost = spec.holds?.cost ? costVerdictOf(spec.holds.cost, spec, k, members, steps, cwd, options.holdExec).member : undefined;
    const extras = cost ? [...(planExtras ?? []), cost] : planExtras;
    // #4630: the facts a gate policy reads, so the approval status before merge says which waves will wait.
    plans.waves.push({
      wave: k,
      name: wave.name,
      digest: opWaveSetDigest(spec, members, extras),
      changes: !members.every((m) => m.empty === true),
      destructive: members.some((m) => m.destructive === true),
    });
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
