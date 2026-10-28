/**
 * Gated waves of Op runs (#3679): a pipeline that applies one Op per
 * environment, or per target in a set, in order, each wave behind one gate.
 *
 * A product built on chant that applies a migration to dev, then staging, then
 * prod, or the same change to every tenant database of an environment, used to
 * render that ordering itself, once per forge, and compute each wave's set
 * digest itself. This module holds the forge-neutral part: the spec, the jobs
 * it becomes and the commands they run. Each forge lexicon (github, gitlab,
 * forgejo) renders these jobs with its own transport, so the three cannot
 * disagree about order or commands. `./op-waves-run.ts` is what the jobs run.
 *
 * ## Jobs
 *
 * A wave is one job, `wave-<k>-<name>`, running `chant run wave --spec <file>
 * --wave <k>`: plan every run, decide the wave's gate, apply. A wide wave
 * (`shares` > 1) is a deciding job that plans every run and decides the gate,
 * plus `shares` jobs that each apply a slice of the runs and refuse a run
 * whose plan moved since the decision. Each wave's jobs need the previous
 * wave's last jobs, so a wave that waits (exit 3) stops every later wave.
 *
 * ## A failed run blocks its dependents (#4322)
 *
 * A run's `dependsOn` names the runs it needs applied first. Each job writes
 * an outcome file ({@link OpWaveJob.outcome}, `../wave-blocked.ts`) and the
 * next wave's jobs read every earlier one, so a run that failed blocks only
 * the runs that depend on it, in its own wave and later ones, and the rest
 * apply. The generated pipelines run a wave's jobs after a failure in the
 * wave before; a job exits 1 only for its own failed or blocked runs.
 *
 * ## The gate
 *
 * Wave k waits on `waveGateName(<gate>, k)`, or the spec's `gateName` pattern
 * ({@link opWaveGateName}, #3821), recorded under the spec's name, bound to
 * {@link waveSetDigest} over its runs' plan digests (`../gated-waves.ts`, the
 * same digest a component fan-out's wave binds), or with `digest.over:
 * "changing"` over the runs whose plan changes something. Whether it waits at all
 * is the wave's gate policy, read from the base commit's copy of the spec
 * file, so a change cannot loosen the rule that gates its own merge.
 *
 * So is which approvals count (#3684), the wave's `approval`: `ledger` (any
 * `chant approve` of the digest), `sealed` (only one whose seal verifies
 * against the signers file at base) or `pr-review` (also the merged pull
 * request's review of its head, by a writer other than its author, when the
 * head planned the same digest). See `./gate-review.ts`.
 *
 * ## Spent approvals (#3784)
 *
 * With `approvals: { spend: true }` (read at base, like the policy), a wave
 * records each approval it applies under in `_gates/<name>/applied.jsonl` on
 * `chant/lifecycle`, as terragucci's wave gate does, and that approval is
 * spent: the same digest needs a new approval to apply again.
 *
 * ## Approval rules (#4290)
 *
 * With `approvals: { quorum: [...] }` (read at base), a wave takes each rule
 * whose `targets` glob matches one of its runs' targets and waits until each
 * is met: `count` distinct people, from `roles` when it names them (granted
 * in `.chant/trust.json` at base), one of them not the author with
 * `notAuthor`. See `./gate-quorum.ts`.
 *
 * Two more settings feed those rules, read at base with them (#4333):
 * `approvals.reviewLedger` names the op whose ledger holds the reviews a
 * product records itself under `pr-review` (terragucci's `tf-apply`), and
 * `approvals.involved` names the accounts an agent acts as and, with
 * `exclude`, leaves an approval by anyone involved in the change out of
 * every rule.
 *
 * ## Wave-level commands and hooks (#3762)
 *
 * A product whose tool plans a whole wave in one call (Terragrunt's `run
 * --all`, an apply by rows) gives `planWave` and `applyWave` in place of the
 * per-run `plan` and `apply`: one call plans every run and lists each run's
 * plan, and the wave's digest and gate come from that list as from per-run
 * plans. Stage hooks (`hooks`) run commands before and after the plan and the
 * apply; like the policy they are read from the spec at the base commit, and
 * one whose `onFailure` is `approve` holds the wave for an approval whatever
 * its policy says.
 *
 * ## A gate that asks a decision point (#3836)
 *
 * With `point` (on the spec, or on a wave, whose own wins), read at base like
 * the policy, a wave that needs an approval asks that workspace decision
 * point instead of reading the ledger for a `chant approve`, the way an Op
 * gate with a `point` does (#3170): `gate.planDigest` is the wave's set
 * digest, so each plan is its own question. An open question waits (exit 3,
 * the pending fact cites it), an answer the gate passes on records the
 * resolution that cites it and the wave goes on, and any other answer refuses
 * the wave (exit 8). See `./op-waves-run.ts`.
 */

import type { OpEnvironment, OpSetupStep } from "../lexicon";
import type { CiRunner } from "../ci-jobs";
import type { CloudTradeSpec } from "../ci-identity";
import { gatePointProblems, type GatePoint } from "./gate-point";
import { quorumProblems, type GateQuorumRule } from "./gate-quorum";
import { notifyConfigProblem, type NotifyConfig } from "../notify";
import { WAVE_GATE_NAME_PATTERN, waveGateNameFrom, waveShare } from "../wave-layout";
import { waveOutcomeFileName } from "../wave-blocked";
import { NEXT_RELEASE } from "../release-floors";
import { opWaveHoldsProblems, opWaveStepProblems, type OpWaveHolds, type OpWaveStep } from "./op-waves-capability-spec";
import { opWaveReleaseProblems, type OpWaveReleaseNames } from "./op-waves-release";
import { CONTROL_DISPATCH_JOB, CONTROL_NAME, controlSettingsProblems, resolveControlTarget, type ControlSettingsInput, type ControlTarget } from "../control/dispatch";

export type { OpWaveCostFormat, OpWaveCostHold, OpWaveHolds, OpWaveStep } from "./op-waves-capability-spec";

/**
 * The variables a wave job reads its notify secrets from, for the lexicons
 * that generate wave pipelines. Re-exported here because a lexicon's source
 * in this repository cannot import `@intentius/chant/notify`: under any
 * loader that entry resolves its `import` condition to the compiled
 * `dist/notify.js` (#3803), which only a packed release carries.
 */
export { notifyVariables } from "../notify";

/** When a wave waits for an approval. */
export type OpWaveGatePolicy =
  /** Whenever the wave changes something. */
  | "always"
  /** When a run's plan says it is destructive. */
  | "on-destructive"
  /** Never: only review and branch protection stand in front of the wave. */
  | "never";

export const OP_WAVE_GATE_POLICIES: readonly OpWaveGatePolicy[] = ["always", "on-destructive", "never"];

/** Which approvals of a gate's digest count (#3684). See `./gate-review.ts`. */
export type GateApprovalSource =
  /** Any resolution on `chant/lifecycle` that names the digest. */
  | "ledger"
  /** As `ledger`, and the merged pull request's review of its head, by a writer other than its author. */
  | "pr-review"
  /** Only a resolution sealed by a key the signers file at base lists for its approver. */
  | "sealed"
  /**
   * As `ledger`, and the pull request's approval (#4550, ruling B): an
   * approval of the pull request's gate (`approvals.pullRequest.gate` at
   * base) whose change set covers every run of the wave's plan applies the
   * wave without a second approval. A wave whose plan moved waits at its own
   * gate. plywood's preset.
   */
  | "pull-request";

export const GATE_APPROVAL_SOURCES: readonly GateApprovalSource[] = ["ledger", "pr-review", "sealed", "pull-request"];

/** What a failing hook does: fail the wave, or hold it for an approval of its set digest. */
export type OpWaveHookFailure = "fail" | "approve";

/**
 * The decision point a wave's gate asks (#3836): a point's name, or `{ name,
 * inputs?, pass?, store?, timeout? }` as an Op gate's `point` takes, plus the
 * pending fact's `timeout` (default 48h). The point must declare the input
 * `gate.planDigest`, which is the wave's set digest.
 */
export type OpWavePoint = GatePoint & {
  /** How long the pending fact that cites an open question stands, such as `"48h"`. */
  timeout?: string;
};

/** A wave's or a spec's `point` as an {@link OpWavePoint}, or undefined when it names none. */
export function opWavePointOf(point: string | OpWavePoint | undefined): OpWavePoint | undefined {
  if (point === undefined) return undefined;
  return typeof point === "string" ? { name: point } : point;
}

/** What is wrong with a wave's `point`, empty when nothing is (#3836). */
export function opWavePointProblems(point: unknown): string[] {
  if (point !== null && typeof point === "object" && !Array.isArray(point) && "timeout" in point) {
    const { timeout, ...rest } = point as Record<string, unknown>;
    const problems = gatePointProblems(rest);
    if (typeof timeout !== "string" || !/^(\d+(ms|s|m|h|d))+$/.test(timeout)) problems.push("`point.timeout` is a duration such as \"48h\"");
    return problems;
  }
  return gatePointProblems(point);
}

/** The point wave `name`'s gate asks (#3836): the wave's own, else the spec's, else none. */
export function opWavePointAt(spec: Pick<OpWavesSpec, "point" | "waves">, name: string): OpWavePoint | undefined {
  const wave = spec.waves.find((w) => w.name === name);
  return opWavePointOf(wave?.point ?? spec.point);
}

export const OP_WAVE_HOOK_FAILURES: readonly OpWaveHookFailure[] = ["fail", "approve"];

/** One stage hook (#3762): a command run before or after a wave's plan or apply. */
export interface OpWaveHook {
  /** The hook's name in the log and the result. Default: its command. */
  name?: string;
  /**
   * Argv template. `{op}`, `{wave}` and `{runs}` (the runs file, see
   * `opWaveRunsPath`) are filled in; a `perRun` hook also gets `{target}`
   * and, once the run is planned, `{plan}`, and `{planJson}` when the run's
   * plan names the engine's plan document (`artifact.planJson`, #4614).
   */
  command: string[];
  /** Default `"fail"`. `"approve"` holds the wave for an approval of its set digest whatever its policy says. Not allowed after apply. */
  onFailure?: OpWaveHookFailure;
  /** Run once per run of the wave, rather than once for the wave. */
  perRun?: boolean;
  /**
   * The runs the hook is for (#4288): targets, or patterns where `*` matches
   * within one `/` segment and `**` across segments, as a job group's `runs`.
   * A `perRun` hook runs for the matching runs only. A hook that runs once
   * for the wave runs when any run matches, or when no run is known yet (a
   * `discover` wave before its plan). Absent: every run.
   */
  targets?: string[];
}

/** The stages a hook runs around. */
export type OpWaveHookStage = "observe" | "plan" | "apply" | "gate";

/** When a hook runs. */
export type OpWaveHookMoment = "before-observe" | "before-plan" | "after-plan" | "after-gate" | "before-apply" | "after-apply";

/**
 * Every moment, in the order a wave reaches them. `before-observe` (#4288)
 * runs before anything reads live state: ahead of `before-plan` in every job
 * that plans, the deciding job's and each share's. `after-gate` (#3821) runs
 * once the gate decided, whatever it decided: approved, let through,
 * waiting, or refused by a policy denial.
 */
export const OP_WAVE_HOOK_MOMENTS: readonly OpWaveHookMoment[] = ["before-observe", "before-plan", "after-plan", "after-gate", "before-apply", "after-apply"];

/**
 * The check moment (#4556): `ci.hooks.check`, run in a product's check job,
 * once, or once per target with `perRun`. It comes before any plan, so a
 * hook has no `{plan}` and cannot hold for an approval. It is a `ci.hooks`
 * moment only; an Op waves spec has no check job.
 */
export const CHECK_HOOK_MOMENT = "check";

/** A moment a hook runs at: an Op waves or pull-request moment, or `check` (#4556). */
export type CiHookMoment = OpWaveHookMoment | typeof CHECK_HOOK_MOMENT;

/** The first chant that reads and runs `ci.hooks.check` (#4556). A declaration that uses it sets `minReader` to it. */
export const CI_CHECK_HOOK_FLOOR = NEXT_RELEASE;

/**
 * Who runs the `before.apply` and `after.apply` hooks (#3804). `chant`: the
 * wave job, around the apply command. `apply`: the apply command itself,
 * under its own lock, through `runOpWaveApplyHooks` and the file named by
 * `CHANT_HOOKS`; it writes the outcomes back to `CHANT_HOOKS_RESULT`.
 */
export type OpWaveApplyHooksRunner = "chant" | "apply";

export const OP_WAVE_APPLY_HOOKS_RUNNERS: readonly OpWaveApplyHooksRunner[] = ["chant", "apply"];

/** Stage hooks (#3762), read from the spec at the base commit like the gate policy. */
export interface OpWaveHooks {
  /** `before.observe` (#4288) runs before anything reads live state, ahead of `before.plan`. */
  before?: { observe?: OpWaveHook[]; plan?: OpWaveHook[]; apply?: OpWaveHook[] };
  /** `after.gate` (#3821) runs once the gate decided, whatever it decided, with the decision in its environment. */
  after?: { plan?: OpWaveHook[]; gate?: OpWaveHook[]; apply?: OpWaveHook[] };
  /** Who runs the apply-stage hooks (#3804). Default `{ runBy: "chant" }`. A wave's own setting wins over the spec's. */
  apply?: { runBy?: OpWaveApplyHooksRunner };
}

/** One Op run in a wave: an Op applied to one target (an environment, a database, a tenant). */
export interface OpWaveRun {
  /** What the run applies to. Unique within its wave; it names the run in the set digest. */
  target: string;
  /** The Op to run. Default: the spec's `op`. */
  op?: string;
  /**
   * The runs this one needs applied first (#4322), by target: a run of an
   * earlier wave (the latest earlier wave that has the target), or one listed
   * before it in its own wave. A run that failed, or was blocked, blocks this
   * one, which then is neither planned nor applied; a run with no failed
   * dependency applies whatever else failed. Within its own wave only when
   * one job applies the wave (no `shares`, no `jobs`).
   */
  dependsOn?: string[];
  /**
   * With the spec's `step` (#4545): this run's own input, laid over the
   * step's (its vars, the outputs it reads). Strings have `{target}`, `{op}`
   * and `{wave}` filled, as the step's do.
   */
  input?: Record<string, unknown>;
  /**
   * With the spec's `step` (#4615): the environment and component this run's
   * release record goes under, over the spec's `release`. Strings have
   * `{target}`, `{op}` and `{wave}` filled. See `./op-waves-release.ts`.
   */
  release?: OpWaveReleaseNames;
}

/**
 * Where a wave's jobs run (#3914): a runner label, a list of labels the
 * runner must all carry, or on GitHub a runner group with optional labels.
 * Rendered as `runs-on` on GitHub and Forgejo and as `tags` on GitLab; a
 * runner group on GitLab or Forgejo is a spec error.
 */
export type OpWaveRunner = CiRunner;

/**
 * One job group of a wave (#3914): the runs it applies, and the job that
 * applies them, with its own runner, forge environment, variables, setup and
 * id tokens. The wave's deciding job plans every run and decides the wave's
 * one gate; the group's job plans its own runs again and applies those whose
 * plan has not moved since.
 */
export interface OpWaveJobGroup {
  /** The group's name, in its job's name (`wave-<k>-<wave>-<name>`). Lowercase letters, digits, `-` and `_`. */
  name: string;
  /**
   * The runs it applies: targets, or patterns where `*` matches within one
   * path segment and `**` across segments. Each run of the wave is in exactly
   * one group. On a `discover` wave the deciding job checks this once the
   * runs are found.
   */
  runs: string[];
  /** Split the group's runs across this many jobs, as a wave's `shares` does. Default 1. */
  shares?: number;
  /** The group's runner. Default: the wave's, else the spec's. */
  runner?: OpWaveRunner;
  /** The forge deployment environment of the group's jobs (GitHub and GitLab; a spec error on Forgejo). Default: the wave's. */
  environment?: OpEnvironment;
  /** Variables for the group's jobs, over the wave's own. */
  variables?: Record<string, string>;
  /** Steps the group's jobs run after the wave's setup. */
  setup?: OpSetupStep[];
  /**
   * The OIDC tokens the group's jobs get, as `{ <variable>: <audience> }`, in
   * place of the wave's. GitLab declares them as the job's `id_tokens:`.
   * GitHub and Forgejo give the job `id-token: write` and the audience as
   * `<variable>_AUDIENCE`, since there the audience is chosen when the token
   * is requested.
   */
  idTokens?: Record<string, string>;
  /**
   * The cloud identities the group's jobs trade the job's OIDC token for
   * (#4332), in place of the wave's: a {@link CloudTradeSpec}, as
   * `cloudIdentityWave` in ../ci-identity.ts gives a group its apply
   * identities. The trade runs before the checkout.
   */
  cloud?: CloudTradeSpec;
}

/** One wave: runs that apply together, behind one gate. */
export interface OpWave {
  /** The wave's name, usually its environment. Lowercase letters, digits, `-` and `_`. */
  name: string;
  /** The wave's runs. Empty or absent on a `discover` wave. */
  runs: OpWaveRun[];
  /**
   * The runs come from the product at plan time (#3821): `planWave` gets a
   * runs file with no runs and `discover: true`, and plans the runs it finds
   * for wave k (a Terragrunt repo's dependency layer from `terragrunt find`).
   * Needs `planWave`.
   */
  discover?: boolean;
  /**
   * The last wave only, with `discover` (#3821): once it applies, the job
   * goes on to wave k+1, k+2, ... while `planWave` reports more waves
   * (`waves` in its plans file), each behind its own gate and read at base
   * by this wave's name. For a pipeline whose wave count is not known up
   * front.
   */
  rest?: boolean;
  /**
   * When the wave waits. Default `"always"`. The runner reads this from the
   * spec file at the base commit, never from the change being applied.
   */
  gate?: OpWaveGatePolicy;
  /**
   * Which approvals of the wave's digest count (#3684). Default `"ledger"`.
   * Like `gate`, the runner reads it from the spec file at the base commit.
   */
  approval?: GateApprovalSource;
  /**
   * The decision point this wave's gate asks (#3836), in place of the spec's.
   * Read at base like `gate`. See {@link OpWavesSpec.point}.
   */
  point?: string | OpWavePoint;
  /**
   * Split the wave into a deciding job and this many share jobs, each
   * applying a slice of the runs. Default 1: one job plans, decides and
   * applies.
   */
  shares?: number;
  /** The forge deployment environment the wave's jobs run in (GitHub and GitLab; Forgejo has none). */
  environment?: OpEnvironment;
  /** Variables for this wave's jobs alone. */
  variables?: Record<string, string>;
  /** Steps this wave's jobs run after the checkout, as `ScheduledOpSpec.setup`. */
  setup?: OpSetupStep[];
  /** This wave's stage hooks (#3762), run after the spec's own. Read at the base commit. */
  hooks?: OpWaveHooks;
  /** Where this wave's jobs run (#3914). Default: the spec's `runner`. */
  runner?: OpWaveRunner;
  /**
   * The OIDC tokens this wave's jobs get (#3914), as `{ <variable>: <audience> }`;
   * see {@link OpWaveJobGroup.idTokens}. With `jobs`, these are the deciding
   * job's, and a group's own replace them.
   */
  idTokens?: Record<string, string>;
  /**
   * The cloud identities this wave's jobs trade the job's OIDC token for
   * (#4332), before the checkout: a {@link CloudTradeSpec}. With `jobs`,
   * the deciding job's, and a group's own `cloud` replaces it.
   * `cloudIdentityWave` in ../ci-identity.ts gives the deciding job every
   * plan identity of the wave's targets. Each later step of the job starts
   * without the variables a token is requested with.
   */
  cloud?: CloudTradeSpec;
  /**
   * Split the wave's apply into job groups (#3914): a deciding job, which
   * runs with the wave's own settings, plans every run and decides the gate,
   * and a job per group (per share of a group), each applying its runs. Not
   * with the wave's own `shares` (a group has its own) or `rest`.
   */
  jobs?: OpWaveJobGroup[];
}

/**
 * An ordered list of waves of Op runs, as a pipeline and as the file its jobs
 * read. Commands are argv templates; each `{op}`, `{target}`, `{wave}` and
 * `{plan}` is replaced per run.
 */
export interface OpWavesSpec {
  /** The pipeline's name, and the op the wave gates are recorded under (`chant approve <name> <gate>-wave-<k>`, or the `gateName` pattern). */
  name: string;
  /** The Op a run runs when it names none. */
  op: string;
  /** The base gate name. Default: `name`. */
  gate?: string;
  /**
   * Labels copied onto each job's run record (#4551), as an Op's `labels`
   * are. `Env` names the environment the record goes under,
   * `<Env>/runs__<name>.jsonl`; without it the record goes under `local`, as
   * an Op's does.
   */
  labels?: Record<string, string>;
  /**
   * The name of wave k's gate (#3821): `{gate}` is the base gate name and
   * `{k}` the wave's number. Default `"{gate}-wave-{k}"`. A product moving
   * its own wave gates onto these waves names its old pattern here (such as
   * `"wave-{k}"`), so the approvals already on the ledger keep their gate.
   */
  gateName?: string;
  /** Which runs the set digest covers (#3821). Default: every run. */
  digest?: OpWavesDigest;
  /**
   * The waves' pending facts carry `neverOverMcp` (#3821, chant#3485): their
   * gates are never resolved over MCP or ACP, whichever channel reached
   * them. Read at the base commit too, and either one setting it is enough,
   * so a change cannot drop the rule for its own gates.
   */
  neverOverMcp?: boolean;
  /** Branches whose pushes run the waves. Default `["main"]`. */
  branches?: string[];
  /**
   * An apply stands down when a newer commit on the branch will apply the
   * same targets (#4581): its wave applies nothing, the job exits 6
   * (`superseded`), and its run record says so. Checked once the wave's
   * holds are settled and its lock grain's lease is taken, before the
   * approval is spent. See `./op-waves-stand-down.ts`. Default false.
   */
  standDown?: boolean;
  /**
   * Where every job the spec renders runs unless a wave or a job group names
   * another (#3914). Default: the forge's default runner (`ubuntu-latest` on
   * GitHub, the dialect's label on Forgejo, no `tags` on GitLab).
   */
  runner?: OpWaveRunner;
  /**
   * The commit the gate policy is read from. Default `HEAD^1`, the first
   * parent: on a merge or squash onto the branch, the branch before the change.
   */
  base?: string;
  /**
   * Plan one run and write its plan file to `{plan}`: JSON `{ "planDigest":
   * string, "destructive"?: boolean, "empty"?: boolean }`. `destructive` is
   * what `on-destructive` waits on; a wave whose runs are all `empty` never
   * waits. Give this or `planWave`.
   */
  plan?: string[];
  /** Apply one run whose plan is at `{plan}`. Default `chant run {op} --env {target}`. */
  apply?: string[];
  /**
   * Plan and apply each run through a capability (#4545), in place of
   * `plan` and `apply`: `{ kind, ...input }`, as a component's deploy step,
   * with `{target}`, `{op}` and `{wave}` filled in each string and a run's
   * `input` laid over it. `capability.plan` gives the run's plan digest and
   * change set; `capability.run` applies that plan, and a plan it refuses as
   * moved exits 4. See `./op-waves-capability.ts`.
   */
  step?: OpWaveStep;
  /**
   * Holds the wave runs over its plans (#4545), read at the base commit
   * with the policy: `policy` runs the workspace's `ci.policy` over each
   * run's change set, `cost` prices the runs and holds the wave over a
   * monthly change. See `./op-waves-capability.ts`.
   */
  holds?: OpWaveHolds;
  /**
   * With a `step` (#4615): each run it applied gets a release record on its
   * environment's ledger, so `chant components rollback` reads it. `env`
   * and `component` name the ledger and the component (default `labels.Env`,
   * else the wave's name, and the run's target); a run's own `release` wins.
   * `false` writes none. See `./op-waves-release.ts`.
   */
  release?: OpWaveReleaseNames | false;
  /**
   * Plan every run of a wave in one call (#3762), in place of `plan`. `{runs}`
   * is a file chant writes, `{ "wave", "number", "runs": [{ "target", "op" }] }`;
   * the command writes `{plans}`: `{ "runs": [{ "target", "planDigest",
   * "destructive"?, "empty"? }] }` (or the array alone), one entry per run.
   */
  planWave?: string[];
  /**
   * Apply a wave's approved set in one call (#3762), in place of `apply`.
   * `{runs}` lists the runs to apply with the plan digest each was approved
   * at; `{plans}` is the wave plan's file. A non-zero exit fails every run in
   * the set.
   */
  applyWave?: string[];
  /** Stage hooks for every wave (#3762), run before each wave's own. Read at the base commit. */
  hooks?: OpWaveHooks;
  /** What happens to an approval once a wave applies under it (#3784). Read at the base commit. */
  approvals?: OpWavesApprovals;
  /**
   * Who may override a run the product's policy denied at plan time (#3821).
   * A plan entry with `denied` refuses the wave unless an override on
   * `_gates/policy-override.jsonl` counts for that run, its plan digest and
   * the rules (`@intentius/chant/override-gate`).
   */
  override?: OpWavesOverride;
  /**
   * The decision point every wave's gate asks (#3836), unless a wave names its
   * own. Read at the base commit, like the policy: a wave that needs an
   * approval asks the point with `gate.planDigest` set to its set digest, and
   * only an answer the point's `pass` names (default yes) for that digest
   * lets it apply. `chant approve` does not pass such a gate, and the wave's
   * `approval` mode does not apply: the point's deciders and quorum decide.
   */
  point?: string | OpWavePoint;
  waves: OpWave[];
  /**
   * A scheduled job that starts again a wave job whose approval has arrived
   * (#3683): it runs `chant run resume --op <name>`, which re-runs the
   * GitHub run, retries the GitLab job or dispatches the Forgejo workflow.
   * It approves nothing. Absent, no such job is rendered and an approval is
   * followed by `chant approve --resume` or a re-run by hand.
   */
  resume?: OpWavesResume;
  /**
   * Tell people when a wave waits for an approval, a share job refuses a run
   * whose plan moved, or a wave fails (#3761): the environment variables
   * holding a Slack or Teams incoming webhook's URL, or a generic webhook's
   * URL and the key its `chant.notify/v1` events are signed with. A failed
   * delivery is logged and never changes the job's exit code. See
   * `../notify.ts`.
   */
  notify?: NotifyConfig;
  /**
   * The control repo (#4617, `@intentius/chant/ci-control`): once the last
   * wave ran, a `control-dispatch` job tells the control repo how the waves
   * ended (`applied`, `partial`, `unchanged`, `waiting` or `failed`, from
   * the wave jobs' outcome files), and the control repo records it and runs
   * this member's dependents when something applied. See
   * {@link OpWavesControl}.
   */
  control?: OpWavesControl;
}

/**
 * An Op waves spec's `control` (#4617): the control settings a product
 * reads from its config, in chant's spelling (`ControlSettingsInput`), with
 * `member` named, since a spec has no repository name to default it to.
 * The job maps the `tokenSecret` secret into `CHANT_CONTROL_TOKEN` for its
 * one step, as the pull request loop's `control` does (#4568).
 */
export interface OpWavesControl extends ControlSettingsInput {
  /** The member's name in the control repo's workspace. */
  member: string;
  /** A shell line that prints 1 when the commit was told about already (`controlDispatchScript`'s `sentCheck`). */
  sentCheck?: string;
  /** A shell line run once the control repo took the dispatch (`controlDispatchScript`'s `markSent`). */
  markSent?: string;
}

/** The first chant whose Op waves specs take `control` (#4617). A product feature-detects this name. */
export const OP_WAVES_CONTROL_FLOOR = NEXT_RELEASE;

/** The control dispatch job's name in an Op waves pipeline (#4617). */
export const OP_WAVES_CONTROL_JOB = CONTROL_DISPATCH_JOB;

/** The problems with a spec's `control` (#4617), each naming its key. */
export function opWavesControlProblems(control: unknown): string[] {
  const problems = controlSettingsProblems(control, "control");
  if (problems.length > 0) return problems;
  const c = control as Record<string, unknown>;
  const out: string[] = [];
  if (!(typeof c.member === "string" && CONTROL_NAME.test(c.member))) out.push("control.member must name this repo in the control repo's workspace: an Op waves spec has no repository name to default it to");
  for (const key of ["sentCheck", "markSent"] as const) {
    if (c[key] !== undefined && !(typeof c[key] === "string" && c[key] !== "" && !(c[key] as string).includes("\n"))) out.push(`control.${key} must be one shell line`);
  }
  return out;
}

/** The control target of a spec's `control` (#4617), its defaults filled in. */
export function opWavesControlTarget(control: OpWavesControl): ControlTarget {
  const { sentCheck: _s, markSent: _m, ...settings } = control;
  return resolveControlTarget(settings, control.member);
}

/**
 * The command the control job runs before its dispatch (#4617): reads every
 * wave job's outcome file and prints the outcome word, through the
 * product's bin when it has one.
 */
export function opWavesOutcomeCommand(specFile: string, bin?: string): string[] {
  return [...opWaveBinArgv(bin), "run", "wave", "--spec", specFile, "--waves-outcome"];
}

/** The jobs the control job needs (#4617): the last wave's applying jobs, as a next wave would need them. */
export function opWavesLastJobs(jobs: readonly OpWaveJob[]): string[] {
  const last = jobs.reduce((max, j) => Math.max(max, j.wave), 0);
  return jobs.filter((j) => j.wave === last && j.kind !== "decide").map((j) => j.jobName);
}

/** Which runs a wave's set digest covers (#3821). */
export interface OpWavesDigest {
  /**
   * `all` (the default): every run's plan. `changing`: only the runs whose
   * plan is not `empty`, or every run when all of them are empty. A product
   * whose plan note shows a digest over the plans that change something
   * names `changing`, so the digest the wave asks approval for is the one
   * the note showed.
   */
  over?: "all" | "changing";
}

export const OP_WAVES_DIGEST_OVER = ["all", "changing"] as const;

/** The default gate name pattern. */
export const OP_WAVE_DEFAULT_GATE_NAME = WAVE_GATE_NAME_PATTERN;

/** The gate wave `k` waits on (#3821): the spec's `gateName` pattern, by default `<gate>-wave-<k>`. */
export function opWaveGateName(spec: Pick<OpWavesSpec, "name" | "gate" | "gateName">, k: number): string {
  return waveGateNameFrom(spec.gateName, spec.gate ?? spec.name, k);
}

/** Where a wave reads who may override a policy denial (#3821). */
export interface OpWavesOverride {
  /**
   * The overriders file, read at the base commit. Default
   * `.chant/overriders`. A plans file that names `overriders` (a product
   * that keeps its list in its own config at base) wins over it.
   */
  overriders?: string;
}

/** What happens to an approval once a wave applies under it (#3784). */
export interface OpWavesApprovals {
  /**
   * Spend it. Before a wave applies under an approval it records that in
   * `_gates/<name>/applied.jsonl` on `chant/lifecycle`, and from then on the
   * approval counts for nothing: applying the same digest again, by a re-run
   * or a revert and re-merge, waits for a new approval. Default false: an
   * approval of a digest passes that digest as often as it is planned.
   */
  spend?: boolean;
  /**
   * Approval rules (#4290): a wave takes each rule whose `targets` glob
   * matches one of its runs' targets (a rule with no `targets` covers every
   * wave), and applies once each is met by distinct human approvers of its
   * set digest. Read at the base commit, with the roles from
   * `.chant/trust.json` there, so a change cannot loosen the rules its own
   * wave is judged by. A role, or `notAuthor`, counts only a proven
   * approver: a seal that verifies against the signers at base, or under
   * `pr-review` the merged pull request's review. `notAuthor` reads the
   * author from that pull request. See `./gate-quorum.ts`.
   */
  quorum?: GateQuorumRule[];
  /**
   * The op whose ledger (`_gates/<op>.jsonl` on `chant/lifecycle`) holds the
   * reviews a product records itself (#4333): lines with `via: "pr-review"`,
   * the reviewed `head` and the approving `reviewers` by forge login, as
   * terragucci writes them under `tf-apply`. Each reviewer counts toward
   * `quorum` as one approver of the line's digest, and under `pr-review` is
   * proven, as a review chant reads from the forge is. Read at the base
   * commit, so a change cannot name a ledger its own wave is judged by.
   */
  reviewLedger?: string;
  /** Who else was involved in a change, for `quorum` (#4333). Read at the base commit. */
  involved?: OpWavesInvolved;
  /**
   * The pull request's gate a wave under `approval: "pull-request"` takes
   * its approval from (#4550): `{ "gate": "up" }`, recorded under the spec's
   * op. Read at the base commit, so a change cannot name the gate its own
   * waves are judged by. Needs the plans file's `changeSet`, which the
   * approval's change set must cover.
   */
  pullRequest?: { gate: string };
}

/**
 * Who was involved in a change besides its pull request's author (#4333):
 * each login a `Requested-by:` trailer names on the commits after base, and
 * the accounts listed here. `notAuthor` is met only by a proven approver
 * none of them is.
 */
export interface OpWavesInvolved {
  /** The accounts an agent acts as, as principals (`github:tg-bot`) or logins: a change's author can post a review as the agent with its token. */
  agents?: string[];
  /** An approval by anyone involved counts toward no rule, not only toward `notAuthor`. Default false. */
  exclude?: boolean;
}

/** An op name a ledger file is named by (`_gates/<op>.jsonl`). */
export const OP_LEDGER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Everything wrong with `approvals.involved` (#4333), one line each. */
export function opWavesInvolvedProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["`approvals.involved` must be { \"agents\"?: [...], \"exclude\"?: true | false }"];
  const problems: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === "agents") {
      if (!Array.isArray(v) || v.length === 0 || v.some((a) => typeof a !== "string" || a.trim() === "")) problems.push("`approvals.involved.agents` must be a non-empty list of principals or logins");
    } else if (key === "exclude") {
      if (typeof v !== "boolean") problems.push("`approvals.involved.exclude` must be true or false");
    } else problems.push(`\`approvals.involved.${key}\` is not a setting; use agents or exclude`);
  }
  return problems;
}

/** The scheduled resume job of an Op waves pipeline (#3683). */
export interface OpWavesResume {
  /**
   * Five-field cron, such as `"*\/10 * * * *"`. GitHub and Forgejo put it
   * in the workflow; GitLab runs the job in a pipeline schedule you create,
   * which sets the cron.
   */
  schedule: string;
}

/**
 * The words a generated job runs in place of `chant` (#4607): a product's
 * `words.bin`, such as `npx --no-install plywood`, split on spaces. Absent
 * or blank: `chant`.
 */
export function opWaveBinArgv(bin?: string): string[] {
  const words = (bin ?? "").split(/\s+/).filter(Boolean);
  return words.length > 0 ? words : ["chant"];
}

/** The command a resume job runs, through the product's bin when it has one (#4607). */
export function opWavesResumeCommand(spec: Pick<OpWavesSpec, "name">, bin?: string): string[] {
  return [...opWaveBinArgv(bin), "run", "resume", "--op", spec.name];
}

/** The command a `pr-review` spec's plans job runs on a pull request (#3684), through the product's bin (#4607). */
export function opWavesRecordPlansCommand(specFile: string, bin?: string): string[] {
  return [...opWaveBinArgv(bin), "run", "wave", "--spec", specFile, "--record-plans"];
}

/** The default apply command. */
export const OP_WAVE_DEFAULT_APPLY = ["chant", "run", "{op}", "--env", "{target}"];

/** Where the runner keeps a wave's decision; a wide wave's deciding job hands it to its share jobs. */
export function opWaveRecordPath(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}.json`;
}

/** One generated job. */
export interface OpWaveJob {
  jobName: string;
  /** 1-based wave number. */
  wave: number;
  /** The wave's name. */
  waveName: string;
  /** `wave`: plan, decide and apply. `decide`: plan and decide. `share`: apply one slice. */
  kind: "wave" | "decide" | "share";
  /** 1-based, on a share job (and a group's job when the group has shares). */
  share?: number;
  /** On a job group's job (#3914): the group's name. Its kind is `share`. */
  group?: string;
  /** Jobs this one waits on. */
  needs: string[];
  /** The job's command, as argv. */
  command: string[];
  /** On a share job: the decision record to download. On a deciding job: the one to upload. */
  record?: string;
  /**
   * The outcome file the job writes (#4322), which the forge keeps whatever
   * the job's exit code: each of its runs' outcome, as `../wave-blocked.ts`
   * writes them. A job with `needs` reads the earlier ones from
   * {@link opWaveOutcomeDir} first.
   */
  outcome: string;
}

/** Where a wave job writes its outcome file and finds the earlier ones (#4322), at any depth. */
export function opWaveOutcomeDir(spec: Pick<OpWavesSpec, "name">): string {
  return `.chant/op-waves/${spec.name}/outcomes`;
}

/** The outcome file of wave `wave`'s job, or of one group or share of it (#4322). */
export function opWaveOutcomePath(spec: Pick<OpWavesSpec, "name">, wave: number, part: { group?: string; share?: number } = {}): string {
  return `${opWaveOutcomeDir(spec)}/${waveOutcomeFileName(wave, part)}`;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Refuse a spec no job could run, naming what is wrong. */
export function assertOpWavesSpec(spec: OpWavesSpec): void {
  const where = `Op waves "${spec.name}"`;
  if (!NAME.test(spec.name)) throw new Error(`${where}: the name must be lowercase letters, digits, "-" and "_"`);
  if (spec.control !== undefined) {
    // #4617: the control repo's settings, checked as the pull request loop's are.
    const problems = opWavesControlProblems(spec.control);
    if (problems.length > 0) throw new Error(`${where}: ${problems.join("; ")}.`);
  }
  if (!spec.op) throw new Error(`${where} names no \`op\`. Name the Op a run runs when it names none.`);
  if (spec.plan !== undefined && spec.planWave !== undefined) {
    throw new Error(`${where} has both \`plan\` and \`planWave\`. A wave is planned one run at a time or all at once; give one.`);
  }
  if (spec.apply !== undefined && spec.applyWave !== undefined) {
    throw new Error(`${where} has both \`apply\` and \`applyWave\`. A wave is applied one run at a time or all at once; give one.`);
  }
  if (spec.step !== undefined) {
    // #4545: a step plans and applies; its problems include a command set beside it.
    const problems = opWaveStepProblems(spec);
    if (problems.length > 0) throw new Error(`${where}: ${problems.join("; ")}.`);
  } else if (spec.planWave !== undefined) {
    assertArgv(where, "planWave", spec.planWave);
    if (!spec.planWave.some((part) => part.includes("{plans}"))) {
      throw new Error(`${where}: the \`planWave\` command never names {plans}, the file it writes each run's plan digest to.`);
    }
  } else {
    if (!Array.isArray(spec.plan) || spec.plan.length === 0) {
      throw new Error(`${where} has no \`plan\` command. Each wave plans its runs to bind its gate to their plan digests; give \`plan\` or \`planWave\`.`);
    }
    assertArgv(where, "plan", spec.plan);
    if (!spec.plan.some((part) => part.includes("{plan}"))) {
      throw new Error(`${where}: the \`plan\` command never names {plan}, the file it writes the plan digest to.`);
    }
  }
  if (spec.apply !== undefined) assertArgv(where, "apply", spec.apply);
  if (spec.applyWave !== undefined) {
    assertArgv(where, "applyWave", spec.applyWave);
    if (!spec.applyWave.some((part) => part.includes("{runs}"))) {
      throw new Error(`${where}: the \`applyWave\` command never names {runs}, the file listing the approved runs it applies.`);
    }
  }
  assertOpWaveHooks(where, spec.hooks);
  if (spec.standDown !== undefined && typeof spec.standDown !== "boolean") throw new Error(`${where}: \`standDown\` must be true or false.`);
  {
    const problems = opWaveReleaseProblems(spec);
    if (problems.length > 0) throw new Error(`${where}: ${problems.join("; ")}.`);
  }
  if (spec.waves.length === 0) throw new Error(`${where} has no waves.`);
  {
    const problems = opWaveHoldsProblems(spec.holds);
    if (problems.length > 0) throw new Error(`${where}: ${problems.join("; ")}.`);
  }
  if (spec.labels !== undefined) {
    const l = spec.labels as unknown;
    if (l === null || typeof l !== "object" || Array.isArray(l) || !Object.values(l as Record<string, unknown>).every((v) => typeof v === "string")) {
      throw new Error(`${where}: \`labels\` must map names to strings, such as { "Env": "prod" }.`);
    }
  }
  if (spec.resume !== undefined && (typeof spec.resume.schedule !== "string" || spec.resume.schedule.trim().split(/\s+/).length !== 5)) {
    throw new Error(`${where}: resume.schedule must be a five-field cron expression, such as "*/10 * * * *".`);
  }
  if (spec.approvals !== undefined) {
    const a = spec.approvals as unknown;
    if (a === null || typeof a !== "object" || Array.isArray(a)) throw new Error(`${where}: \`approvals\` must be { "spend"?: true | false, "quorum"?: [...], "reviewLedger"?: "<op>", "involved"?: {...} }.`);
    for (const [key, value] of Object.entries(a as Record<string, unknown>)) {
      if (key === "quorum") {
        // #4290: approval rules, read at base like the policy.
        if (!Array.isArray(value)) throw new Error(`${where}: approvals.quorum must be a list of rules, each { "targets"?, "count", "roles"?, "notAuthor"? }.`);
        const problems = quorumProblems(value, "approvals.quorum", { notAuthor: true });
        if (problems.length > 0) throw new Error(`${where}: ${problems.join("; ")}.`);
        continue;
      }
      if (key === "reviewLedger") {
        // #4333: the op a product records its reviews under, read at base.
        if (typeof value !== "string" || !OP_LEDGER_NAME.test(value)) throw new Error(`${where}: approvals.reviewLedger must name an op, such as "tf-apply": letters, digits, dot, dash and underscore.`);
        continue;
      }
      if (key === "involved") {
        const problems = opWavesInvolvedProblems(value);
        if (problems.length > 0) throw new Error(`${where}: ${problems.join("; ")}.`);
        continue;
      }
      if (key === "pullRequest") {
        // #4550: the pull request's gate a pull-request wave takes its approval from, read at base.
        const gate = (value as { gate?: unknown } | null)?.gate;
        if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => k !== "gate") || typeof gate !== "string" || !OP_LEDGER_NAME.test(gate)) {
          throw new Error(`${where}: approvals.pullRequest must be { "gate": "<gate>" }, the pull request's gate, such as "up".`);
        }
        continue;
      }
      if (key !== "spend") throw new Error(`${where}: approvals.${key} is not a setting; the ones there are approvals.spend, approvals.quorum, approvals.reviewLedger, approvals.involved and approvals.pullRequest.`);
      if (typeof value !== "boolean") throw new Error(`${where}: approvals.spend must be true or false.`);
    }
    if ((a as OpWavesApprovals).quorum?.length && (spec.point !== undefined || spec.waves.some((w) => w.point !== undefined))) {
      throw new Error(`${where}: approvals.quorum and a decision point are both set; a gate that asks a point takes its deciders and quorum from the point, so drop one of them.`);
    }
  }
  // #4550: a wave that takes the pull request's approval needs to know its gate.
  if (spec.waves.some((w) => w.approval === "pull-request") && !spec.approvals?.pullRequest) {
    throw new Error(`${where}: a wave with approval "pull-request" takes the pull request's approval, so the spec needs approvals.pullRequest: { "gate": "<gate>" }.`);
  }
  if (spec.gateName !== undefined) {
    if (typeof spec.gateName !== "string" || !spec.gateName.includes("{k}") || /\s/.test(spec.gateName)) {
      throw new Error(`${where}: gateName must be a pattern with {k}, the wave's number, and no spaces, such as "${OP_WAVE_DEFAULT_GATE_NAME}" or "wave-{k}".`);
    }
    const left = spec.gateName.replaceAll("{gate}", "").replaceAll("{k}", "").match(/\{[^}]*\}/);
    if (left) throw new Error(`${where}: gateName names ${left[0]}; the pattern fills in {gate} and {k} only.`);
  }
  if (spec.digest !== undefined) {
    const d = spec.digest as unknown;
    if (d === null || typeof d !== "object" || Array.isArray(d)) throw new Error(`${where}: \`digest\` must be { "over"?: "all" | "changing" }.`);
    for (const [key, value] of Object.entries(d as Record<string, unknown>)) {
      if (key !== "over") throw new Error(`${where}: digest.${key} is not a setting; the one there is digest.over.`);
      if (!OP_WAVES_DIGEST_OVER.includes(value as "all")) throw new Error(`${where}: digest.over is ${JSON.stringify(value)}; use "all" or "changing".`);
    }
  }
  if (spec.override !== undefined) {
    const o = spec.override as unknown;
    if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error(`${where}: \`override\` must be { "overriders"?: "<file at base>" }.`);
    for (const [key, value] of Object.entries(o as Record<string, unknown>)) {
      if (key !== "overriders") throw new Error(`${where}: override.${key} is not a setting; the one there is override.overriders.`);
      if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}: override.overriders must be a path, such as ".chant/overriders".`);
    }
  }
  if (spec.point !== undefined) {
    const problems = opWavePointProblems(spec.point);
    if (problems.length > 0) throw new Error(`${where}: ${problems.join("; ")}.`);
  }
  if (spec.neverOverMcp !== undefined && typeof spec.neverOverMcp !== "boolean") throw new Error(`${where}: neverOverMcp must be true or false.`);
  if (spec.runner !== undefined) assertOpWaveRunner(where, "runner", spec.runner);
  if (spec.notify !== undefined) {
    const problem = notifyConfigProblem(spec.notify, "notify");
    if (problem) throw new Error(`${where}: ${problem}`);
  }
  const names = new Set<string>();
  for (const wave of spec.waves) {
    if (!NAME.test(wave.name)) {
      throw new Error(`${where}: wave "${wave.name}" must be named with lowercase letters, digits, "-" and "_"`);
    }
    if (names.has(wave.name)) throw new Error(`${where} names wave "${wave.name}" twice.`);
    names.add(wave.name);
    if (wave.gate !== undefined && !OP_WAVE_GATE_POLICIES.includes(wave.gate)) {
      throw new Error(`${where}: wave "${wave.name}" has gate "${wave.gate}"; use ${OP_WAVE_GATE_POLICIES.join(", ")}.`);
    }
    if (wave.approval !== undefined && !GATE_APPROVAL_SOURCES.includes(wave.approval)) {
      throw new Error(`${where}: wave "${wave.name}" has approval "${wave.approval}"; use ${GATE_APPROVAL_SOURCES.join(", ")}.`);
    }
    assertOpWaveHooks(`${where}, wave "${wave.name}"`, wave.hooks);
    if (wave.point !== undefined) {
      const problems = opWavePointProblems(wave.point);
      if (problems.length > 0) throw new Error(`${where}: wave "${wave.name}": ${problems.join("; ")}.`);
    }
    if (wave.runner !== undefined) assertOpWaveRunner(where, `wave "${wave.name}" runner`, wave.runner);
    if (wave.idTokens !== undefined) assertOpWaveIdTokens(where, `wave "${wave.name}" idTokens`, wave.idTokens);
    if (wave.cloud !== undefined) assertOpWaveCloud(where, `wave "${wave.name}" cloud`, wave.cloud);
    if (wave.jobs !== undefined) assertOpWaveJobGroups(where, wave);
    if (wave.discover !== undefined && typeof wave.discover !== "boolean") throw new Error(`${where}: wave "${wave.name}" has discover ${JSON.stringify(wave.discover)}; use true or false.`);
    if (wave.rest !== undefined && typeof wave.rest !== "boolean") throw new Error(`${where}: wave "${wave.name}" has rest ${JSON.stringify(wave.rest)}; use true or false.`);
    if (wave.discover) {
      if (spec.planWave === undefined) throw new Error(`${where}: wave "${wave.name}" discovers its runs, which only \`planWave\` can report. Give planWave.`);
      if ((wave.runs ?? []).length > 0) throw new Error(`${where}: wave "${wave.name}" discovers its runs, so it lists none.`);
    }
    if (wave.rest) {
      if (!wave.discover) throw new Error(`${where}: wave "${wave.name}" has rest, which follows the waves planWave discovers; set discover too.`);
      if (wave !== spec.waves[spec.waves.length - 1]) throw new Error(`${where}: wave "${wave.name}" has rest, which only the last wave can have.`);
      if ((wave.shares ?? 1) > 1) throw new Error(`${where}: wave "${wave.name}" has rest and shares; the waves after it run in its one job, so it cannot be split.`);
    }
    if (wave.discover) {
      const shares = wave.shares ?? 1;
      if (!Number.isInteger(shares) || shares < 1) throw new Error(`${where}: wave "${wave.name}" has shares ${wave.shares}; use a whole number from 1.`);
      continue;
    }
    if (!Array.isArray(wave.runs) || wave.runs.length === 0) throw new Error(`${where}: wave "${wave.name}" has no runs.`);
    const targets = new Set<string>();
    for (const run of wave.runs) {
      if (!run.target) throw new Error(`${where}: wave "${wave.name}" has a run with no target.`);
      if (targets.has(run.target)) throw new Error(`${where}: wave "${wave.name}" names target "${run.target}" twice.`);
      targets.add(run.target);
    }
    const shares = wave.shares ?? 1;
    if (!Number.isInteger(shares) || shares < 1) {
      throw new Error(`${where}: wave "${wave.name}" has shares ${wave.shares}; use a whole number from 1.`);
    }
    if (shares > wave.runs.length) {
      throw new Error(`${where}: wave "${wave.name}" has ${shares} shares for ${wave.runs.length} runs, so a share would apply nothing.`);
    }
    if (wave.jobs !== undefined) {
      const problem = opWaveGroupsProblem(wave, wave.runs.map((r) => r.target));
      if (problem) throw new Error(`${where}: ${problem}.`);
    }
  }
  assertOpWaveDependsOn(where, spec);
}

/**
 * Refuse a `dependsOn` (#4322) that names no run this one could follow: each
 * entry is a target of an earlier wave, or of a run listed before it in its
 * own wave when one job applies that wave. A discovering wave's runs are not
 * in the spec, so after one any target is taken.
 */
function assertOpWaveDependsOn(where: string, spec: OpWavesSpec): void {
  const earlier = new Set<string>();
  let discovered = false;
  for (const wave of spec.waves) {
    const own = new Set<string>();
    for (const run of wave.runs ?? []) {
      const deps = run.dependsOn as unknown;
      if (deps !== undefined) {
        const at = `wave "${wave.name}" run "${run.target}"`;
        if (!Array.isArray(deps) || !deps.every((d) => typeof d === "string" && d !== "")) throw new Error(`${where}: ${at} dependsOn must be a list of targets.`);
        for (const dep of deps as string[]) {
          if (dep === run.target && !earlier.has(dep)) throw new Error(`${where}: ${at} depends on itself.`);
          if (own.has(dep)) {
            if ((wave.shares ?? 1) > 1 || wave.jobs !== undefined) {
              throw new Error(`${where}: ${at} depends on "${dep}" in its own wave, which ${wave.jobs ? "job groups" : "shares"} apply in separate jobs; move one of them to another wave.`);
            }
            continue;
          }
          if (!earlier.has(dep) && !discovered) throw new Error(`${where}: ${at} depends on "${dep}", which is no run of an earlier wave or listed before it in its own.`);
        }
      }
      own.add(run.target);
    }
    for (const t of own) earlier.add(t);
    if (wave.discover) discovered = true;
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The key each cloud of a `cloud` trade names its identity under (`IDENTITY_KEY` in ../ci-identity.ts, kept here so this module imports none of it). */
const CLOUD_IDENTITY_KEY: Record<string, string> = { aws: "role", gcp: "serviceAccount", azure: "clientId", pulumi: "token" };

/** Refuse a `cloud` (#4332) the trade could not run: an unknown cloud, one that names no identity, or no audience. */
function assertOpWaveCloud(where: string, field: string, cloud: unknown): void {
  if (cloud === null || typeof cloud !== "object" || Array.isArray(cloud) || Object.keys(cloud).length === 0) throw new Error(`${where}: ${field} must name one or more of aws, gcp, azure and pulumi.`);
  for (const [name, c] of Object.entries(cloud as Record<string, unknown>)) {
    const key = CLOUD_IDENTITY_KEY[name];
    if (!key) throw new Error(`${where}: ${field}.${name} is not a cloud; use aws, gcp, azure or pulumi.`);
    const t = c as Record<string, unknown> | null;
    const targets = t?.targets;
    const targetsOk = targets === undefined || (Array.isArray(targets) && targets.every((e) => e && Array.isArray((e as { targets?: unknown }).targets) && typeof (e as Record<string, unknown>)[key] === "string"));
    if (!t || typeof t.audience !== "string" || !targetsOk || (typeof t[key] !== "string" && !(Array.isArray(targets) && targets.length > 0))) {
      throw new Error(`${where}: ${field}.${name} must give an audience and a ${key}, or targets each with targets and a ${key}, as cloudIdentityWave gives them.`);
    }
  }
}

/** Refuse a `runner` no forge could read (#3914). */
function assertOpWaveRunner(where: string, field: string, runner: unknown): void {
  const labels = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && value.every((l) => typeof l === "string" && l.trim() !== "");
  if (typeof runner === "string" && runner.trim() !== "") return;
  if (labels(runner)) return;
  if (runner !== null && typeof runner === "object" && !Array.isArray(runner)) {
    const { group, labels: l, ...rest } = runner as Record<string, unknown>;
    const extra = Object.keys(rest)[0];
    if (extra !== undefined) throw new Error(`${where}: ${field}.${extra} is not a setting; a runner group is { "group": "<name>", "labels"?: [...] }.`);
    if (typeof group === "string" && group.trim() !== "" && (l === undefined || labels(l))) return;
  }
  throw new Error(`${where}: ${field} must be a runner label, a non-empty list of labels, or { "group": "<name>", "labels"?: [...] } (GitHub only).`);
}

/** Refuse `idTokens` that are not `{ <variable>: <audience> }` (#3914). */
function assertOpWaveIdTokens(where: string, field: string, idTokens: unknown): void {
  if (idTokens === null || typeof idTokens !== "object" || Array.isArray(idTokens) || Object.keys(idTokens).length === 0) {
    throw new Error(`${where}: ${field} must be { "<variable>": "<audience>" }, with at least one token.`);
  }
  for (const [name, aud] of Object.entries(idTokens as Record<string, unknown>)) {
    if (!ENV_NAME.test(name)) throw new Error(`${where}: ${field} names "${name}", which is not a variable name (letters, digits and "_", not starting with a digit).`);
    if (typeof aud !== "string" || aud.trim() === "") throw new Error(`${where}: ${field}.${name} must be an audience, a non-empty string.`);
  }
}

/** Refuse a wave's `jobs` no pipeline could render (#3914). Which runs each group holds is {@link opWaveGroupsProblem}'s. */
function assertOpWaveJobGroups(where: string, wave: OpWave): void {
  const at = `wave "${wave.name}"`;
  if (!Array.isArray(wave.jobs) || wave.jobs.length === 0) throw new Error(`${where}: ${at} jobs must be a non-empty list of job groups.`);
  if ((wave.shares ?? 1) > 1) throw new Error(`${where}: ${at} has jobs and shares; split each job group with its own shares.`);
  if (wave.rest) throw new Error(`${where}: ${at} has jobs and rest; the waves after it run in its one job, so its apply cannot be split into groups.`);
  const names = new Set<string>();
  wave.jobs.forEach((group, i) => {
    if (group === null || typeof group !== "object") throw new Error(`${where}: ${at} jobs[${i}] must be { "name", "runs", ... }.`);
    const field = `${at} jobs[${i}]${typeof group.name === "string" ? ` (${group.name})` : ""}`;
    if (typeof group.name !== "string" || !NAME.test(group.name)) throw new Error(`${where}: ${field} must be named with lowercase letters, digits, "-" and "_".`);
    if (group.name === "decide" || /^share-\d+$/.test(group.name)) throw new Error(`${where}: ${field} is named like the wave's own jobs (decide, share-<i>); name it another way.`);
    if (names.has(group.name)) throw new Error(`${where}: ${at} names job group "${group.name}" twice.`);
    names.add(group.name);
    const known = new Set(["name", "runs", "shares", "runner", "environment", "variables", "setup", "idTokens", "cloud"]);
    const extra = Object.keys(group).find((key) => !known.has(key));
    if (extra !== undefined) throw new Error(`${where}: ${field}.${extra} is not a setting; a job group takes ${[...known].join(", ")}.`);
    if (!Array.isArray(group.runs) || group.runs.length === 0 || !group.runs.every((r) => typeof r === "string" && r.trim() !== "")) {
      throw new Error(`${where}: ${field} runs must be a non-empty list of targets or patterns.`);
    }
    const shares = group.shares ?? 1;
    if (!Number.isInteger(shares) || shares < 1) throw new Error(`${where}: ${field} has shares ${group.shares}; use a whole number from 1.`);
    if (group.runner !== undefined) assertOpWaveRunner(where, `${field} runner`, group.runner);
    if (group.idTokens !== undefined) assertOpWaveIdTokens(where, `${field} idTokens`, group.idTokens);
    if (group.cloud !== undefined) assertOpWaveCloud(where, `${field} cloud`, group.cloud);
    if (group.variables !== undefined && (group.variables === null || typeof group.variables !== "object" || Array.isArray(group.variables) || !Object.values(group.variables).every((v) => typeof v === "string"))) {
      throw new Error(`${where}: ${field} variables must be { "<name>": "<value>" }.`);
    }
    if (group.setup !== undefined && !Array.isArray(group.setup)) throw new Error(`${where}: ${field} setup must be a list of steps.`);
    if (group.environment !== undefined && (group.environment === null || typeof group.environment !== "object" || typeof group.environment.name !== "string")) {
      throw new Error(`${where}: ${field} environment must be { "name", "url"? }.`);
    }
  });
}

/**
 * True when `target` matches a job group's `runs` entry (#3914): the target
 * itself, or a pattern where `*` matches within one `/` segment and `**`
 * across segments.
 */
export function opWaveRunMatches(pattern: string, target: string): boolean {
  if (!pattern.includes("*")) return pattern === target;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(target);
}

/**
 * The runs of `runs` hook `hook` is for (#4288): those its `targets` match,
 * or every run when it names none.
 */
export function opWaveHookRuns<T extends { target: string }>(hook: Pick<OpWaveHook, "targets">, runs: readonly T[]): T[] {
  if (!hook.targets) return [...runs];
  return runs.filter((run) => hook.targets!.some((pattern) => opWaveRunMatches(pattern, run.target)));
}

/** The runs of `runs` that job group `group` holds (#3914). */
export function opWaveGroupRuns<T extends { target: string }>(group: Pick<OpWaveJobGroup, "runs">, runs: readonly T[]): T[] {
  return runs.filter((run) => group.runs.some((pattern) => opWaveRunMatches(pattern, run.target)));
}

/**
 * What is wrong with how a wave's job groups hold `targets` (#3914): a run in
 * two groups, or in none. Undefined when each run is in exactly one.
 */
export function opWaveGroupsProblem(wave: Pick<OpWave, "name" | "jobs">, targets: readonly string[]): string | undefined {
  for (const target of targets) {
    const holders = (wave.jobs ?? []).filter((group) => group.runs.some((pattern) => opWaveRunMatches(pattern, target))).map((g) => `"${g.name}"`);
    if (holders.length > 1) return `wave "${wave.name}" jobs: run "${target}" is in job groups ${holders.join(" and ")}; each run is in exactly one`;
    if (holders.length === 0) return `wave "${wave.name}" jobs: run "${target}" is in no job group; each run is in exactly one`;
  }
  return undefined;
}

function assertArgv(where: string, field: string, argv: unknown): void {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string") || argv[0] === "") {
    throw new Error(`${where}: \`${field}\` must be a command as argv, a non-empty array of strings.`);
  }
}

/** Refuse hooks no runner could run, naming what is wrong (#3762). */
export function assertOpWaveHooks(where: string, hooks: OpWaveHooks | undefined): void {
  if (hooks === undefined) return;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`${where}: \`hooks\` must be { "before"?: { "observe"?, "plan"?, "apply"? }, "after"?: { "plan"?, "gate"?, "apply"? } }.`);
  }
  for (const [side, stages] of Object.entries(hooks as Record<string, unknown>)) {
    if (side === "apply") {
      const runBy = (stages as { runBy?: unknown } | null)?.runBy;
      if (stages === null || typeof stages !== "object" || Array.isArray(stages) || Object.keys(stages).some((key) => key !== "runBy")) {
        throw new Error(`${where}: hooks.apply must be { "runBy"?: "chant" | "apply" }.`);
      }
      if (runBy !== undefined && !OP_WAVE_APPLY_HOOKS_RUNNERS.includes(runBy as OpWaveApplyHooksRunner)) {
        throw new Error(`${where}: hooks.apply.runBy is ${JSON.stringify(runBy)}; use ${OP_WAVE_APPLY_HOOKS_RUNNERS.map((r) => `"${r}"`).join(" or ")}.`);
      }
      continue;
    }
    if (side === "check") throw new Error(`${where}: hooks.check runs in a product's check job, so it belongs in ci.hooks of the workspace declaration, not in an Op waves spec.`);
    if (side !== "before" && side !== "after") throw new Error(`${where}: hooks.${side} is not a moment; use hooks.before or hooks.after (or hooks.apply.runBy).`);
    if (stages === null || typeof stages !== "object" || Array.isArray(stages)) throw new Error(`${where}: hooks.${side} must be { "plan"?: [...], "apply"?: [...] }.`);
    for (const [stage, list] of Object.entries(stages as Record<string, unknown>)) {
      const at = `hooks.${side}.${stage}`;
      if (stage === "gate" && side === "before") throw new Error(`${where}: ${at} is not a moment; a hook runs after the gate (hooks.after.gate), or before the plan or the apply.`);
      if (stage === "observe" && side === "after") throw new Error(`${where}: ${at} is not a moment; a hook runs before the observe (hooks.before.observe), or after the plan, which reads what the observe saw.`);
      if (stage !== "observe" && stage !== "plan" && stage !== "apply" && stage !== "gate") throw new Error(`${where}: ${at} is not a stage; a hook runs before the observe, before or after plan or apply, or after the gate.`);
      if (!Array.isArray(list)) throw new Error(`${where}: ${at} must be a list of hooks.`);
      list.forEach((hook: OpWaveHook, i: number) => {
        const which = `${at}[${i}]${hook && typeof hook === "object" && typeof hook.name === "string" ? ` (${hook.name})` : ""}`;
        if (!hook || typeof hook !== "object") throw new Error(`${where}: ${which} must be { "command": [...], "onFailure"?, "perRun"? }.`);
        assertArgv(where, `${which}.command`, hook.command);
        if (hook.onFailure !== undefined && !OP_WAVE_HOOK_FAILURES.includes(hook.onFailure)) {
          throw new Error(`${where}: ${which} has onFailure "${hook.onFailure}"; use ${OP_WAVE_HOOK_FAILURES.join(" or ")}.`);
        }
        if (hook.onFailure === "approve" && side === "after" && stage === "apply") {
          throw new Error(`${where}: ${which} has onFailure "approve", but after the apply there is nothing left to hold. Use "fail".`);
        }
        if (hook.onFailure === "approve" && stage === "gate") {
          throw new Error(`${where}: ${which} has onFailure "approve", but the gate has already decided when it runs. Use "fail", or hold the wave from an after.plan hook.`);
        }
        if (hook.perRun !== undefined && typeof hook.perRun !== "boolean") throw new Error(`${where}: ${which}.perRun must be true or false.`);
        if (hook.targets !== undefined && (!Array.isArray(hook.targets) || hook.targets.length === 0 || !hook.targets.every((t) => typeof t === "string" && t !== ""))) {
          throw new Error(`${where}: ${which}.targets must be a non-empty list of targets or patterns, such as ["prod/*"].`);
        }
        if (!hook.perRun) {
          const named = hook.command.find((part) => part.includes("{target}") || part.includes("{plan}") || part.includes("{planJson}"));
          if (named) throw new Error(`${where}: ${which} runs once for the wave, so it has no {target}, {plan} or {planJson} ("${named}"). Set "perRun": true, or read the runs from {runs}.`);
        } else if (side === "before" && (stage === "plan" || stage === "observe") && hook.command.some((part) => part.includes("{plan}") || part.includes("{planJson}"))) {
          throw new Error(`${where}: ${which} runs before the plan, so it has no {plan} yet.`);
        }
      });
    }
  }
}

/**
 * The moments a pull-request job runs hooks at (#4288): `pr-plan` and
 * `pr-record` run the observe and plan moments, and `pr-apply` the apply
 * moments too. `after-gate` (#4323) runs in `pr-apply` once the pull
 * request's gate has decided.
 */
export const PR_LOOP_HOOK_MOMENTS: readonly OpWaveHookMoment[] = ["before-observe", "before-plan", "after-plan", "after-gate", "before-apply", "after-apply"];

/** `ci.hooks` in the workspace declaration: the Op waves moments, and `check` (#4556). */
export interface CiHooks extends OpWaveHooks {
  /** Run in the check job (#4556), once, or once per target with `perRun`. Read at base like every moment. */
  check?: OpWaveHook[];
}

/**
 * Refuse `ci.hooks` a pull-request job could not run (#4288): what
 * {@link assertOpWaveHooks} refuses, plus `apply.runBy`, since chant itself
 * runs a pull request's apply, and a `check` hook that names a plan or asks
 * for an approval (#4556).
 */
export function assertPrLoopHooks(where: string, hooks: CiHooks | undefined): void {
  if (hooks !== undefined && hooks !== null && typeof hooks === "object" && !Array.isArray(hooks) && "check" in hooks) {
    const { check, ...rest } = hooks;
    assertCheckHooks(where, check);
    assertOpWaveHooks(where, rest);
  } else {
    assertOpWaveHooks(where, hooks);
  }
  if (hooks?.apply !== undefined) throw new Error(`${where}: hooks.apply.runBy is for an Op waves spec; chant runs a pull request's apply, so it runs the apply-stage hooks itself.`);
}

/** Refuse `ci.hooks.check` hooks the check job could not run (#4556). */
export function assertCheckHooks(where: string, list: unknown): void {
  if (!Array.isArray(list)) throw new Error(`${where}: hooks.check must be a list of hooks.`);
  list.forEach((hook: OpWaveHook, i: number) => {
    const which = `hooks.check[${i}]${hook && typeof hook === "object" && typeof hook.name === "string" ? ` (${hook.name})` : ""}`;
    if (!hook || typeof hook !== "object") throw new Error(`${where}: ${which} must be { "command": [...], "name"?, "onFailure"?, "perRun"?, "targets"? }.`);
    assertArgv(where, `${which}.command`, hook.command);
    if (hook.onFailure === "approve") throw new Error(`${where}: ${which} has onFailure "approve", but the check runs before any plan, so there is nothing to approve. Use "fail".`);
    if (hook.onFailure !== undefined && hook.onFailure !== "fail") throw new Error(`${where}: ${which} has onFailure "${hook.onFailure}"; use "fail".`);
    if (hook.perRun !== undefined && typeof hook.perRun !== "boolean") throw new Error(`${where}: ${which}.perRun must be true or false.`);
    if (hook.targets !== undefined && (!Array.isArray(hook.targets) || hook.targets.length === 0 || !hook.targets.every((t) => typeof t === "string" && t !== ""))) {
      throw new Error(`${where}: ${which}.targets must be a non-empty list of targets or patterns, such as ["prod/*"].`);
    }
    const plan = hook.command.find((part) => part.includes("{plan}"));
    if (plan) throw new Error(`${where}: ${which} runs before any plan, so it has no {plan} ("${plan}").`);
    if (!hook.perRun) {
      const target = hook.command.find((part) => part.includes("{target}"));
      if (target) throw new Error(`${where}: ${which} runs once for the check, so it has no {target} ("${target}"). Set "perRun": true.`);
    }
  });
}

/** The hooks of each moment for wave `name`: the spec's, then the wave's own. */
export function opWaveHooksAt(spec: Pick<OpWavesSpec, "hooks" | "waves">, name: string): Record<OpWaveHookMoment, OpWaveHook[]> {
  const wave = spec.waves.find((w) => w.name === name);
  const at = (hooks: OpWaveHooks | undefined, moment: OpWaveHookMoment): OpWaveHook[] => {
    const [side, stage] = moment.split("-") as ["before" | "after", OpWaveHookStage];
    return (hooks?.[side] as Partial<Record<OpWaveHookStage, OpWaveHook[]>> | undefined)?.[stage] ?? [];
  };
  return Object.fromEntries(OP_WAVE_HOOK_MOMENTS.map((m) => [m, [...at(spec.hooks, m), ...at(wave?.hooks, m)]])) as Record<OpWaveHookMoment, OpWaveHook[]>;
}

/** Who runs wave `name`'s apply-stage hooks (#3804): the wave's `hooks.apply.runBy`, else the spec's, else `chant`. */
export function opWaveApplyHooksRunBy(spec: Pick<OpWavesSpec, "hooks" | "waves">, name: string): OpWaveApplyHooksRunner {
  const wave = spec.waves.find((w) => w.name === name);
  return wave?.hooks?.apply?.runBy ?? spec.hooks?.apply?.runBy ?? "chant";
}

/**
 * The runs share `share` (1-based) of `shares` applies: the wave's runs sorted
 * by target, cut into contiguous slices whose sizes differ by at most one.
 */
export function opWaveShare<T extends { target: string }>(runs: readonly T[], share: number, shares: number): T[] {
  return waveShare(runs, share, shares, (run) => run.target);
}

/**
 * The jobs of an Op waves pipeline, in order. `specFile` is the spec's path
 * from the job's working directory, which every command names. `bin` is the
 * product's command in place of `chant` (#4607, {@link opWaveBinArgv}).
 */
export function opWaveJobs(spec: OpWavesSpec, specFile: string, options: { bin?: string } = {}): OpWaveJob[] {
  assertOpWavesSpec(spec);
  const jobs: OpWaveJob[] = [];
  let previous: string[] = [];
  spec.waves.forEach((wave, index) => {
    const k = index + 1;
    const command = [...opWaveBinArgv(options.bin), "run", "wave", "--spec", specFile, "--wave", String(k), ...(spec.base ? ["--base", spec.base] : [])];
    const prefix = `wave-${k}-${wave.name}`;
    const shares = wave.shares ?? 1;
    if (shares === 1 && wave.jobs === undefined) {
      jobs.push({ jobName: prefix, wave: k, waveName: wave.name, kind: "wave", needs: previous, command, outcome: opWaveOutcomePath(spec, k) });
      previous = [prefix];
      return;
    }
    const record = opWaveRecordPath(spec, k);
    const decide = `${prefix}-decide`;
    jobs.push({ jobName: decide, wave: k, waveName: wave.name, kind: "decide", needs: previous, command: [...command, "--decide"], record, outcome: opWaveOutcomePath(spec, k) });
    const shareJobs: string[] = [];
    if (wave.jobs !== undefined) {
      // #3914: a job per group, or per share of a group, each applying its runs under the deciding job's decision.
      for (const group of wave.jobs) {
        const groupShares = group.shares ?? 1;
        const groupCommand = [...command, "--group", group.name];
        if (groupShares === 1) {
          const jobName = `${prefix}-${group.name}`;
          shareJobs.push(jobName);
          jobs.push({ jobName, wave: k, waveName: wave.name, kind: "share", group: group.name, needs: [decide], command: groupCommand, record, outcome: opWaveOutcomePath(spec, k, { group: group.name }) });
          continue;
        }
        for (let share = 1; share <= groupShares; share++) {
          const jobName = `${prefix}-${group.name}-share-${share}`;
          shareJobs.push(jobName);
          jobs.push({ jobName, wave: k, waveName: wave.name, kind: "share", group: group.name, share, needs: [decide], command: [...groupCommand, "--share", String(share)], record, outcome: opWaveOutcomePath(spec, k, { group: group.name, share }) });
        }
      }
      previous = shareJobs;
      return;
    }
    for (let share = 1; share <= shares; share++) {
      const jobName = `${prefix}-share-${share}`;
      shareJobs.push(jobName);
      jobs.push({ jobName, wave: k, waveName: wave.name, kind: "share", share, needs: [decide], command: [...command, "--share", String(share)], record, outcome: opWaveOutcomePath(spec, k, { share }) });
    }
    previous = shareJobs;
  });
  return jobs;
}

/** The job group a job applies (#3914), or undefined for a wave's own jobs. */
export function opWaveGroupOf(spec: OpWavesSpec, job: Pick<OpWaveJob, "wave" | "group">): OpWaveJobGroup | undefined {
  return job.group === undefined ? undefined : spec.waves[job.wave - 1]?.jobs?.find((g) => g.name === job.group);
}

/** The wave a job belongs to. */
export function opWaveOf(spec: OpWavesSpec, job: Pick<OpWaveJob, "wave">): OpWave {
  return spec.waves[job.wave - 1]!;
}
