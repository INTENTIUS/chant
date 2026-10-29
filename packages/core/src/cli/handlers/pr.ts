/**
 * `chant components pr-plan` and `chant components pr-apply` (#3183): the
 * pull-request loop the generated CI runs.
 *
 * ```
 * chant components pr-plan  --base <ref> --pr <n> --env <env> [--forge github|gitlab|forgejo]
 * chant approve pr-<n> pr-apply --plan <digest> --approver github:<login> --sign
 * chant components pr-apply --base <ref> --env <env> [--pr <n>] [--forge <kind>] [--require-review] [--resume <file>]
 *                           [--wave-gate <gate> [--wave <k>]]
 * ```
 *
 * Both measure the change from the merge base of `--base` and `HEAD`, select
 * the components it reaches and the ones that depend on them (the fan-out's
 * derivation, #2417), and plan every member before anything applies
 * (`../../components/pr-run.ts`). pr-plan writes the report and the note and
 * applies nothing; it reads the gate ledger and writes nothing to it, since
 * it runs the pull request's own code. pr-apply plans the same members on
 * the merged commit, decides the gate against the digest it gets, and
 * applies only when an approval stands for that digest. A moved plan stops
 * it with both digests named and nothing applied (exit 3).
 *
 * `--resume <file>` (#3464) finishes an apply that failed partway, the way
 * `components fan-out --resume` does (#2417, #3049). The apply writes the
 * attempt record as each component settles: the change set the gate
 * approved and the components that applied. Repeated on the same commit
 * with the same record, it plans only what is left, checks each member
 * against the approved set (`resumePrSet`) and, when all are covered and the
 * approval still stands, applies the rest without a fresh approval. When
 * they are not covered it says why and runs as it would without a record.
 *
 * `--wave-gate <gate>` (#4003) applies the approved set a wave at a time,
 * each wave planned after the one before it applied (`prApplyWaves`). A
 * wave whose plan the approved change set covers applies under the pull
 * request's approval; one whose plan moved waits at `<gate>-wave-<k>` under
 * the pull request's op (exit 3). `--wave <k>` runs one wave, reading the
 * approved set and the waves that applied from the `--resume` record.
 *
 * Every run writes `pr-plan.json` or `pr-apply.json` (`pr-report.schema.json`),
 * `change-set.json` and `pr-note.md` under `--output` (default `.chant/pr`). *
 * `--events-json` (#4041, #4007) streams the stage's run events to stdout,
 * one `run-event.schema.json` line each: the planning as a `plan` phase with
 * a step per component, the gate's decision as a `gate` phase, and on
 * pr-apply the apply's waves and components as `chant run --components`
 * streams them. A component the apply does not start settles too, `blocked`
 * behind a failed dependency or `already-applied` on a resumed apply.
 * With or without it, pr-apply prints a line on stderr as each wave starts
 * and as each component settles, so a job log shows the waves in order.
 *
 * `--report-url <s3 or file URL>` (#4007) copies `pr-<stage>.json`,
 * `change-set.json` and, with `--events-json`, the events to
 * `<url>/<pr>/<commit>/`, the events again as each wave and component
 * settles (`../../pr-report-url.ts`).
 *
 * `--member <name>` (#3465) runs a workspace member's loop: the member's
 * generated pipeline passes it from the member's directory. The gate is
 * recorded under `pr-<n>-<member>`, and the note and the statuses carry the
 * member's name, so each member's loop on one pull request stands apart.
 * The name must be the member that owns the current directory.
 *
 * `--no-status` (#4161) posts neither the stage's status nor its note: the
 * report and the note are written under `--output` only. `chant ci run
 * --local` passes it. pr-plan then builds no forge client, since posting is
 * all it uses one for; pr-apply still reads the pull request and its reviews
 * through `--forge`.
 */

import { spawnSync } from "node:child_process";
import { CHANT_EXIT } from "../../exit-codes";
import { anyResourceGrain, leaseRowsOf as leaseRowsOfLocks, lockTargetsOf, queueRowsOfLocks, type LockGrain } from "../../lifecycle/lock-rows";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadChantConfig, resolveAutoReleaseDisabled, type ChantConfig } from "../../config";
import { resolveCommit, resolveMergeBase } from "../../components/changed-files";
import { deriveFanOut, fanOutRegistry } from "../../components/fan-out-support";
import { findComponentGroups, groupFanOut } from "../../components/groups";
import {
  applyPrSet,
  approvalOf,
  approversWhoAuthored,
  approversWithoutReview,
  decidePrGate,
  planPrSet,
  prReport,
  readOnlyLedger,
  prWavePlan,
  resumePrSet,
  type PrPlanSet,
} from "../../components/pr-run";
import { composeChangeSet, verifyChangeSetDigest } from "../../change-set";
import { blockedMembers, blockedWords, settleEarlierWaves, type WaveMemberOutcome } from "../../wave-blocked";
import { readFanOutAttempt, writeFanOutAttempt, type FanOutAttempt, type PrApplyRecord } from "../../components/fan-out-record";
import { componentInputDigests, progressThatCarries } from "../../components/fan-out-inputs";
import { computePlanDigest, samePlanDigest } from "../../lifecycle/plan-digest";
import type { GateResolutionRecord } from "../../lifecycle/gate-ledger";
import { evaluateGate, gateIsSealed, gitGateLedgerPort, type GateCheck, type GateLedgerPort } from "../../op/gate";
import type { OtherGateHold } from "../../op/stage-hooks";
import { emitGateStep, gateEventsOf, GATE_PHASE, type RunEventSink, type RunEventStream } from "../../run-event-stream";
import type { RunEventBody, RunEventComponentSettle, RunEventSettleStatus } from "../../run-event";
import { openCliRunEvents, refusesEventsWithJson } from "../run-events";
import { openPrReportUpload, parseReportUrl, reportKey, type PrReportUpload, type ReportTarget } from "../../pr-report-url";
import {
  describePlanChanged,
  PR_APPLY_GATE,
  prApproveCommand,
  prApproveCommands,
  prNoteMarker,
  prOp,
  prStatusDescription,
  prStatusContext,
  prStatusState,
  renderPrNote,
  type PrApproval,
  type PrBeforeMerge,
  type PrMember,
  type PrMemberDetail,
  type PrPolicyReport,
  type PrReport,
  type PrWave,
  type PrRound,
  type PrOverdue,
} from "../../pr-loop";
import { FORGE_KINDS, forgeFromEnv, forgePrincipalOf, type ForgeKind, type PrForge } from "../../pr-forge";
import { GITHUB_COMMENT_LIMIT, GITLAB_NOTE_LIMIT } from "../../plan-summary";
import { upsertPlanNote } from "../../pr-post";
import { activeProductWords, commandWord, parseProductComment, productContext } from "../../ci-product-words";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../format";
import { reportUninstalledDependencies } from "../dependencies";
import { findWorkspaceRoot } from "../../project-root";
import { resolveChangedUnits } from "./fan-out";
import { coverByMerges, greenOp, type GreenTarget } from "../../components/green-cover";
import { GATED_EXIT_CODE, autoReleaseRun, recordAutoReleasesForRun } from "./run";
import { appliedDigestOf } from "../../components/auto-release";
import type { CommandContext } from "../registry";
import { parseArgs } from "../parse-args";
import { withComponentEndpoint } from "../component-endpoint";
import type { ComponentChangeSignal, FanOutPlan } from "../../components/fan-out";
import { assertPlanFlagsAccepted, assertTargetsAccepted, failedRunExitCode, type DriverComponent } from "../../components/driver";
import { PLAN_FLAG_ARGS, PlanFlagRefusedError, TargetsRefusedError, type CapabilityRegistry } from "../../components/capability";
import { prPlanTargets } from "../../components/pr-targets";
import { PREVIEW_COMMENT_ENV } from "../../components/pr-pipeline";
import type { ComponentEnvironmentDeclaration } from "../../components/component";
import { prLoopHooksAt, runPrHooks, type PrHoldSettled, type PrHookPlace, type PrLoopHooks } from "../../components/pr-hooks";
import { decidePrPolicyOverride, policyReviewOf, prLoopPolicyAt, prPolicyReport, runPrPolicy, spendPrPolicyOverride, type PrLoopPolicy } from "../../components/pr-policy";
import type { OpWaveHookMoment } from "../../op/op-waves";
import type { PrHookOutcome } from "../../pr-loop";
import type { PrMigrationFile } from "../../pr-migrations";
import { lexiconNames } from "../../lexicon-module";


/** Where the reports land unless `--output` says. */
export const PR_REPORT_DIR = ".chant/pr";

export interface Prepared {
  config: ChantConfig;
  env: string;
  /** The workspace member, with `--member` (#3465). */
  member?: string;
  base: string;
  head: string;
  gate: string;
  forge?: PrForge;
  /**
   * Every component in the project, not the selection (`deriveFanOut`), so
   * the plan reads the deployed outputs of a dependency the change did not
   * select (#4104).
   */
  components: DriverComponent[];
  plan: FanOutPlan;
  signal: ComponentChangeSignal;
  registry: CapabilityRegistry;
  seededOutputs: Record<string, Record<string, unknown>>;
  /** Component name to the environments it declares (#3153), whose sites `pr-env up` carries over (#4330). */
  sites?: Record<string, ComponentEnvironmentDeclaration[]>;
  /** `ci.hooks` from the declaration at base (#4288). */
  hooks: PrLoopHooks;
  /** Every hook the stage ran so far, for the report's `hooks`. */
  hookOutcomes: PrHookOutcome[];
  /** Set when a hook failed: the report's message. */
  hookFailed?: string;
  /** Where the stage's hooks run, once its op is known. */
  hookPlace?: PrHookPlace;
  /** `pr-plan --target` (#4620): the addresses each planned member's capability plan narrows to. */
  targets?: Record<string, string[]>;
  /** `pr-plan --parallelism <n>` (#4625): how many members of a wave plan at once. */
  parallelism?: number;
  /** `pr-plan --refresh` and `--target-dependents` (#4627). */
  refresh?: boolean;
  targetDependents?: boolean;
  /**
   * Set when `ci.branches` or `ci.labels` (#4292) leave the member out of this
   * stage: why. The plan is then empty, so the stage reports `nothing`.
   */
  routedAway?: string;
  /** `ci.policy` from the declaration at base (#4294). */
  policy: PrLoopPolicy;
  /** What the policy said about the plan, for the report's `policy`. */
  policyReport?: PrPolicyReport;
  /** `pr-apply --before-merge` (#4301): the requires checks, for the report's `beforeMerge`. */
  beforeMerge?: PrBeforeMerge;
}

const fail = (message: string, hint?: string): number => {
  console.error(formatError({ message, ...(hint ? { hint } : {}) }));
  return 1;
};

/** Everything both stages share: the change and the derivation. Each stage plans the members itself. `pr-env up` (#4298) prepares as the plan does. */
export async function prepare(ctx: CommandContext, stage: "plan" | "apply" | "record"): Promise<Prepared | number> {
  const { args } = ctx;
  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath).catch(() => ({ config: {} as ChantConfig }));
  const paramsResolution = resolveCliBuildParams(config.buildParams, {
    cli: parseParamFlags(args.param),
    paramsFile: args.paramsFile,
    verbose: args.verbose,
  });
  if (!paramsResolution.success) {
    for (const message of paramsResolution.errors) console.error(message);
    return 1;
  }
  if (!args.base) {
    return fail(
      `pr-${stage} needs the commit the change is measured from: --base <ref>`,
      stage === "plan" ? "On a pull request, the target branch's commit." : "On a push, the commit before it.",
    );
  }
  if (args.fromAffected) return fail(`pr-${stage} derives the change itself; drop --from-affected`);
  // #4620: a target narrows the preview; an apply or a record covers what the approved plan covers.
  if (stage !== "plan" && args.targets && args.targets.length > 0) {
    return fail(`pr-${stage} applies or records what the pull request's approved plan covers, so it takes no --target`, "Narrow the plan with pr-plan --target, and approve that plan.");
  }
  // #4627: refresh and target dependents change what the preview plans, as a target does.
  if (stage !== "plan" && (args.refresh || args.targetDependents)) {
    return fail(`pr-${stage} applies or records what the pull request's approved plan covers, so it takes no ${args.refresh ? "--refresh" : "--target-dependents"}`, "Plan with pr-plan --refresh or --target-dependents, and approve that plan.");
  }
  let member: string | undefined;
  if (args.members?.length) {
    const checked = await checkMember(projectPath, args.members);
    if (typeof checked !== "string") return fail(checked.error, checked.hint);
    member = checked;
  }
  if (args.forge !== undefined && !(FORGE_KINDS as readonly string[]).includes(args.forge)) {
    return fail(`--forge ${args.forge} is not one of ${FORGE_KINDS.join(", ")}`);
  }

  let forge: PrForge | undefined;
  if (args.forge && !(stage === "plan" && args.noStatus)) {
    try {
      forge = forgeFromEnv(args.forge as ForgeKind);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  let base: string;
  let head: string;
  try {
    head = await resolveCommit(projectPath, args.head ?? "HEAD");
    base = await resolveMergeBase(projectPath, args.base, head);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const signal = await resolveChangedUnits(ctx, config, { base, stacksOnly: true });
  if ("error" in signal) return fail(signal.error, signal.hint);

  const registry = await fanOutRegistry(projectPath, config);
  let derived;
  try {
    derived = await deriveFanOut({
      path: projectPath,
      units: signal.units,
      sandbox: args.sandbox,
      buildParams: paramsResolution.provenance,
      config,
      registry,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportUninstalledDependencies([message], projectPath); // #4116
    return fail(message);
  }
  if (!derived.success) {
    // #4116: component files that import packages the project has not installed.
    if (derived.error) reportUninstalledDependencies([derived.error], projectPath);
    return fail(derived.error ?? "Could not discover components");
  }

  const seededOutputs: Record<string, Record<string, unknown>> = {};
  for (const file of args.seedOutputs ?? []) {
    try {
      Object.assign(seededOutputs, JSON.parse(readFileSync(resolve(file), "utf8")));
    } catch (err) {
      return fail(`--seed-outputs: could not read "${file}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // #4288: the stage hooks, read from the declaration at base so the change cannot edit what its own jobs run.
  let hooks: PrLoopHooks;
  try {
    hooks = prLoopHooksAt(projectPath, base);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (hooks.note) console.error(formatInfo(hooks.note));
  // #4294: the policy, read from the declaration at base like the hooks.
  let policy: PrLoopPolicy;
  try {
    policy = prLoopPolicyAt(projectPath, base);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (policy.note) console.error(formatInfo(policy.note));

  const env = args.env ?? "local";
  const routedAway = member ? await routing(ctx, stage, projectPath, member, base, forge) : undefined;
  if (routedAway) console.error(formatInfo(routedAway));
  // ws-107: the groups a capability plans and applies as one, placed in the waves every stage and wave job reads.
  let plan = derived.plan;
  if (!routedAway && plan.order.length > 0) {
    try {
      plan = groupFanOut(plan, derived.components, await findComponentGroups({ components: derived.components, plan, registry, env }));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    config,
    env,
    ...(member ? { member } : {}),
    base,
    head,
    gate: args.gate ?? PR_APPLY_GATE,
    ...(forge ? { forge } : {}),
    components: derived.components,
    plan: routedAway ? { ...derived.plan, order: [], waves: [], seeds: [], indeterminate: [] } : plan,
    signal: derived.signal,
    ...(derived.sites ? { sites: derived.sites } : {}),
    registry,
    seededOutputs,
    hooks,
    hookOutcomes: [],
    ...(routedAway ? { routedAway } : {}),
    policy,
  };
}

/** Set where `p`'s hooks run, once the stage knows its op (#4288). */
export function placeHooks(ctx: CommandContext, p: Prepared, stage: PrHookPlace["stage"], op: string): void {
  p.hookPlace = { op, env: p.env, stage, dir: ctx.args.output ?? PR_REPORT_DIR, cwd: resolve("."), log: (line) => console.error(line) };
}

/**
 * Run one moment's hooks for `components` (#4288), keeping their outcomes
 * for the report. Returns the failure as the report's message, or undefined
 * when no hook failed. A hold is logged: the pull request's gate already
 * waits for a person's approval of the digest.
 */
export async function runStageHook(
  p: Prepared,
  moment: OpWaveHookMoment,
  components: readonly string[],
  planned?: PrPlanSet,
  what = "nothing was applied",
  env?: Record<string, string>,
): Promise<string | undefined> {
  if (!p.hookPlace || components.length === 0) return undefined;
  const ran = await runPrHooks(p.hooks, moment, p.hookPlace, components, planned ? { members: planned.members, plans: planned.plans } : undefined, {
    ...(env ? { env } : {}),
    settle: (hold) => settleHeldGate(p, hold),
  });
  p.hookOutcomes.push(...ran.outcomes);
  for (const hold of ran.holds) console.error(formatInfo(`${hold} held, and the pull request's gate asks for an approval of the digest either way`));
  if (!ran.failed) return undefined;
  p.hookFailed = `The ${ran.failed}, so ${what}.`;
  return p.hookFailed;
}

/**
 * Settle a hook's hold on another gate (#4323), the way an Op waves job does:
 * an approval of that gate and digest under its `identity.gates` rule read at
 * base, else a pending fact for it. The plan stage writes nothing, so there
 * it only reads.
 */
async function settleHeldGate(p: Prepared, hold: OtherGateHold): Promise<PrHoldSettled> {
  const real = gitGateLedgerPort();
  const ledger = p.hookPlace?.stage === "plan" ? readOnlyLedger(real) : real;
  const port: GateLedgerPort = ledger.approvalRule ? { ...ledger, approvalRule: (g: string) => ledger.approvalRule!(g, { base: p.base }) } : ledger;
  const op = hold.request.op ?? p.hookPlace?.op ?? "";
  const check = await evaluateGate(port, {
    op,
    gate: hold.request.gate,
    planDigest: hold.request.digest,
    description: hold.request.description ?? `${hold.label} holds the pull request on it`,
    fields: { ...hold.request.pending, approvalMode: "ledger", heldBy: { hook: hold.name, moment: hold.moment, ...(hold.target ? { target: hold.target } : {}) } },
  });
  if (check.satisfied) return { status: "approved", approvedBy: check.resolution.resolvedBy, approvedAt: check.resolution.timestamp };
  for (const { resolution: r, reason } of check.refused ?? []) console.error(formatInfo(`${op} / ${hold.request.gate}: the approval by ${r.resolvedBy} at ${r.timestamp} does not count: ${reason}`));
  return { status: "waiting" };
}

/**
 * Run the `after-gate` hooks once the pull request's gate decided (#4323),
 * whatever it decided. `CHANT_GATE_STATUS` is `approved`, or `waiting` when no
 * approval of the digest stands; `CHANT_GATE_OP`, `CHANT_GATE` and
 * `CHANT_GATE_DIGEST` name the gate. Returns the failure message, as
 * {@link runStageHook} does; the caller ignores it when the gate did not let
 * the apply through, since the stage ends there anyway.
 */
export function runGateHook(p: Prepared, at: { op: string; digest: string; satisfied: boolean }, components: readonly string[]): Promise<string | undefined> {
  return runStageHook(p, "after-gate", components, undefined, "nothing was applied", {
    CHANT_GATE_STATUS: at.satisfied ? "approved" : "waiting",
    CHANT_GATE_OP: at.op,
    CHANT_GATE: p.gate,
    CHANT_GATE_DIGEST: at.digest,
  });
}

const EMPTY_SET = (): PrPlanSet => ({ doc: composeChangeSet([]), members: [], plans: {}, outputs: {}, failed: true });

/**
 * Plan with the plan-side hooks around it (#4288): before-observe and
 * before-plan, then the plan, then after-plan. A failed hook gives a failed
 * set, so the stage reports `plan-failed` and nothing applies.
 */
async function hookedPlan(p: Prepared, components: readonly string[], plan: () => Promise<PrPlanSet>): Promise<PrPlanSet> {
  if (await runStageHook(p, "before-observe", components, undefined, "nothing was planned or applied")) return EMPTY_SET();
  if (await runStageHook(p, "before-plan", components, undefined, "nothing was planned or applied")) return EMPTY_SET();
  const set = await plan();
  if (set.failed) return set;
  if (await runStageHook(p, "after-plan", components, set)) return { ...set, failed: true };
  return set;
}

/**
 * Whether `ci.branches` or `ci.labels` (#4292), read from the declaration at
 * base, leave `member` out of this stage: the reason, or undefined when the
 * member runs. The record and apply stages read `ci.branches` against the
 * pushed branch (`--branch`, else the forge's variables); the plan stage
 * reads `ci.labels` against the pull request's labels. A label only narrows
 * what is planned: the record and apply stages never read labels.
 */
async function routing(ctx: CommandContext, stage: "plan" | "apply" | "record", projectPath: string, member: string, base: string, forge: PrForge | undefined): Promise<string | undefined> {
  const { scopeSource } = await import("../../workspace/write-scope");
  const { appliesFrom, plansUnderLabels, pushedBranchFromEnv } = await import("../../workspace/ci-branches");
  const ci = scopeSource(projectPath, base).declaration?.ci;
  if (stage !== "plan") {
    if (!ci?.branches) return undefined;
    const pushed = ctx.args.branch ?? pushedBranchFromEnv();
    if (!pushed) return undefined;
    const route = appliesFrom(ci.branches, member, pushed);
    if (!route.applies) return route.note;
    console.error(formatInfo(route.note));
    return undefined;
  }
  if (!ci?.labels || ctx.args.pr === undefined || !forge?.labels) return undefined;
  let carried: string[];
  try {
    carried = await forge.labels(ctx.args.pr);
  } catch (err) {
    console.error(formatWarning({ message: `could not read the labels of #${ctx.args.pr}, so every member plans: ${err instanceof Error ? err.message : String(err)}` }));
    return undefined;
  }
  const filter = plansUnderLabels(ci.labels, member, carried);
  if (!filter.plans) return filter.note;
  if (filter.note) console.error(formatInfo(filter.note));
  return undefined;
}

/**
 * The one `--member` name, checked against the workspace member that owns
 * `projectPath`: a pipeline copied into another member would otherwise
 * record its gate under the wrong name.
 */
async function checkMember(projectPath: string, names: string[]): Promise<string | { error: string; hint?: string }> {
  if (names.length !== 1) return { error: `pr-plan and pr-apply take one --member, not ${names.join(", ")}` };
  const name = names[0];
  const found = findWorkspaceRoot(projectPath);
  if (!found) return { error: `--member ${name}: no chant.workspace.json above ${projectPath}`, hint: "Drop --member outside a workspace." };
  const { resolveMemberContext } = await import("../../workspace/member-pipeline");
  let owner: string | undefined;
  try {
    owner = resolveMemberContext(projectPath, found)?.member.name;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (owner !== name) {
    return {
      error: `--member ${name}: ${owner ? `this directory belongs to member ${owner}` : "no workspace member owns this directory"}`,
      hint: "Run the command in the member's directory, the way its generated pipeline does.",
    };
  }
  return name;
}

/** Plan every member the derivation selects, between the plan-side hooks (#4288). */
export function planAll(p: Prepared, onRunEvent?: RunEventSink): Promise<PrPlanSet> {
  return hookedPlan(p, p.plan.order, () => planBare(p, onRunEvent));
}

export async function planBare(p: Prepared, onRunEvent?: RunEventSink): Promise<PrPlanSet> {
  const lockGrain = await declaredLockGrainOf(p);
  return planPrSet({
    components: p.components,
    plan: p.plan,
    registry: p.registry,
    env: p.env,
    seededOutputs: p.seededOutputs,
    ...(lockGrain ? { lockGrain } : {}),
    // #4613: a step's own policy engine (CrossGuard) reads its packs at the base, as ci.policy is.
    policyBase: p.base,
    ...(onRunEvent ? { onRunEvent } : {}),
    ...(p.targets ? { targets: p.targets } : {}),
    ...(p.parallelism !== undefined ? { parallelism: p.parallelism } : {}),
    ...(p.refresh ? { refresh: true } : {}),
    ...(p.targetDependents ? { targetDependents: true } : {}),
  });
}

/**
 * `pr-plan --refresh` and `--target-dependents` (#4627), from the line or
 * the preview comment: set on `p`, or the exit code when a planned member's
 * capability cannot honour one, named before anything plans, as
 * {@link narrowToTargets} does for targets. `--target-dependents` needs a
 * target.
 */
function planWithFlags(p: Prepared, flags: { refresh?: boolean; targetDependents?: boolean }): number | undefined {
  if (!flags.refresh && !flags.targetDependents) return undefined;
  if (flags.targetDependents && !p.targets) return fail("--target-dependents widens a --target to what depends on it, and nothing was narrowed", "Give --target <address> with it.");
  const byName = new Map(p.components.map((c) => [c.name, c]));
  for (const name of p.plan.order) {
    const component = byName.get(name);
    if (!component) continue;
    try {
      assertPlanFlagsAccepted(component, p.registry, { ...(flags.refresh ? { refresh: true } : {}), ...(flags.targetDependents && p.targets?.[name] ? { targetDependents: true } : {}) });
    } catch (err) {
      if (err instanceof PlanFlagRefusedError) return fail(`${err.message}, so nothing was planned`, `Drop ${PLAN_FLAG_ARGS[err.flag]}, or plan only members whose steps take it.`);
      throw err;
    }
  }
  if (flags.refresh) p.refresh = true;
  if (flags.targetDependents) p.targetDependents = true;
  console.error(formatInfo(`planning with ${[flags.refresh ? "--refresh" : "", flags.targetDependents ? "--target-dependents" : ""].filter(Boolean).join(" and ")}`));
  return undefined;
}

/**
 * `pr-plan --comment-targets` (#4626): the `--target` addresses of the
 * preview comment in {@link PREVIEW_COMMENT_ENV}, read with the product's
 * grammar, or the exit code when the comment is refused. No comment, or one
 * with no target: none. The checks `--target` makes follow in
 * {@link narrowToTargets}.
 */
function commentTargets(env: NodeJS.ProcessEnv = process.env): { targets: string[]; refresh?: true; targetDependents?: true } | number {
  const body = env[PREVIEW_COMMENT_ENV];
  if (body === undefined || body.trim() === "") return { targets: [] };
  const words = activeProductWords();
  const parsed = parseProductComment(words, body, env);
  if (parsed === undefined) return { targets: [] };
  if (parsed.kind === "refused") return fail(`the preview comment is refused: ${parsed.reason}, so nothing was planned`, `/${words.product} ${commandWord(words, "plan") ?? "plan"} --target <address> narrows the preview to the address.`);
  if (parsed.kind !== "plan") return { targets: [] };
  // #4627: the comment's --refresh and --target-dependents too.
  return { targets: parsed.targets ?? [], ...(parsed.refresh ? { refresh: true as const } : {}), ...(parsed.targetDependents ? { targetDependents: true as const } : {}) };
}

/**
 * `pr-plan --target` (#4620): the addresses by member, set on `p`, or the
 * exit code when a value is refused or a targeted member has a capability
 * that cannot narrow, which is named before anything plans.
 */
function narrowToTargets(p: Prepared, values: readonly string[] | undefined): number | undefined {
  if (!values || values.length === 0) return undefined;
  const resolved = prPlanTargets(values, p.plan.order, new Set(p.components.map((c) => c.name)));
  if ("error" in resolved) return fail(resolved.error, "--target <address> narrows every member the pull request plans; --target <member>:<address> narrows one.");
  const { targets } = resolved;
  const byName = new Map(p.components.map((c) => [c.name, c]));
  for (const [name, addresses] of Object.entries(targets)) {
    try {
      assertTargetsAccepted(byName.get(name)!, p.registry, { targets: addresses });
    } catch (err) {
      if (err instanceof TargetsRefusedError) return fail(`${err.message}, so nothing was planned`, "Drop --target, or name a member whose steps can narrow: --target <member>:<address>.");
      throw err;
    }
  }
  p.targets = targets;
  console.error(formatInfo(`narrowed to ${Object.entries(targets).map(([name, a]) => `${name}: ${a.join(", ")}`).join("; ") || "nothing planned"}`));
  return undefined;
}

/**
 * `ci.lockGrain` of the stage's member (#4552), read from the declaration at
 * base like `ci.locks`, so a change cannot pick its own grain. Undefined when
 * none is declared: each member then takes its lexicon's default.
 */
async function declaredLockGrainOf(p: Pick<Prepared, "base" | "member">): Promise<LockGrain | undefined> {
  const { ciLockGrainAt } = await import("../../workspace/ci-lock-grain");
  return ciLockGrainAt(process.cwd(), p.base, p.member) ?? undefined;
}

/**
 * Lease the rows a set's members on the resource grain change (#4552),
 * before anything applies: the refusal naming the run that holds one, the
 * exit code when the rows file could not be written, or the lease to let go
 * of once the apply ends (one that holds nothing when no member is on the
 * resource grain).
 */
async function leaseSetRows(p: Prepared, set: Pick<PrPlanSet, "locks">): Promise<{ release(): Promise<boolean> } | { held: string } | number> {
  const leased = await leaseRowsOf(p, set);
  return "failed" in leased ? fail(leased.failed) : leased;
}

/**
 * {@link leaseSetRows} without printing a failure (#4594), for a later round
 * of `applyPrSet` (`leaseRound`), which records it on the round, and for a
 * pull request environment's apply, which reports it.
 */
export async function leaseRowsOf(p: Pick<Prepared, "gate">, set: Pick<PrPlanSet, "locks">, label = "this apply"): Promise<{ release(): Promise<boolean> } | { held: string } | { failed: string }> {
  const rows = leaseRowsOfLocks(set.locks);
  // The ruling for ci-products (2026-10-28): the target and repo grains wait for their rows first, oldest commit first.
  const queue = queueRowsOfLocks(set.locks);
  if (rows.length === 0 && queue.length === 0) return { release: () => Promise.resolve(true) };
  const { commitTimeOf, leaseLockRows, lockPollMs, lockWaitSeconds } = await import("../../lifecycle/resource-lock");
  const held: Array<{ release(): Promise<boolean> }> = [];
  const releaseAll = async () => {
    let ok = true;
    for (const l of held.reverse()) ok = (await l.release()) && ok;
    return ok;
  };
  for (const [wanted, wait] of [[queue, true], [rows, false]] as const) {
    if (wanted.length === 0) continue;
    let leased;
    try {
      const commitAt = wait ? await commitTimeOf(process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA || "HEAD") : undefined;
      leased = await leaseLockRows(
        p.gate,
        wanted,
        wait
          ? { wait: { deadline: Date.now() + lockWaitSeconds(process.env) * 1000, pollMs: lockPollMs(process.env), log: (line) => console.error(formatInfo(`${label} ${line}`)), ...(commitAt ? { commitAt } : {}) } }
          : {},
      );
    } catch (err) {
      await releaseAll();
      return { failed: `could not hold the rows ${label} changes in ${p.gate}, so nothing of it was applied: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!leased.ok) {
      await releaseAll();
      if (leased.timedOut) return { held: `LockWaitTimeoutError: ${leased.message}, so nothing of ${label} was applied.` };
      return { held: `${leased.message}, so nothing of ${label} was applied. Apply again once that run ends; a run that is gone, or whose lease is older than CHANT_LOCK_STALE seconds, is taken over.` };
    }
    for (const h of leased.tookOver) console.error(formatInfo(`took over the rows of run ${h.run}, which is gone`));
    console.error(formatInfo(`${label} holds ${leased.lease.keys.length} row${leased.lease.keys.length === 1 ? "" : "s"} of ${p.gate}${leased.waited ? ` after waiting ${leased.waitedSeconds ?? 0}s` : ""} while it applies`));
    held.push(leased.lease);
  }
  return { release: releaseAll };
}

/** `applyPrSet`'s `leaseRound` (#4594): a round after the first leases the rows its own plan locks. */
export function leaseRoundRows(p: Pick<Prepared, "gate">): NonNullable<Parameters<typeof applyPrSet>[0]["leaseRound"]> {
  return ({ round, set }) => leaseRowsOf(p, set, `round ${round}`);
}

/**
 * How a stage's report settles its run's events (#4041): a refusal waits on
 * a person, as a gate does, and exits the same way.
 */
function settleOf(status: PrReport["status"]): RunEventSettleStatus {
  switch (status) {
    case "nothing":
    case "planned":
    case "recorded":
    case "applied":
      return "ok";
    case "refused":
    case "waiting":
      return "gated";
    default:
      return "failed";
  }
}

/** Write the report, the change set and the note, and hand the first two to `--report-url`'s upload. */
function writeOutputs(ctx: CommandContext, report: PrReport, note: string, upload?: PrReportUpload): void {
  const dir = resolve(ctx.args.output ?? PR_REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  const files: Array<[string, string]> = [
    [`pr-${report.stage}.json`, JSON.stringify(report, null, 2) + "\n"],
    ["change-set.json", JSON.stringify(report.changeSet, null, 2) + "\n"],
  ];
  for (const [name, body] of files) {
    writeFileSync(join(dir, name), body);
    upload?.file(name, body);
  }
  writeFileSync(join(dir, "pr-note.md"), note);
}

/** Post the note and the stage's status. A forge that refuses is a warning: the stage's outcome stands. */
async function publish(forge: PrForge | undefined, report: PrReport, note: string): Promise<void> {
  if (!forge) return;
  const status = {
    context: prStatusContext(report.stage, report.member),
    state: prStatusState(report),
    description: prStatusDescription(report),
    ...(forge.runUrl ? { url: forge.runUrl } : {}),
  };
  try {
    await forge.setStatus(report.head, status);
  } catch (err) {
    console.error(formatWarning({ message: `could not set the ${status.context} status: ${err instanceof Error ? err.message : String(err)}` }));
  }
  if (report.pr === null) return;
  // A member the change does not reach has nothing to say: one note per
  // member would put a line on every pull request for each member it skips.
  if (report.member && report.status === "nothing" && !report.overdue?.length && !report.migrations?.length) return;
  try {
    await upsertPlanNote(forge, report.pr, prNoteMarker(report.env, report.member), note);
  } catch (err) {
    console.error(formatWarning({ message: `could not post the note on #${report.pr}: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

function noteFor(report: PrReport, forge: PrForge | undefined): string {
  return renderPrNote(report, {
    limit: forge?.kind === "gitlab" ? GITLAB_NOTE_LIMIT : GITHUB_COMMENT_LIMIT,
    approver: forge ? forgePrincipalOf(forge.kind, forge.host, "<your-login>") : "<you>",
  });
}

function printMembers(report: PrReport): void {
  for (const m of report.members) {
    const c = m.counts;
    console.error(`  ${m.member.padEnd(20)} ${m.status.padEnd(12)} create ${c.create} update ${c.update} replace ${c.replace} delete ${c.delete}${m.error ? `  ${m.error}` : ""}`);
  }
}

async function finish(ctx: CommandContext, p: Prepared, report: PrReport, upload?: PrReportUpload): Promise<void> {
  // #4288: the hooks the stage ran, and a failed hook's message in place of the stage's own.
  if (p.hookOutcomes.length > 0) report = { ...report, hooks: [...p.hookOutcomes] };
  if (p.hookFailed) report = { ...report, message: p.hookFailed };
  if (p.routedAway && report.status === "nothing" && !report.message) report = { ...report, message: p.routedAway };
  if (p.policyReport) report = { ...report, policy: p.policyReport };
  if (p.beforeMerge) report = { ...report, beforeMerge: p.beforeMerge };
  // #4617: with a checkout of the control repo named, its entries and apply records mark the cross-stack edges.
  if (report.crossStackEdges?.length && process.env.CHANT_CONTROL_DIR) {
    const { controlEdgeFactsFromEnv, remarkCrossStackEdges } = await import("../../control/edges");
    report = remarkCrossStackEdges(report, await controlEdgeFactsFromEnv());
  }
  // #4573: each member's section its lexicon renders from its own part of the change set.
  const details = await memberDetails(p, report);
  if (details.length > 0) report = { ...report, details };
  const note = noteFor(report, p.forge);
  writeOutputs(ctx, report, note, upload);
  if (!ctx.args.noStatus) await publish(p.forge, report, note);
  if (ctx.args.json) console.log(JSON.stringify(report, null, 2));
}

/**
 * A stage's stream and its `--report-url` upload, held so that a stage that
 * returns or throws before it settles still ends the stream and uploads.
 */
interface StageEvents {
  stream?: RunEventStream;
  /** Where `--report-url` points, read before the stage starts. */
  target?: ReportTarget;
  upload?: PrReportUpload;
}

/** Run a stage, end its stream as `failed` when the stage did not settle it, and finish its upload. */
async function withStageEvents(stage: string, ctx: CommandContext, run: (events: StageEvents) => Promise<number>): Promise<number> {
  const events: StageEvents = {};
  if (ctx.args.reportUrl !== undefined) {
    const target = parseReportUrl(ctx.args.reportUrl);
    if ("error" in target) return fail(target.error);
    events.target = target;
  }
  try {
    return await run(events);
  } catch (err) {
    events.stream?.settle("failed", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    events.stream?.settle("failed", `${stage} stopped before it finished`);
    if (events.upload) {
      await events.upload.close();
      console.error(formatInfo(`report  : ${events.upload.where}/`));
    }
  }
}

/**
 * Open the stage's `--report-url` upload under its pull request and commit,
 * when the flag was given. Its events are the lines `openCliRunEvents` writes.
 */
function openUpload(events: StageEvents, stage: "plan" | "apply" | "record", pr: number | null, p: Prepared): PrReportUpload | undefined {
  if (!events.target) return undefined;
  events.upload = openPrReportUpload({
    target: events.target,
    key: reportKey(pr, p.head, p.member),
    stage,
    warn: (message) => console.error(formatWarning({ message })),
  });
  return events.upload;
}

/** What the policy step decided (#4294): a stop, or whether the plan is held and the override it applies under. */
interface PolicyJudged {
  stop?: { refusal: "policy-denied" | "policy-error"; message: string; code: number };
  held: boolean;
  override?: NonNullable<PrPolicyReport["override"]>;
}

/**
 * Run `ci.policy` at base over the planned set (#4294) and keep what it said
 * on `p` for the report. A denial is decided against the override ledger:
 * read only at the plan stage, and recorded for an override at the apply.
 */
async function judgePolicy(p: Prepared, at: { stage: "plan" | "apply"; op: string; pr: number | null; set: PrPlanSet }): Promise<PolicyJudged> {
  // The review is read only when a policy will run: a workspace with no policy makes no forge call for it.
  const review = p.policy.settings ? await policyReviewOf(p.forge, at.pr) : undefined;
  const verdict = runPrPolicy(p.policy, { version: 1, stage: at.stage, op: at.op, gate: p.gate, env: p.env, pr: at.pr, base: p.base, head: p.head, changeSet: at.set.doc, ...(review ? { review } : {}) });
  if (!verdict) return { held: false };
  const report = prPolicyReport(verdict, p.policy.base);
  p.policyReport = report;
  for (const w of verdict.warnings) console.error(formatWarning({ message: `policy warning: ${w}` }));
  if (verdict.result === "error") {
    return { held: false, stop: { refusal: "policy-error", code: 1, message: `The policy at ${p.policy.base.slice(0, 12)} could not be checked, so nothing was applied: ${verdict.error}` } };
  }
  const held = verdict.holds.length > 0;
  for (const h of verdict.holds) console.error(formatInfo(`policy holds the plan for a person's approval (${h.rule}): ${h.message}`));
  if (verdict.result !== "denied") return { held };
  const denied = verdict.denials.map((d) => `${d.rule}: ${d.message}`).join("; ");
  let decided: Awaited<ReturnType<typeof decidePrPolicyOverride>>;
  try {
    // The plan stage records nothing, and reads the applied records so a spent override reads as spent.
    const real = gitGateLedgerPort();
    const port = at.stage === "plan" ? { ...readOnlyLedger(real), ...(real.readApplied ? { readApplied: real.readApplied.bind(real) } : {}) } : real;
    decided = await decidePrPolicyOverride({
      port,
      subject: at.op,
      digest: at.set.doc.digest,
      rules: verdict.rules,
      base: p.base,
      cwd: resolve("."),
      sealed: await gateIsSealed(p.gate),
      record: at.stage === "apply",
      description: `${at.op}: plan ${at.set.doc.digest} denied by ${verdict.rules.join(", ")}`,
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (at.stage === "plan") {
      console.error(formatWarning({ message: `could not read the override ledger, so no override reads as standing: ${why}` }));
      return { held, stop: { refusal: "policy-denied", code: CHANT_EXIT.denied, message: `The policy denied this plan: ${denied}.` } };
    }
    return { held, stop: { refusal: "policy-denied", code: CHANT_EXIT.denied, message: `The policy denied this plan (${denied}), and the override ledger could not be read or written: ${why}. Nothing was applied.` } };
  }
  if (decided.status === "overridden") {
    report.override = decided.override;
    console.error(formatInfo(`the policy denial (${verdict.rules.join(", ")}) is overridden by ${decided.override.by} at ${decided.override.at}: ${decided.override.reason}`));
    return { held, override: decided.override };
  }
  report.overrideCommand = decided.command;
  for (const why of decided.refusals) console.error(formatInfo(`an override does not count: ${why}`));
  const who = decided.overriders.length ? `${decided.overriders.join(", ")} may` : "nobody listed in .chant/overriders at base may";
  const moved = decided.moved ? ` ${decided.moved.by} overrode an earlier plan or other rules, which counts for nothing here.` : "";
  return {
    held,
    stop: {
      refusal: "policy-denied",
      code: CHANT_EXIT.denied,
      message: `The policy denied this plan: ${denied}.${moved} Nothing was applied. ${who} override it: ${decided.command}`,
    },
  };
}

/** Spend the override the apply runs under (#4294), before anything applies. The failure's message, or undefined. */
async function spendPolicy(op: string, judged: PolicyJudged, head: string): Promise<string | undefined> {
  if (!judged.override) return undefined;
  try {
    await spendPrPolicyOverride(gitGateLedgerPort(), op, judged.override, { commit: head });
  } catch (err) {
    return `Could not record the override this apply runs under, so nothing was applied: ${err instanceof Error ? err.message : String(err)}`;
  }
  console.error(formatInfo(`applies under the override by ${judged.override.by}, which is now spent`));
  return undefined;
}

/** chant components pr-plan --base <ref> --pr <n> [--env <env>] [--gate <name>] [--forge <kind>] [--output <dir>] [--json] [--events-json] [--report-url <url>] */
export function runComponentsPrPlan(ctx: CommandContext): Promise<number> {
  if (refusesEventsWithJson(ctx.args, "the stage's report")) return Promise.resolve(1);
  return withStageEvents("pr-plan", ctx, (events) => withComponentEndpoint(ctx, () => prPlan(ctx, events)));
}

async function prPlan(ctx: CommandContext, stage: StageEvents): Promise<number> {
  if (ctx.args.pr === undefined) {
    return fail("pr-plan needs the pull or merge request: --pr <n>", "Its approval is recorded under op pr-<n>, so one pull request's approval never answers another's.");
  }
  const p = await prepare(ctx, "plan");
  if (typeof p === "number") return p;
  // #4626: the preview comment's --target addresses, read from the comment the job carries in a variable.
  const fromComment = ctx.args.commentTargets ? commentTargets() : { targets: [] };
  if (typeof fromComment === "number") return fromComment;
  const narrowed = narrowToTargets(p, [...(ctx.args.targets ?? []), ...fromComment.targets]);
  if (narrowed !== undefined) return narrowed;
  const flagged = planWithFlags(p, { refresh: ctx.args.refresh === true || fromComment.refresh === true, targetDependents: ctx.args.targetDependents === true || fromComment.targetDependents === true });
  if (flagged !== undefined) return flagged;
  if (ctx.args.parallelism !== undefined) p.parallelism = ctx.args.parallelism;
  const op = prOp(ctx.args.pr, p.member);
  placeHooks(ctx, p, "plan", op);
  const upload = openUpload(stage, "plan", ctx.args.pr, p);
  // `--events-json` (#4041): planning, then where the approval stands.
  const events = await openCliRunEvents(ctx.args, { kind: "component", name: `pr-plan ${op}`, cwd: resolve(".") }, upload?.line);
  stage.stream = events;
  events?.emit({ type: "run-start", waves: p.plan.waves });
  const set = await planAll(p, events?.emit);
  // #4294: the policy at base over the planned change set.
  const judged = p.plan.order.length > 0 && !set.failed ? await judgePolicy(p, { stage: "plan", op, pr: ctx.args.pr, set }) : { held: false };

  let approval: PrApproval = { status: "pending" };
  if (p.plan.order.length > 0) {
    try {
      const check = await emitGateStep(events?.emit, { op, gate: p.gate }, () =>
        decidePrGate(readOnlyLedger(gitGateLedgerPort()), { op, gate: p.gate, digest: set.doc.digest }),
      );
      approval = approvalOf(check);
    } catch (err) {
      console.error(formatWarning({ message: `could not read the gate ledger, so the approval reads as pending: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }
  const status = p.plan.order.length === 0 ? "nothing" : set.failed ? "plan-failed" : "planned";
  const overdue = await overdueOps(p.forge, p.member);
  const migrations = await newMigrations(p);
  const planned = prReport({
    stage: "plan",
    ...(migrations.length > 0 ? { migrations } : {}),
    pr: ctx.args.pr,
    env: p.env,
    ...(p.member ? { member: p.member } : {}),
    base: p.base,
    head: p.head,
    op,
    gate: p.gate,
    plan: p.plan,
    signal: p.signal,
    set,
    approval,
    status,
    ...(ctx.args.waveGate ? { waveGate: ctx.args.waveGate } : {}),
  });
  const report: PrReport = overdue.length > 0 ? { ...planned, overdue } : planned;
  await finish(ctx, p, report, upload);
  // The plan stage settles on its planning: an approval still to come is what it reports, not a stop.
  events?.settle(settleOf(status), status === "plan-failed" ? "a member failed to plan" : undefined);

  console.error(formatInfo(`pr-plan: ${report.members.length} member(s), ${status}`));
  printMembers(report);
  if (status === "planned") {
    console.error(formatInfo(`plan    : ${report.digest}`));
    console.error(formatInfo(approval.status === "approved" ? `approved by ${(approval.approvedBy ?? []).join(", ")}` : `approve : ${prApproveCommands(report).join("; ")}`));
  }
  if (judged.stop) console.error(formatWarning({ message: judged.stop.message }));
  // #4550: a capability's policy denial (pulumi-up's CrossGuard) exits as a denial, 7, not as a failed plan.
  if (status === "plan-failed" && set.policyDenied) return CHANT_EXIT.denied;
  return status === "plan-failed" ? CHANT_EXIT.failed : judged.stop ? judged.stop.code : CHANT_EXIT.done;
}

/**
 * The member detail sections (#4573): each lexicon the project lists that
 * renders one (`prNoteDetail`) gets each member's part of the change set. A
 * lexicon that cannot load, or throws, leaves the note as it was.
 */
async function memberDetails(p: Prepared, report: PrReport): Promise<PrMemberDetail[]> {
  if (report.changeSet.members.length === 0) return [];
  const { loadPlugin } = await import("../plugins");
  const out: PrMemberDetail[] = [];
  for (const name of lexiconNames(p.config.lexicons ?? [])) {
    let plugin: Awaited<ReturnType<typeof loadPlugin>>;
    try {
      plugin = await loadPlugin(name);
    } catch {
      continue;
    }
    if (!plugin.prNoteDetail) continue;
    for (const member of report.changeSet.members) {
      try {
        const detail = await plugin.prNoteDetail({ member: member.member, changeSet: report.changeSet, stage: report.stage });
        if (detail && detail.lines.length > 0) out.push({ member: member.member, ...(detail.title ? { title: detail.title } : {}), lines: detail.lines });
      } catch (err) {
        console.error(formatWarning({ message: `the ${name} lexicon could not render ${member.member}'s detail: ${err instanceof Error ? err.message : String(err)}` }));
      }
    }
  }
  return out;
}

/**
 * The migration files the pull request adds in a migration-directory member
 * (#4407), each statement classified offline by the sql lexicon. Nothing is
 * applied and no server is contacted. A workspace without such a member, or
 * a classifier that cannot load, leaves the note as it was.
 */
async function newMigrations(p: Prepared): Promise<PrMigrationFile[]> {
  const { newMigrationFilesBetween } = await import("../../workspace/new-migrations");
  try {
    return await newMigrationFilesBetween(resolve("."), p.base, p.head, {
      ...(p.member ? { member: p.member } : {}),
      plugins: async () => {
        const { loadPlugin } = await import("../plugins");
        const names = ["sql", ...lexiconNames(p.config.lexicons ?? []).filter((n) => n !== "sql")];
        const loaded = [];
        for (const name of names) {
          try {
            const plugin = await loadPlugin(name);
            if (plugin.classifyMigrations) loaded.push(plugin);
            if (loaded.length > 0) break;
          } catch {
            // not installed: the next name, or the note says no lexicon classifies the dialect
          }
        }
        return loaded;
      },
    });
  } catch (err) {
    console.error(formatWarning({ message: `could not classify the new migration files: ${err instanceof Error ? err.message : String(err)}` }));
    return [];
  }
}

/**
 * The scheduled watch and reconcile Ops that stopped running (#4289,
 * `op/schedule-overdue.ts`), asked of the forge. Without a forge, or when
 * the Ops cannot be read, nothing is checked and the plan goes on. The
 * generated plan holds no forge token (#4295), so there the plan-note job's
 * `pr-post` asks instead, reading the Ops at the target branch's commit.
 */
async function overdueOps(forge: PrForge | undefined, member: string | undefined): Promise<PrOverdue[]> {
  const { overdueOpsAt } = await import("../../op/schedule-overdue");
  return overdueOpsAt({ forge, cwd: resolve("."), ...(member ? { member } : {}), log: (line) => console.error(formatWarning({ message: line })) });
}

/** chant components pr-apply --base <ref> [--pr <n>] [--env <env>] [--gate <name>] [--forge <kind>] [--require-review] [--before-merge [--requires <list>]] [--output <dir>] [--json] [--events-json] [--report-url <url>] */
export function runComponentsPrApply(ctx: CommandContext): Promise<number> {
  if (refusesEventsWithJson(ctx.args, "the stage's report")) return Promise.resolve(1);
  return withStageEvents("pr-apply", ctx, async (events) => {
    // #4301: an apply before merge asks the forge its requires checks before any of the head's code loads, the config included.
    let beforeMerge: PrBeforeMerge | undefined;
    if (ctx.args.requires && !ctx.args.beforeMerge) return fail("--requires names the checks of an apply before merge, so it needs --before-merge --pr <n>");
    // #4636: the merge after the update, checked before anything applies.
    const mergeProblem = await mergeArgsProblem(ctx.args);
    if (mergeProblem) return fail(mergeProblem);
    if (ctx.args.beforeMerge) {
      const checked = await beforeMergeChecks(ctx);
      if (typeof checked === "number") return checked;
      beforeMerge = checked;
    }
    return withComponentEndpoint(ctx, () => prApply(ctx, events, beforeMerge));
  });
}

async function prApply(ctx: CommandContext, stage: StageEvents, beforeMerge?: PrBeforeMerge): Promise<number> {
  // #4168: the review-rules security group turns --require-review on, read from the declaration at base.
  const { securityGroupsAt } = await import("../../workspace/security");
  const reviewRules = !ctx.args.requireReview && securityGroupsAt(process.cwd(), ctx.args.base).has("review-rules");
  if (reviewRules && !ctx.args.forge) return fail("the workspace opts into review-rules, which reads the pull request's reviews, so pr-apply needs --forge <kind>");
  if (reviewRules) ctx = { ...ctx, args: { ...ctx.args, requireReview: true } };
  // #4293: ci.locks, read at base like the security groups, so the change cannot turn its own locks off.
  const { ciLocksAt } = await import("../../workspace/ci-locks");
  const locks = ciLocksAt(process.cwd(), ctx.args.base);
  const { args } = ctx;
  if (args.requireReview && !args.forge) return fail("--require-review reads the pull request's reviews, so it needs --forge <kind>");
  if (args.wave !== undefined && !args.waveGate) return fail("--wave runs one wave of a --wave-gate apply, so it needs --wave-gate <name>");
  if (args.wave !== undefined && args.wave < 1) return fail(`--wave counts from 1, not ${args.wave}`);
  // #4168 step 9: apply on merge applies a green commit, measured from the one applied before it.
  let green: GreenTarget | undefined;
  if (args.green) {
    const target = await greenTargetOf(ctx);
    if (typeof target === "number") return target;
    green = target;
    ctx = { ...ctx, args: { ...ctx.args, base: green.base, head: green.commit } };
  }
  const p = await prepare(ctx, "apply");
  if (typeof p === "number") return p;
  if (beforeMerge) p.beforeMerge = beforeMerge;

  let pr: number | null = args.pr ?? null;
  if (pr === null && !green && p.forge && p.plan.order.length > 0) {
    try {
      pr = await p.forge.pullRequestFor(p.head);
    } catch (err) {
      return fail(`could not ask ${p.forge.kind} which pull request merged ${p.head}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const op = green ? greenOp(green.commit, p.member) : pr === null ? "pr-unknown" : prOp(pr, p.member);
  placeHooks(ctx, p, "apply", op);
  // The run id the release records carry, chosen before the run so that
  // `--events-json` (#4041, #4007) names the run by it too.
  const release = autoReleaseRun(`${op}-${Date.now()}`);
  const upload = openUpload(stage, "apply", pr, p);
  const events = await openCliRunEvents(args, { kind: "component", name: `pr-apply ${op}`, runId: release.runId, cwd: resolve(".") }, upload?.line);
  stage.stream = events;
  events?.emit({ type: "run-start", waves: p.plan.waves });
  if (locks && p.plan.order.length > 0) {
    const held = await heldLocksOf(p, pr);
    if (typeof held === "number") return held;
    if (held) {
      const set: PrPlanSet = { doc: composeChangeSet([]), members: [], plans: {}, outputs: {}, failed: false };
      return stopper(ctx, p, events, upload)(
        prReport({ stage: "apply", pr, env: p.env, ...(p.member ? { member: p.member } : {}), base: p.base, head: p.head, op, gate: p.gate, plan: p.plan, signal: p.signal, set, approval: { status: "pending" }, status: "refused", refusal: "locked", message: held }),
        CHANT_EXIT.held,
      );
    }
  }
  if (args.waveGate) return prApplyWaves(ctx, p, { pr, op, release, upload, events, ...(green ? { green } : {}) });

  // `--resume` (#3464): an earlier attempt at this change on this commit
  // applied part of an approved set. When the members left are covered by
  // it and its approval still stands, finish it under that approval.
  const resumePath = args.resume ? resolve(args.resume) : undefined;
  let attempt: FanOutAttempt | undefined;
  if (resumePath) {
    try {
      attempt = readFanOutAttempt(resumePath);
    } catch (err) {
      return fail(`--resume: could not read "${args.resume}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // What each component would apply now (#4081): progress carries only where it is unchanged.
  const inputsNow = resumePath ? componentInputDigests(p.components, { projectRoot: resolve("."), env: p.env }) : {};
  const resumed = pr !== null && p.plan.order.length > 0 && attempt ? await tryResume(p, attempt, args.resume!, op, inputsNow) : undefined;

  // The components an earlier attempt applied settle first (#4007), each in
  // the wave the derivation gave it, which is the run-start's.
  const log = applyLog();
  if (resumed) {
    const waveOf = new Map(p.plan.waves.flatMap((wave, i) => wave.map((name) => [name, i + 1] as const)));
    for (const component of p.plan.order.filter((name) => resumed.completed.includes(name))) {
      const body: RunEventComponentSettle = { type: "component-settle", wave: waveOf.get(component)!, component, status: "already-applied" };
      events?.emit(body);
      log(body);
    }
    emitResumedGate(events, op, p.gate, resumed.check);
  }
  const set = resumed?.set ?? (await planAll(p, events?.emit));
  const base = { stage: "apply" as const, pr, env: p.env, ...(p.member ? { member: p.member } : {}), base: p.base, head: p.head, op, gate: p.gate, plan: p.plan, signal: p.signal, set };

  const stop = stopper(ctx, p, events, upload);

  if (p.plan.order.length === 0) {
    return stop(prReport({ ...base, approval: { status: "pending" }, status: "nothing" }), 0);
  }
  if (pr === null && !green) {
    return stop(
      prReport({
        ...base,
        approval: { status: "pending" },
        status: "refused",
        refusal: "no-pull-request",
        message: `No pull request merged ${p.head}, so no approval answers for this change. Nothing was applied. Pass --pr <n>, or land the change through a pull request.`,
      }),
      GATED_EXIT_CODE,
    );
  }
  if (set.failed) {
    return stop(
      prReport({
        ...base,
        approval: { status: "pending" },
        status: "plan-failed",
        message: set.policyDenied
          ? "The policy denied a member's plan, so nothing was applied."
          : "A member failed to plan, so there is no plan to compare with the approved one. Nothing was applied.",
      }),
      set.policyDenied ? CHANT_EXIT.denied : 1,
    );
  }

  // #4552, ruling D: on the resource grain a pull request's locks name row keys, which only the plan knows.
  const lockTargets = lockTargetsOf(p.plan.order, set.locks);
  if (locks && anyResourceGrain(set.locks)) {
    const held = await heldLocksOf(p, pr, lockTargets);
    if (typeof held === "number") return held;
    if (held) return stop(prReport({ ...base, approval: { status: "pending" }, status: "refused", refusal: "locked", message: held }), CHANT_EXIT.held);
  }

  // #4022: keep the change set the gate binds on chant/lifecycle under its
  // digest before deciding the gate, so the plan an approval bound, or the
  // one a pending fact waits on, can be read once this job is gone.
  await storeChangeSetForGate(ctx, p, set.doc);

  let approval: PrApproval;
  let via: "merges" | "gate" = "gate";
  // #4294: the policy at base, before the gate. A resume runs under the decision of the attempt it finishes.
  let judged: PolicyJudged = { held: false };
  if (resumed) {
    approval = resumed.approval;
  } else {
    judged = await judgePolicy(p, { stage: "apply", op, pr, set });
    if (judged.stop) return stop(prReport({ ...base, approval: { status: "pending" }, status: "refused", refusal: judged.stop.refusal, message: judged.stop.message }), judged.stop.code);
    const decided = await decideApplyGate(p, { op, pr, set, events, held: judged.held, ...(green ? { green } : {}) });
    approval = decided.approval;
    // #4323: the after-gate hooks hear the decision, a refusal too; only a failure that would have applied changes the outcome.
    const afterGate = await runGateHook(p, { op, digest: set.doc.digest, satisfied: decided.satisfied }, p.plan.order);
    if (afterGate && decided.satisfied) return stop(prReport({ ...base, approval, status: "failed", message: afterGate }), 1);
    if (!decided.satisfied) return stop(prReport({ ...base, approval, status: "refused", refusal: decided.refusal, message: decided.message }), decided.refusal === "plan-changed" ? CHANT_EXIT.moved : CHANT_EXIT.waiting);
    via = decided.via;
  }

  const reviewOf = reviewFor(args, p, pr, green);
  const review = await reviewOf(approval.approvedBy ?? [], "The plan");
  if (review && "error" in review) return fail(review.error);
  if (review) {
    emitReviewStop(events, review.message);
    return stop(prReport({ ...base, approval, status: "refused", refusal: review.refusal, message: review.message }), GATED_EXIT_CODE);
  }
  const unspent = await spendPolicy(op, judged, p.head);
  if (unspent) return stop(prReport({ ...base, approval, status: "refused", refusal: "policy-denied", message: unspent }), 1);
  // #4293, #4301: under ci.locks an apply before merge holds its targets until the pull request merges or closes.
  if (locks && beforeMerge && pr !== null) {
    const taken = await takeApplyLocks(p, pr, lockTargets);
    if (typeof taken === "number") return taken;
    if (taken) return stop(prReport({ ...base, approval, status: "refused", refusal: "locked", message: taken }), CHANT_EXIT.held);
  }
  // #4552: on the resource grain the apply leases the rows it changes, whatever ci.locks says, and lets go when it ends.
  const lease = await leaseSetRows(p, set);
  if (typeof lease === "number") return lease;
  if ("held" in lease) return stop(prReport({ ...base, approval, status: "refused", refusal: "locked", message: lease.held }), CHANT_EXIT.held);

  // The record is written before the first component runs and again as each
  // one settles, so a run killed partway still knows what applied.
  const prior = resumed ? { completed: resumed.completed, outputs: resumed.outputs } : { completed: [], outputs: {} };
  const completedSoFar = new Set<string>(prior.completed);
  const inputsSoFar: Record<string, string> = Object.fromEntries(
    prior.completed.filter((name) => inputsNow[name] !== undefined).map((name) => [name, inputsNow[name]!]),
  );
  const failedSoFar: string[] = [];
  const outputsSoFar: Record<string, Record<string, unknown>> = { ...prior.outputs };
  const record: PrApplyRecord = {
    op,
    gate: p.gate,
    head: p.head,
    digest: set.doc.digest,
    approvedBy: approval.approvedBy ?? [],
    members: set.members,
    changeSet: set.doc,
    planOutputs: set.outputs,
  };
  const recordAttempt = (): void => {
    if (!resumePath) return;
    writeFanOutAttempt(resumePath, {
      digest: p.plan.digest,
      completed: [...completedSoFar].sort(),
      failed: [...failedSoFar].sort(),
      outputs: outputsSoFar,
      inputs: Object.fromEntries(Object.entries(inputsSoFar).sort(([a], [b]) => a.localeCompare(b))),
      prApply: record,
    });
  };
  recordAttempt();

  // #4288: the before-apply hooks, once the gate and the review let the apply through.
  const toApply = (resumed?.plan ?? p.plan).order.filter((name) => !completedSoFar.has(name));
  const beforeFailed = await runStageHook(p, "before-apply", toApply);
  if (beforeFailed) {
    await lease.release();
    return stop(prReport({ ...base, approval, status: "failed", message: beforeFailed }), 1);
  }

  // #3999: a round planned after an upstream applied waits on a gate of its
  // own, under the same identity.gates rule and the same review checks.
  const roundLedger = gitGateLedgerPort();
  const decideRound = async ({ round, gate, set: planned }: { round: number; gate: string; set: PrPlanSet }) => {
    console.error(formatInfo(`round ${round}: ${planned.members.map((m) => m.component).filter((c, i, all) => all.indexOf(c) === i).join(", ")} planned again after an upstream applied, ${planned.doc.digest}`));
    await storeChangeSetForGate(ctx, p, planned.doc);
    const port = {
      ...roundLedger,
      ...(roundLedger.approvalRule ? { approvalRule: (g: string, at?: { base?: string }) => roundLedger.approvalRule!(g === gate ? p.gate : g, at) } : {}),
    };
    const check = await emitGateStep(events?.emit, { op, gate }, () =>
      decidePrGate(port, { op, gate, digest: planned.doc.digest, description: `${changeLabel(pr, green)}, round ${round}: planned again after an upstream applied` }),
    );
    const roundApproval = approvalOf(check);
    if (!check.satisfied) return { satisfied: false, approval: roundApproval };
    const refused = await reviewOf(roundApproval.approvedBy ?? [], `Round ${round}'s plan`);
    if (refused) {
      const message = "error" in refused ? refused.error : refused.message;
      emitReviewStop(events, message);
      return { satisfied: false, approval: roundApproval, message };
    }
    return { satisfied: true, approval: roundApproval };
  };

  const lockGrain = await declaredLockGrainOf(p);
  let applied: Awaited<ReturnType<typeof applyPrSet>>;
  try {
    applied = await applyPrSet({
      components: p.components,
      plan: resumed?.plan ?? p.plan,
      registry: p.registry,
      env: p.env,
      set,
      ...(lockGrain ? { lockGrain } : {}),
      policyBase: p.base,
      gate: p.gate,
      approval,
      decideRound,
      // #4594: a later round's plan may change rows the first did not, so it leases its own.
      leaseRound: leaseRoundRows(p),
      ...(resumed ? { resumed: prior } : {}),
      // The apply is this run's waves, so the fan-out's own run framing is
      // dropped. The log's lines go to stderr with or without --events-json.
      onRunEvent: (body: RunEventBody) => {
        events?.nested(body);
        log(body);
      },
      ...(resumePath
        ? {
            onComponentSettled: (settled, outputs) => {
              if (settled.status === "ok") {
                completedSoFar.add(settled.component);
                if (inputsNow[settled.component] !== undefined) inputsSoFar[settled.component] = inputsNow[settled.component]!;
                if (outputs) outputsSoFar[settled.component] = outputs;
              } else if (settled.status === "fail") {
                failedSoFar.push(settled.component);
              }
              recordAttempt();
            },
          }
        : {}),
    });
  } finally {
    await lease.release();
  }
  recordAttempt();
  // #4288: the after-apply hooks, for the components that applied.
  const afterFailed = await runStageHook(p, "after-apply", toApply.filter((name) => applied.run.completed.includes(name)), undefined, "the apply counts as failed though its components applied");
  await recordAutoReleasesForRun(applied.run.results, p.env, release.runId, resolveAutoReleaseDisabled(p.config, args.noReleaseRecord), release.runOrigin, undefined, undefined, prAppliedDigests(p, applied.members));
  const report = prReport({
    ...base,
    approval,
    status: afterFailed ? "failed" : applied.status,
    members: applied.members,
    ...(resumed ? { resumed: resumed.completed } : {}),
    ...(applied.rounds ? { rounds: applied.rounds } : {}),
    ...(applied.held ? { message: applied.held } : applied.leaseFailed ? { message: applied.leaseFailed } : applied.status === "waiting" ? { message: waitingMessage(op, applied.rounds) } : {}),
  });
  // A component that stopped at a gate of its own leaves the apply waiting on
  // a person. A step that refused its plan because the target moved since
  // the approval exits 4 (moved), as a moved digest does before anything applies (#3997, #4553).
  // A later round whose rows another run holds exits 5 (held, #4594).
  const exit = afterFailed
    ? 1
    : applied.held
      ? CHANT_EXIT.held
      : applied.status === "applied"
        ? 0
        : applied.status === "waiting"
          ? GATED_EXIT_CODE
          : applied.leaseFailed
            ? 1
            : failedRunExitCode(applied.run.results);
  const lost = green && applied.status === "applied" ? await recordGreenApplied(p, green, set.doc.digest, approval, via) : false;
  const code = await stop(report, lost && exit === 0 ? 1 : exit, applied.run.status === "gated" ? "gated" : undefined);
  if (applied.status === "applied" && !afterFailed) console.error(formatSuccess(`applied the plan ${report.digest} approved by ${(approval.approvedBy ?? []).join(", ")}`));
  // #4636: an update before merge that applied every member merges the pull request, never the other way round.
  if (code === 0 && beforeMerge && pr !== null && args.merge === "auto" && applied.status === "applied" && !afterFailed) return mergeAfterUpdate(ctx, p, pr);
  return code;
}

/** `--merge`, `--merge-token-env` and `--merge-method` as one problem, or undefined when they hold together. */
async function mergeArgsProblem(args: CommandContext["args"]): Promise<string | undefined> {
  const { PR_APPLY_MERGES, PR_MERGE_METHODS } = await import("../../pr-merge");
  if (args.merge === undefined) {
    if (args.mergeTokenEnv || args.mergeMethod) return "--merge-token-env and --merge-method go with --merge auto";
    return undefined;
  }
  if (!(PR_APPLY_MERGES as readonly string[]).includes(args.merge)) return `--merge takes ${PR_APPLY_MERGES.join(" or ")}, not ${args.merge}`;
  if (args.merge === "manual") return args.mergeTokenEnv || args.mergeMethod ? "--merge manual leaves the merge to a person, so it takes no --merge-token-env or --merge-method" : undefined;
  if (!args.beforeMerge) return "--merge auto merges a pull request once its update before merge applied, so it needs --before-merge --pr <n>";
  if (!args.mergeTokenEnv) return "--merge auto merges with a token of its own, never the job's: --merge-token-env <VAR> (on GitLab a protected variable)";
  if (args.mergeMethod && !(PR_MERGE_METHODS as readonly string[]).includes(args.mergeMethod)) return `--merge-method takes ${PR_MERGE_METHODS.join(", ")}, not ${args.mergeMethod}`;
  return undefined;
}

/**
 * The merge after an update before merge applied (#4636): the apply's
 * records pushed to the ledger, the head checked again, then the forge's
 * merge with the token `--merge-token-env` names alone. A refusal is posted
 * on the pull request and exits as waiting (3); the update stays applied.
 */
async function mergeAfterUpdate(ctx: CommandContext, p: Prepared, pr: number): Promise<number> {
  const { mergeAfterApply, mergeTokenEnv } = await import("../../pr-merge");
  const { pushLifecycleRebasing, LifecyclePushLostError } = await import("../../lifecycle/git");
  const kind = p.forge?.kind ?? (ctx.args.forge as ForgeKind | undefined);
  if (!kind) return fail("--merge auto needs --forge <kind> to merge on");
  const env = mergeTokenEnv(ctx.args.mergeTokenEnv!);
  if ("error" in env) {
    console.error(formatWarning({ message: `the pull request was not merged: ${env.error}` }));
    return CHANT_EXIT.waiting;
  }
  let forge: PrForge;
  try {
    forge = forgeFromEnv(kind, env);
  } catch (err) {
    console.error(formatWarning({ message: `the pull request was not merged: ${err instanceof Error ? err.message : String(err)}` }));
    return CHANT_EXIT.waiting;
  }
  // A refused push fetches, replays the apply's records on the remote's tip and pushes again (#4551).
  let pushed: { pushed: boolean; pushWarning?: string };
  let lost = false;
  try {
    pushed = await pushLifecycleRebasing();
  } catch (err) {
    if (!(err instanceof LifecyclePushLostError)) throw err;
    console.error(formatError({ message: err.message }));
    pushed = { pushed: false, pushWarning: err.message };
    lost = true;
  }
  const merged = await mergeAfterApply({
    forge,
    pr,
    head: p.head,
    ...(ctx.args.mergeMethod ? { method: ctx.args.mergeMethod as "merge" | "squash" | "rebase" } : {}),
    recorded: { pushed: pushed.pushed, ...(pushed.pushWarning ? { warning: pushed.pushWarning } : {}) },
  });
  if (merged.merged) {
    console.error(formatSuccess(`merged ${kind === "gitlab" ? `!${pr}` : `#${pr}`} at ${p.head.slice(0, 12)}${merged.sha ? ` as ${merged.sha.slice(0, 12)}` : ""}`));
    return 0;
  }
  console.error(formatWarning({ message: `the pull request was not merged: ${merged.reason}${merged.posted ? "; the reason is posted on it" : ""}` }));
  return lost ? 1 : CHANT_EXIT.waiting;
}

/**
 * Under `ci.locks` (#4293): the refusal when another open pull request holds
 * a lock on a component this apply reaches, else null. The targets are the
 * selected components, the names `chant lock` takes. A lock whose pull
 * request the forge says merged or closed reads as released; with no
 * `--forge` every lock counts. A lock file that cannot be read stops the
 * apply, since nothing then says the targets are free.
 */
async function heldLocksOf(p: Prepared, pr: number | null, targets: readonly string[] = p.plan.order): Promise<string | null | number> {
  const { heldTargetLocks, describeHeldTargetLocks } = await import("../../lifecycle/target-lock");
  const isOpen = p.forge?.pullRequestOpen?.bind(p.forge);
  let held;
  try {
    held = await heldTargetLocks(p.gate, targets, pr, { ...(isOpen ? { isOpen } : {}) });
  } catch (err) {
    return fail(`could not read the target locks of ${p.gate}, so nothing was applied: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (held.length === 0) return null;
  const name = (n: number) => (p.forge?.kind === "gitlab" ? `merge request !${n}` : `pull request ${n}`);
  const holders = [...new Set(held.map((h) => h.pr))].sort((a, b) => a - b);
  return `${describeHeldTargetLocks(held, name)}, so nothing was applied. Apply again once ${holders.length === 1 ? "it merges or closes" : "they merge or close"}, or after \`chant unlock --pr ${holders[0]}${p.gate === PR_APPLY_GATE ? "" : ` --gate ${p.gate}`}\`${isOpen ? "" : ". Without --forge every lock counts as held"}.`;
}

/**
 * `pr-apply --before-merge` (#4301, ws-106), before any of the head's code
 * loads: the declaration at base must set `ci.workflow: "apply-before-merge"`
 * for the member, and the forge must say the pull request is approved,
 * mergeable, undiverged and green at the commit checked out. Returns the
 * checks for the report, or the exit code once it wrote a refusal.
 */
async function beforeMergeChecks(ctx: CommandContext): Promise<PrBeforeMerge | number> {
  const { args } = ctx;
  if (args.green) return fail("--before-merge applies an open pull request's head and --green a green commit; pass one of them");
  if (args.waveGate) return fail("--before-merge applies the pull request's plan in one run, so it takes no --wave-gate");
  if (args.pr === undefined) return fail("--before-merge applies an open pull request, so it needs --pr <n>");
  if (!args.forge || !(FORGE_KINDS as readonly string[]).includes(args.forge)) return fail("--before-merge asks the forge whether the pull request is ready, so it needs --forge github|gitlab|forgejo");
  if (!args.base) return fail("pr-apply needs the commit the change is measured from: --base <ref>", "Before merge, the target branch's commit.");
  const { checkPrRequires, unmetRequires, parseRequiresList } = await import("../../pr-requires");
  // #4607: a product's `apply.requires` names the checks to ask; absent, all four.
  const only = args.requires ? parseRequiresList(args.requires) : undefined;
  if (only && "error" in only) return fail(only.error);
  const cwd = resolve(".");
  let forge: PrForge;
  let head: string;
  let base: string;
  try {
    forge = forgeFromEnv(args.forge as ForgeKind);
    head = await resolveCommit(cwd, args.head ?? "HEAD");
    base = await resolveMergeBase(cwd, args.base, head);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const member = args.members?.[0];
  const gate = args.gate ?? PR_APPLY_GATE;
  const { ciWorkflowAt } = await import("../../workspace/ci-workflow-at");
  const { appliesBeforeMerge } = await import("../../workspace/ci-workflow");
  const workflow = ciWorkflowAt(cwd, args.base, member);
  const early = earlyStop(ctx, forge, { pr: args.pr, base, head, gate, ...(member ? { member } : {}) });
  if (!appliesBeforeMerge(workflow)) {
    return early(
      { requires: [] },
      "before-merge-off",
      `The declaration at base sets ci.workflow to ${workflow ?? "nothing"}${member ? ` for ${member}` : ""}, and only apply-before-merge applies a pull request before it merges (ws-106). Nothing was applied.`,
      1,
    );
  }
  // The apply's own statuses never hold it back: chant ci run's, and the report's.
  // #4550: under a product's words its own prefix too.
  const ignore = [...new Set([productContext(activeProductWords(), gate), productContext(activeProductWords(), PR_APPLY_GATE), `chant/${gate}`, `chant/${PR_APPLY_GATE}`, prStatusContext("apply", member)])];
  // ws-106 gives the declaration no way to leave a check out, so with no --requires all four are asked (#4336, #4607).
  const requires = await checkPrRequires(forge, args.pr, head, { ignore, ...(only ? { only: only.checks } : {}) });
  for (const r of requires) console.error(formatInfo(`${r.name}: ${r.passed ? "passed" : r.pending ? "pending" : "unmet"}, ${r.reason}`));
  const unmet = unmetRequires(requires);
  if (unmet) {
    return early({ requires }, "requires-unmet", `${forge.kind === "gitlab" ? `Merge request !${args.pr}` : `Pull request ${args.pr}`} is not ready to apply before merge: ${unmet}. Nothing was applied.`, GATED_EXIT_CODE);
  }
  return { requires };
}

/** The refusal report of an apply before merge stopped before it planned (#4301): nothing selected, nothing planned. */
function earlyStop(ctx: CommandContext, forge: PrForge, at: { pr: number; base: string; head: string; gate: string; member?: string }) {
  return async (beforeMerge: PrBeforeMerge, refusal: "requires-unmet" | "before-merge-off", message: string, code: number): Promise<number> => {
    const plan = { order: [], waves: [], skipped: [], seeds: [], indeterminate: [] } as unknown as FanOutPlan;
    const signal = { changed: [], indeterminate: [], unclaimed: [] } as unknown as ComponentChangeSignal;
    const p = { env: ctx.args.env ?? "local", base: at.base, head: at.head, gate: at.gate, forge, hookOutcomes: [], beforeMerge, ...(at.member ? { member: at.member } : {}) } as unknown as Prepared;
    const set: PrPlanSet = { doc: composeChangeSet([]), members: [], plans: {}, outputs: {}, failed: false };
    const report = prReport({ stage: "apply", pr: at.pr, env: p.env, ...(at.member ? { member: at.member } : {}), base: at.base, head: at.head, op: prOp(at.pr, at.member), gate: at.gate, plan, signal, set, approval: { status: "pending" }, status: "refused", refusal, message });
    return stopper(ctx, p, undefined, undefined)(report, code);
  };
}

/**
 * Take `apply` locks on the targets an apply before merge reaches (#4293,
 * #4301), held for pull request `pr` until it merges or closes. Returns the
 * refusal when another open pull request holds one, null once taken, or the
 * exit code when the locks could not be written.
 */
async function takeApplyLocks(p: Prepared, pr: number, targets: readonly string[] = p.plan.order): Promise<string | null | number> {
  const { takeTargetLocks, describeHeldTargetLocks } = await import("../../lifecycle/target-lock");
  const isOpen = p.forge?.pullRequestOpen?.bind(p.forge);
  const by = process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER ?? "unknown";
  let result;
  try {
    result = await takeTargetLocks(p.gate, targets, { pr, by, at: new Date().toISOString(), stage: "apply", head: p.head }, { ...(isOpen ? { isOpen } : {}) });
  } catch (err) {
    return fail(`could not take the target locks of ${p.gate}, so nothing was applied: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.ok) {
    if (result.taken.length > 0) console.error(formatInfo(`pull request ${pr} holds ${result.taken.join(", ")} on ${p.gate} until it merges or closes`));
    return null;
  }
  const name = (n: number) => (p.forge?.kind === "gitlab" ? `merge request !${n}` : `pull request ${n}`);
  return `${describeHeldTargetLocks(result.held, name)}, so nothing was applied.`;
}

/** #4274: a component that published nothing is recorded by the plan digest its approval bound. */
function prAppliedDigests(p: Prepared, members: PrMember[]) {
  return appliedDigestOf({ components: p.components, env: p.env, projectRoot: resolve("."), members });
}

/** chant components pr-record --base <ref> [--pr <n>] [--env <env>] [--gate <name>] [--forge <kind>] [--output <dir>] [--json] [--events-json] [--report-url <url>] */
export function runComponentsPrRecord(ctx: CommandContext): Promise<number> {
  if (refusesEventsWithJson(ctx.args, "the stage's report")) return Promise.resolve(1);
  return withStageEvents("pr-record", ctx, (events) => withComponentEndpoint(ctx, () => prRecord(ctx, events)));
}

/**
 * The record stage (#4168 step 1): what a merge does unless apply on merge
 * is opted in. It plans the members the change reaches on the merged
 * commit, stores the change set, decides the pull request's gate against
 * it without writing to the ledger, and writes the merge record
 * (`../../lifecycle/merge-record.ts`). It applies nothing and refuses
 * nothing. A plan that differs from the approved one is recorded, and the
 * `chant/record` status fails (decision 1). It exits 1 only when a member
 * failed to plan.
 */
async function prRecord(ctx: CommandContext, stage: StageEvents): Promise<number> {
  const { args } = ctx;
  const p = await prepare(ctx, "record");
  if (typeof p === "number") return p;

  let pr: number | null = args.pr ?? null;
  if (pr === null && p.forge) {
    try {
      pr = await p.forge.pullRequestFor(p.head);
    } catch (err) {
      console.error(formatWarning({ message: `could not ask ${p.forge.kind} which pull request merged ${p.head}, so the record names none: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }
  const op = pr === null ? "pr-unknown" : prOp(pr, p.member);
  placeHooks(ctx, p, "record", op);
  const upload = openUpload(stage, "record", pr, p);
  const events = await openCliRunEvents(args, { kind: "component", name: `pr-record ${op}`, cwd: resolve(".") }, upload?.line);
  stage.stream = events;
  events?.emit({ type: "run-start", waves: p.plan.waves });
  const set = await planAll(p, events?.emit);
  const nothing = p.plan.order.length === 0;

  let approval: PrApproval = { status: "pending" };
  if (!nothing && !set.failed) {
    await storeChangeSetForGate(ctx, p, set.doc);
    if (pr !== null) {
      try {
        const check = await emitGateStep(events?.emit, { op, gate: p.gate }, () =>
          decidePrGate(readOnlyLedger(gitGateLedgerPort()), { op, gate: p.gate, digest: set.doc.digest }),
        );
        approval = approvalOf(check);
      } catch (err) {
        console.error(formatWarning({ message: `could not read the gate ledger, so the record says no approval: ${err instanceof Error ? err.message : String(err)}` }));
      }
    }
  }

  // #4000: the record keeps an approval by someone who wrote the change, which review rules would not count.
  let authorApproved: string[] | undefined;
  if (pr !== null && p.forge && approval.status === "approved") {
    try {
      const authors = (await p.forge.authors(pr)).map((login) => p.forge!.principalOf(login));
      authorApproved = approversWhoAuthored(approval.approvedBy ?? [], authors);
    } catch (err) {
      console.error(formatWarning({ message: `could not read the authors of #${pr}: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }

  const status = nothing ? "nothing" : set.failed ? "plan-failed" : "recorded";
  const report = prReport({
    stage: "record",
    pr,
    env: p.env,
    ...(p.member ? { member: p.member } : {}),
    base: p.base,
    head: p.head,
    op,
    gate: p.gate,
    plan: p.plan,
    signal: p.signal,
    set,
    approval,
    status,
    ...(status === "plan-failed" ? { message: "A member failed to plan on the merged commit, so the record has no plan to compare with the approved one. Nothing was applied." } : {}),
    ...(status === "recorded" && approval.status === "changed"
      ? { message: `${describePlanChanged({ op, gate: p.gate, digest: set.doc.digest, approval })} The merge stands and nothing was applied; the release gate decides before this deploys.` }
      : {}),
  });

  const { mergeSourceOf, writeMergeRecord, MERGE_RECORD_SCHEMA_ID, MERGE_RECORD_CONTRACT } = await import("../../lifecycle/merge-record");
  const { pushLifecycleRebasing, LifecyclePushLostError } = await import("../../lifecycle/git");
  // Set when the merge record never reached the remote: the job fails rather than warns, since a record kept only
  // in this job's checkout is lost with it (#4551).
  let lost = false;
  // #4292: a member another branch applies has no merge on this one, so no record says it planned nothing here.
  if (!p.routedAway) {
    try {
      const written = await writeMergeRecord({
        $schema: MERGE_RECORD_SCHEMA_ID,
        contract: MERGE_RECORD_CONTRACT,
        commit: p.head,
        base: p.base,
        env: p.env,
        ...(p.member ? { member: p.member } : {}),
        source: mergeSourceOf(resolve("."), p.head, pr),
        op: pr === null ? null : op,
        gate: p.gate,
        digest: nothing ? null : set.doc.digest,
        plan: nothing ? "nothing" : set.failed ? "plan-failed" : approval.status === "approved" ? "approved" : approval.status === "changed" ? "changed" : "unapproved",
        ...(approval.status === "changed" && approval.approved ? { approvedDigest: approval.approved } : {}),
        approvedBy: approval.status === "approved" ? (approval.approvedBy ?? []) : [],
        ...(authorApproved && authorApproved.length > 0 ? { authorApproved } : {}),
        components: p.plan.order,
        recordedAt: new Date().toISOString(),
      });
      if (written.written) {
        const pushed = await pushLifecycleRebasing();
        if (pushed.pushWarning) console.error(formatWarning({ message: pushed.pushWarning }));
      }
    } catch (err) {
      if (err instanceof LifecyclePushLostError) {
        console.error(formatError({ message: `the merge record for ${p.head} was written but not pushed: ${err.message}` }));
        lost = true;
      } else {
        console.error(formatWarning({ message: `could not write the merge record for ${p.head}: ${err instanceof Error ? err.message : String(err)}` }));
      }
    }
  }

  const stop = stopper(ctx, p, events, upload);
  return stop(report, status === "plan-failed" || lost ? 1 : 0);
}

/** What a gate's description and messages call the change: the pull request, or the green commit (#4168 step 9). */
function changeLabel(pr: number | null, green: GreenTarget | undefined): string {
  return green ? `green ${green.commit.slice(0, 12)}` : `pull request #${pr}`;
}

/**
 * `pr-apply --green` (#4168 step 9): the green commit at HEAD, the last one
 * applied to the environment, and the merges between with their approvals.
 * Exits 0 when HEAD is the green commit last applied.
 */
async function greenTargetOf(ctx: CommandContext): Promise<GreenTarget | number> {
  const { args } = ctx;
  if (args.pr !== undefined) return fail("--green applies a green commit and every merge since the last one applied, so it takes no --pr; the merge records name the pull requests");
  const { resolveGreenTarget } = await import("../../components/green-cover");
  const env = args.env ?? "local";
  const resolved = await resolveGreenTarget({ cwd: resolve("."), env, ...(args.base ? { base: args.base } : {}), gate: args.gate ?? PR_APPLY_GATE });
  if (resolved.status === "error") return fail(resolved.message, resolved.hint);
  if (resolved.status === "applied") {
    console.error(formatInfo(`${resolved.commit.slice(0, 12)} is the green commit last applied to ${env}, so there is nothing to apply`));
    return 0;
  }
  const t = resolved.target;
  const from = { applied: "the green commit last applied", flag: "--base", "previous-green": "the green commit before it", parent: "its parent" }[t.baseFrom];
  console.error(formatInfo(`applying green ${t.commit.slice(0, 12)}, measured from ${t.base.slice(0, 12)} (${from}): ${t.merges.length} commit${t.merges.length === 1 ? "" : "s"}, ${t.approved.length} with an approved plan`));
  return t;
}

/**
 * The first plan's gate. For one pull request, its gate on the plan's digest.
 * For a green commit (#4168 step 9), the approved plans of the merges since
 * the last applied green commit when they cover every member, and otherwise
 * a gate of the green commit's own on the combined digest.
 */
async function decideApplyGate(
  p: Prepared,
  at: { op: string; pr: number | null; set: PrPlanSet; events?: RunEventStream; green?: GreenTarget; held?: boolean },
): Promise<{ approval: PrApproval; satisfied: true; via: "merges" | "gate" } | { approval: PrApproval; satisfied: false; refusal: "plan-changed" | "not-approved"; message: string }> {
  const { op, pr, set, events, green } = at;
  let uncovered: string[] = [];
  // #4294: a plan the policy holds needs an approval of its own digest, so the merges' approvals do not cover it.
  if (green && at.held) {
    console.error(formatInfo(`the policy holds the plan at ${green.commit.slice(0, 12)}, so it needs an approval of its own digest and does not apply under the merges' approvals`));
    uncovered = ["the policy holds this plan for an approval of its own digest"];
  } else if (green) {
    const cover = coverByMerges(set.doc, green.approved);
    if (cover.covered) {
      console.error(formatInfo(`the approved plans of ${cover.coveredBy.length} merge${cover.coveredBy.length === 1 ? "" : "s"} cover the plan at ${green.commit.slice(0, 12)}, so it applies under them`));
      return { approval: { status: "approved", approvedBy: cover.approvedBy }, satisfied: true, via: "merges" };
    }
    uncovered = cover.uncovered;
    console.error(formatInfo(`the merged changes' approvals do not cover the plan at ${green.commit.slice(0, 12)}: ${uncovered.join("; ")}`));
  }
  const digest = set.doc.digest;
  const check = await emitGateStep(
    events?.emit,
    { op, gate: p.gate },
    () => decidePrGate(gitGateLedgerPort(), { op, gate: p.gate, digest, description: `${changeLabel(pr, green)}: ${p.plan.order.join(", ")}` }),
    (unapproved) => {
      const a = approvalOf(unapproved);
      return a.status === "changed"
        ? describePlanChanged({ op, gate: p.gate, digest, approval: a })
        : `No approval stands for this plan. Approve it: ${prApproveCommand({ op, gate: p.gate, digest })}`;
    },
  );
  const approval = approvalOf(check);
  if (check.satisfied) return { approval, satisfied: true, via: "gate" };
  if (approval.status === "changed") return { approval, satisfied: false, refusal: "plan-changed", message: describePlanChanged({ op, gate: p.gate, digest, approval }) };
  const why = uncovered.length > 0 ? ` The approvals of the merges since the last applied green commit do not cover it: ${uncovered.join("; ")}.` : "";
  return {
    approval,
    satisfied: false,
    refusal: "not-approved",
    message: `No approval stands for this plan, so nothing was applied.${why} Approve it: ${prApproveCommand({ op, gate: p.gate, digest })}; then run the apply again.`,
  };
}

/**
 * The `--require-review` check for the apply. A green commit (#4168 step 9)
 * has no pull request of its own, so its approvers are checked against every
 * pull request merged since the last applied green commit for authorship
 * only: whoever wrote one of them never counts.
 */
function reviewFor(args: CommandContext["args"], p: Prepared, pr: number | null, green: GreenTarget | undefined): (approvedBy: readonly string[], what: string) => Promise<ReviewStop> {
  if (!green) return reviewCheck(args, p, pr!);
  const checks = green.prs.map((n) => reviewCheck(args, p, n, true));
  return async (approvedBy, what) => {
    for (const check of checks) {
      const stop = await check(approvedBy, what);
      if (stop) return stop;
    }
    return undefined;
  };
}

/**
 * Record the green commit as applied to the environment (#4168 step 9), and
 * push `chant/lifecycle`, fetching and replaying on a refused push. A record
 * that never reaches the remote is an error and returns true, so the stage
 * fails; any other failure warns.
 */
async function recordGreenApplied(p: Prepared, green: GreenTarget, digest: string, approval: PrApproval, via: "merges" | "gate"): Promise<boolean> {
  const { writeGreenApply, GREEN_APPLY_CONTRACT } = await import("../../lifecycle/green-apply");
  const { pushLifecycleRebasing, LifecyclePushLostError } = await import("../../lifecycle/git");
  try {
    await writeGreenApply({
      contract: GREEN_APPLY_CONTRACT,
      env: p.env,
      ...(p.member ? { member: p.member } : {}),
      commit: green.commit,
      base: green.base,
      digest,
      approval: via,
      approvedBy: approval.approvedBy ?? [],
      merges: green.merges,
      appliedAt: new Date().toISOString(),
    });
    const pushed = await pushLifecycleRebasing();
    if (pushed.pushWarning) console.error(formatWarning({ message: pushed.pushWarning }));
  } catch (err) {
    if (err instanceof LifecyclePushLostError) {
      console.error(formatError({ message: `the record of ${green.commit.slice(0, 12)} as applied to ${p.env} was written but not pushed: ${err.message}` }));
      return true;
    }
    console.error(formatWarning({ message: `could not record ${green.commit.slice(0, 12)} as applied to ${p.env}: ${err instanceof Error ? err.message : String(err)}` }));
  }
  return false;
}

/** How a stage stops: settle its events, write and publish the report, say how it ended, and return `code`. */
function stopper(ctx: CommandContext, p: Prepared, events: RunEventStream | undefined, upload: PrReportUpload | undefined) {
  return async (report: PrReport, code: number, settle?: RunEventSettleStatus): Promise<number> => {
    events?.settle(settle ?? settleOf(report.status), report.status === "plan-failed" || report.status === "failed" ? report.message ?? `pr-${report.stage} ${report.status}` : undefined);
    await finish(ctx, p, report, upload);
    // #4629: a failed apply's triage and a refused apply's diff, on the pull request.
    if (report.stage === "apply" && (report.status === "failed" || report.status === "refused") && !ctx.args.noStatus) await respondApply(ctx, p, report);
    console.error((code === 0 ? formatInfo : (m: string) => formatWarning({ message: m }))(`pr-${report.stage}: ${report.status}${report.refusal ? ` (${report.refusal})` : ""}`));
    if (report.message) console.error(report.message);
    printMembers(report);
    return code;
  };
}

/** The responses an apply's report calls for (#4629), from `--respond` over `CHANT_RESPOND`. Never throws. */
async function respondApply(ctx: CommandContext, p: Prepared, report: PrReport): Promise<void> {
  try {
    const { parseRespondList } = await import("../../ci-respond");
    const given = ctx.args.respond ? parseRespondList(ctx.args.respond) : {};
    if ("error" in given) {
      console.error(formatWarning({ message: `no response was posted: ${given.error}` }));
      return;
    }
    const { respondPrApply } = await import("../../ci-respond-run");
    await respondPrApply(p.forge, report, given);
  } catch (err) {
    console.error(formatWarning({ message: `the apply's responses were not posted: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

/** Why `--require-review` does not count an approval, or why the reviews could not be read. */
type ReviewStop = { refusal: "author-approved" | "not-a-reviewer"; message: string } | { error: string } | undefined;

/**
 * The `--require-review` check (#3183, #4000) of an approval's approvers,
 * `what` naming the plan they approved. The pull request's reviews and
 * authors are read once, at the first call. Without `--require-review` every
 * approval counts.
 */
function reviewCheck(args: CommandContext["args"], p: Prepared, pr: number, authorsOnly = false): (approvedBy: readonly string[], what: string) => Promise<ReviewStop> {
  let read: Promise<{ reviewers: string[]; authors: string[] }> | undefined;
  return async (approvedBy, what) => {
    const forge = p.forge;
    if (!args.requireReview || !forge) return undefined;
    read ??= (async () => ({
      reviewers: (await forge.approvers(pr)).map((login) => forge.principalOf(login)),
      authors: (await forge.authors(pr)).map((login) => forge.principalOf(login)),
    }))();
    let reviewers: string[];
    let authors: string[];
    try {
      ({ reviewers, authors } = await read);
    } catch (err) {
      return { error: `could not read the reviews and authors of #${pr}: ${err instanceof Error ? err.message : String(err)}` };
    }
    // #4000: whoever wrote the change never counts toward its gate, through a forge review or a ledger line.
    const writers = approversWhoAuthored(approvedBy, authors);
    if (writers.length > 0) {
      return {
        refusal: "author-approved",
        message:
          `${what} is approved by ${writers.join(", ")}, who wrote #${pr} ` +
          `(its author and the authors and committers of its commits: ${authors.join(", ")}). ` +
          `An approval from someone who wrote the change never counts, so nothing was applied. ` +
          `Have someone else approve the pull request and the plan, then run the apply again.`,
      };
    }
    const strangers = authorsOnly ? [] : approversWithoutReview(approvedBy, reviewers);
    if (strangers.length > 0) {
      return {
        refusal: "not-a-reviewer",
        message:
          `${what} is approved by ${strangers.join(", ")}, who ${strangers.length === 1 ? "has" : "have"} no approving review on #${pr}` +
          ` (approving reviews: ${reviewers.join(", ") || "none"}). Nothing was applied. ` +
          `An approval counts when it names the reviewer the way the forge does: ${forge.principalOf("<login>")}.`,
      };
    }
    return undefined;
  };
}

/** What a `waiting` apply prints (#3999): the round's gate and digest to approve, and how to carry on. */
function waitingMessage(op: string, rounds: PrRound[] | undefined): string {
  const last = rounds?.at(-1);
  if (!last) return "Some members were held back after an upstream applied.";
  return (
    `${last.components.join(", ")} ${last.components.length === 1 ? "was" : "were"} planned again after an upstream applied, ` +
    `and no approval stands for that plan (${last.digest}), so ${last.components.length === 1 ? "it" : "they"} did not apply. ` +
    `Approve it: ${prApproveCommand({ op, gate: last.gate, digest: last.digest })}; then run the apply again with the same --resume record.`
  );
}

/** What a component's settle says in the job log. */
function settleWords(body: RunEventComponentSettle): string {
  switch (body.status) {
    case "ok":
      return "applied";
    case "failed":
      return "failed";
    case "gated":
      return "stopped at its own gate";
    case "waiting":
      return "waiting on a decision";
    case "blocked":
      return `blocked by ${body.blockedBy ?? "a dependency"}, not run`;
    case "already-applied":
      return "already applied in an earlier attempt";
  }
}

/**
 * pr-apply's job log (#4007): a line on stderr as each wave starts and as
 * each component settles, so the log shows the waves in order while they run.
 */
/** One wave's fan-out numbers its wave 1; the events and the log carry the derivation's number (#4003). */
function inWave(body: RunEventBody, wave: number): RunEventBody {
  return "wave" in body && typeof (body as { wave?: unknown }).wave === "number" ? ({ ...body, wave } as RunEventBody) : body;
}

function applyLog(): (body: RunEventBody) => void {
  let waves = 0;
  return (body) => {
    if (body.type === "run-start") waves = body.waves?.length ?? 0;
    else if (body.type === "wave-start") console.error(formatInfo(`wave ${body.wave}${waves ? `/${waves}` : ""}: ${body.components.join(", ")}`));
    else if (body.type === "component-settle") console.error(formatInfo(`  ${body.component}: ${settleWords(body)}`));
  };
}

/** A resumed apply's gate (#3464), decided against the approved digest, as the run's `gate` phase. */
function emitResumedGate(events: RunEventStream | undefined, op: string, gate: string, check: GateCheck): void {
  if (!events) return;
  const where = { component: null, phase: GATE_PHASE, step: `gate:${gate}` };
  events.emit({ type: "phase-start", component: null, phase: GATE_PHASE });
  events.emit({ type: "step-start", ...where });
  for (const body of gateEventsOf(check, { ...where, op, gate }, { durationMs: null })) events.emit(body);
  events.emit({ type: "phase-settle", component: null, phase: GATE_PHASE, status: check.satisfied ? "ok" : "gated" });
}

/** An approval by someone with no approving review (#3183) stops the apply: a `review` phase that settles `gated`. */
function emitReviewStop(events: RunEventStream | undefined, message: string): void {
  if (!events) return;
  events.emit({ type: "phase-start", component: null, phase: "review" });
  events.emit({ type: "step-start", component: null, phase: "review", step: "review" });
  events.emit({ type: "step-settle", component: null, phase: "review", step: "review", status: "gated", durationMs: null, message });
  events.emit({ type: "phase-settle", component: null, phase: "review", status: "gated" });
}

/**
 * Store `doc` under its digest with its entries mapped onto the member's
 * graph (`storeGateChangeSet`), and push, fetching and replaying on a refused
 * push. A failure to store is a warning: the gate decides the same either
 * way. A change set that never reaches the remote throws
 * `LifecyclePushLostError`, which stops the stage.
 */
async function storeChangeSetForGate(ctx: CommandContext, p: Prepared, doc: PrPlanSet["doc"]): Promise<void> {
  const { storeGateChangeSet, gateGraphReader } = await import("../../lifecycle/gate-change-set");
  const { pushLifecycleRebasing, LifecyclePushLostError } = await import("../../lifecycle/git");
  const graphArgs = [
    ...(ctx.args.param ?? []).flatMap((kv) => ["--param", kv]),
    ...(ctx.args.paramsFile ? ["--params-file", ctx.args.paramsFile] : []),
  ];
  try {
    const stored = await storeGateChangeSet({ doc, cwd: resolve("."), at: p.head, readGraph: gateGraphReader(graphArgs) });
    if (stored.warning) console.error(formatWarning({ message: stored.warning }));
    // The push's own outcome is said by the gate's pending fact, or by the
    // release records the apply writes, which push the same branch.
    if (stored.written) await pushLifecycleRebasing();
  } catch (err) {
    if (err instanceof LifecyclePushLostError) throw err;
    console.error(formatWarning({ message: `could not store the change set ${doc.digest}: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

interface Resumed {
  plan: FanOutPlan;
  set: PrPlanSet;
  /** The gate's decision against the approved digest. */
  check: GateCheck;
  approval: PrApproval;
  completed: string[];
  outputs: Record<string, Record<string, unknown>>;
}

/**
 * Whether `attempt` finishes here (#3464). It carries only when it was made
 * by an apply of this pull request's gate, on this commit, for this
 * derivation; when its approval still stands; and when every member left is
 * covered by the approved set. Otherwise it says why on stderr and the apply
 * runs as it would with no record.
 *
 * Of the components it applied, only those whose input digest is the same
 * now carry (#4081), as in `components fan-out --resume`. One that changed
 * runs again, under the same approval when the approved set covers its new
 * plan. A record without input digests carries nothing.
 */
async function tryResume(p: Prepared, attempt: FanOutAttempt, file: string, op: string, inputsNow: Record<string, string>): Promise<Resumed | undefined> {
  const skip = (why: string): undefined => {
    console.error(formatWarning({ message: `--resume: "${file}" does not carry: ${why}`, hint: "Every member is planned again, and the plan needs an approval of its own." }));
    return undefined;
  };
  const record = attempt.prApply;
  if (!record) return skip("it was not written by pr-apply");
  if (record.op !== op || record.gate !== p.gate) return skip(`it records ${record.op} ${record.gate}, not ${op} ${p.gate}`);
  if (record.head !== p.head) return skip(`it records an apply of ${record.head.slice(0, 12)}, not ${p.head.slice(0, 12)}`);
  if (!samePlanDigest(attempt.digest, p.plan.digest)) return skip("the change selects other components than it did");
  if (attempt.completed.length === 0) return undefined;
  const split = progressThatCarries(attempt, inputsNow);
  if (split.unrecorded) return skip("it does not record what each component applied, since it was written before chant recorded component inputs");
  for (const name of split.changed) console.error(formatInfo(`${name}: changed since the earlier attempt, so it runs again`));
  if (split.carried.length === 0) return undefined;
  const completed = split.carried;

  let check;
  try {
    check = await decidePrGate(readOnlyLedger(gitGateLedgerPort()), { op, gate: p.gate, digest: record.digest });
  } catch (err) {
    return skip(`could not read the gate ledger: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!check.satisfied) return skip(`no approval stands for the plan it applied (${record.digest}) any more`);

  const outputs = Object.fromEntries(Object.entries(attempt.outputs).filter(([name]) => completed.includes(name)));
  const resumed = await resumePrSet({
    components: p.components,
    plan: p.plan,
    registry: p.registry,
    env: p.env,
    seededOutputs: p.seededOutputs,
    policyBase: p.base,
    record,
    completed,
    applied: outputs,
  });
  if (!resumed.ok) return skip(`what is left is not what was approved. ${resumed.reasons.join("; ")}`);
  console.error(formatInfo(`resume  : ${completed.join(", ")} applied in an earlier attempt; applying ${resumed.plan.order.join(", ") || "nothing more"} under the approval of ${record.digest}`));
  return { plan: resumed.plan, set: resumed.set, check, approval: approvalOf(check), completed, outputs };
}

// ── A gate per wave on merge (#4003) ─────────────────────────────────────────

/** What an earlier wave's job left for this one (#4003): the approved set, the pull request's gate decided against it, and the progress that carries. */
interface WaveCarry {
  record: PrApplyRecord;
  check: GateCheck;
  approval: PrApproval;
  completed: string[];
  outputs: Record<string, Record<string, unknown>>;
}

/**
 * Whether `attempt` carries into this wave's job. It does when it was made
 * by an apply of this pull request's gate, on this commit, for this
 * derivation; when its change set is the one its digest names; and when the
 * pull request's approval still stands for that digest. Of the components it
 * applied, those whose input is the same now carry (#4081). Otherwise it says
 * why on stderr, and the job runs as it would with no record.
 */
async function carryWaves(p: Prepared, attempt: FanOutAttempt, file: string, op: string, inputsNow: Record<string, string>): Promise<WaveCarry | undefined> {
  const skip = (why: string): undefined => {
    console.error(formatWarning({
      message: `--resume: "${file}" does not carry: ${why}`,
      hint: "Wave 1 plans every member again and needs the pull request's approval of that plan; a later wave refuses until wave 1 applied.",
    }));
    return undefined;
  };
  const record = attempt.prApply;
  if (!record) return skip("it was not written by pr-apply");
  if (record.op !== op || record.gate !== p.gate) return skip(`it records ${record.op} ${record.gate}, not ${op} ${p.gate}`);
  if (record.head !== p.head) return skip(`it records an apply of ${record.head.slice(0, 12)}, not ${p.head.slice(0, 12)}`);
  if (!samePlanDigest(attempt.digest, p.plan.digest)) return skip("the change selects other components than it did");
  if (record.changeSet.digest !== record.digest || !verifyChangeSetDigest(record.changeSet)) return skip(`its change set is not the one its digest ${record.digest} names`);
  const split = progressThatCarries(attempt, inputsNow);
  if (split.unrecorded && attempt.completed.length > 0) return skip("it does not record what each component applied, since it was written before chant recorded component inputs");
  for (const name of split.changed) console.error(formatInfo(`${name}: changed since the earlier attempt, so it runs again`));
  let check: GateCheck;
  try {
    check = await decidePrGate(readOnlyLedger(gitGateLedgerPort()), { op, gate: p.gate, digest: record.digest });
  } catch (err) {
    return skip(`could not read the gate ledger: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!check.satisfied) return skip(`no approval stands for the plan it applied (${record.digest}) any more`);
  const completed = split.carried;
  const outputs = Object.fromEntries(Object.entries(attempt.outputs).filter(([name]) => completed.includes(name)));
  return { record, check, approval: approvalOf(check), completed, outputs };
}

/**
 * `pr-apply --wave-gate <gate>` (#4003): apply the pull request's approved
 * set a wave at a time, each wave planned after the one before it applied.
 *
 * The first job plans every member, as pr-apply does, and decides the pull
 * request's gate against that digest. The waves then run on op waves
 * (#4588): the component waves spec (`componentWavesSpec`), each run a
 * component, planned and applied through the component plan-wave and
 * apply-wave steps (`chant components plan-wave|apply-wave`). Each wave is
 * planned against the outputs the waves before it left. When the approved
 * change set covers its plan (`planCoveredBy`, the op waves' `pull-request`
 * approval) it applies under the pull request's approval; when it does not,
 * it waits at `<gate>-wave-<k>` under the pull request's op for an approval
 * of its new plan, and exits 3.
 *
 * With `--wave <k>` the job runs wave k and no other, reading the approved
 * set and the progress from the `--resume` record the job before it left.
 * Without it the waves run in order until one stops.
 */
async function prApplyWaves(
  ctx: CommandContext,
  p: Prepared,
  at: { pr: number | null; op: string; release: ReturnType<typeof autoReleaseRun>; upload?: PrReportUpload; events?: RunEventStream; green?: GreenTarget },
): Promise<number> {
  const { args } = ctx;
  const { pr, op, events, upload, green } = at;
  const waveGate = args.waveGate!;
  const only = args.wave;
  const total = p.plan.waves.length;
  const stop = stopper(ctx, p, events, upload);
  const log = applyLog();
  log({ type: "run-start", waves: p.plan.waves });
  const reportBase = { stage: "apply" as const, pr, env: p.env, ...(p.member ? { member: p.member } : {}), base: p.base, head: p.head, op, gate: p.gate, plan: p.plan, signal: p.signal, waveGate };

  if (p.plan.order.length === 0 || (pr === null && !green)) {
    const set = await planAll(p, events?.emit);
    if (p.plan.order.length === 0) return stop(prReport({ ...reportBase, set, approval: { status: "pending" }, status: "nothing" }), 0);
    return stop(
      prReport({
        ...reportBase,
        set,
        approval: { status: "pending" },
        status: "refused",
        refusal: "no-pull-request",
        message: `No pull request merged ${p.head}, so no approval answers for this change. Nothing was applied. Pass --pr <n>, or land the change through a pull request.`,
      }),
      GATED_EXIT_CODE,
    );
  }

  const resumePath = args.resume ? resolve(args.resume) : undefined;
  let attempt: FanOutAttempt | undefined;
  if (resumePath) {
    try {
      attempt = readFanOutAttempt(resumePath);
    } catch (err) {
      return fail(`--resume: could not read "${args.resume}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const inputsNow = resumePath ? componentInputDigests(p.components, { projectRoot: resolve("."), env: p.env }) : {};
  const carry = attempt ? await carryWaves(p, attempt, args.resume!, op, inputsNow) : undefined;

  const completed = new Set(carry?.completed ?? []);
  const outputsSoFar: Record<string, Record<string, unknown>> = { ...(carry?.outputs ?? {}) };
  const inputsSoFar: Record<string, string> = Object.fromEntries([...completed].filter((n) => inputsNow[n] !== undefined).map((n) => [n, inputsNow[n]!]));
  // #4291: what failed in an earlier wave's job stays failed until it applies, so this job blocks its dependents and runs the rest.
  const failedSoFar = new Set<string>((carry ? attempt?.failed ?? [] : []).filter((name) => !completed.has(name)));
  let waves: PrWave[] = carry?.record.waves ?? [];
  const upstreams = new Map(p.components.map((c) => [c.name, c.dependsOn ?? []]));
  /** Each component's outcome so far, past applied (#4291): failed, waiting, not-applied, or blocked by a failure. */
  const outcomes = (): Map<string, WaveMemberOutcome> => {
    const out = new Map<string, WaveMemberOutcome>();
    for (const name of completed) out.set(name, { status: "applied" });
    for (const name of failedSoFar) out.set(name, { status: "failed" });
    for (const w of waves) {
      if (w.status !== "waiting" && w.status !== "plan-failed" && w.status !== "failed") continue;
      for (const name of w.components) if (!out.has(name)) out.set(name, { status: w.status === "waiting" ? "waiting" : "not-applied" });
    }
    return out;
  };
  /** Components a failure blocked (#4291), each with the component that failed. */
  const blockedSoFar = new Map<string, string>();
  const after = new Map<string, PrMember>();
  const leftIn = (k: number): string[] => (p.plan.waves[k - 1] ?? []).filter((name) => !completed.has(name));
  const firstLeft = (): number => p.plan.waves.findIndex((_, i) => leftIn(i + 1).length > 0) + 1;

  // The approved set: carried from the record, or planned here and decided against the pull request's gate.
  let approved: PrPlanSet | undefined = carry
    ? { doc: carry.record.changeSet, members: carry.record.members, plans: {}, outputs: carry.record.planOutputs, failed: false }
    : undefined;
  let approval: PrApproval = carry?.approval ?? { status: "pending" };
  let via: "merges" | "gate" = "gate";
  const report = (input: { status: PrReport["status"]; refusal?: PrReport["refusal"]; message?: string }) => {
    const set = approved ?? { doc: composeChangeSet([]), members: [], plans: {}, outputs: {}, failed: false };
    const members = set.members.map((m): PrMember => {
      const now = after.get(m.member);
      if (now) return { ...m, status: now.status, ...(now.error ? { error: now.error } : {}), ...(now.blockedBy ? { blockedBy: now.blockedBy } : {}) };
      if (completed.has(m.component)) return { ...m, status: "applied" };
      const by = blockedSoFar.get(m.component);
      if (by !== undefined) return { ...m, status: "blocked", blockedBy: by };
      return failedSoFar.has(m.component) ? { ...m, status: "failed" } : m;
    });
    return prReport({ ...reportBase, set, approval, members, waves, ...input });
  };

  // `--wave <k>` reached before an earlier wave applied: nothing runs, as `fan-out --wave` refuses.
  // #4291: an earlier member that failed, or was blocked by one that failed, counts as settled; it blocks its dependents here.
  const left = firstLeft();
  const earlierWaiting = only !== undefined ? waves.find((w) => w.wave < only && w.status === "waiting" && w.components.some((name) => !completed.has(name))) : undefined;
  if (earlierWaiting) {
    return stop(
      report({
        status: "refused",
        refusal: "earlier-wave",
        message: `Wave ${only} does not run yet: wave ${earlierWaiting.wave} waits at its gate ${earlierWaiting.gate}. Nothing was applied. Approve that wave and run its job again, then this one.`,
      }),
      GATED_EXIT_CODE,
    );
  }
  const settled = only !== undefined && left > 0 && left < only ? settleEarlierWaves(p.plan.waves, only, upstreams, outcomes()) : undefined;
  if (settled) for (const [name, o] of settled.outcomes) if (o.status === "blocked" && o.by) blockedSoFar.set(name, o.by);
  if (only !== undefined && left > 0 && left < only && (settled?.unsettled.length ?? 0) > 0) {
    return stop(
      report({
        status: "refused",
        refusal: "earlier-wave",
        message:
          `Wave ${only} cannot run yet: wave ${left} has not applied (${leftIn(left).join(", ")})${carry ? "" : ", and no --resume record of this apply says otherwise"}. ` +
          `Nothing was applied. Run wave ${left}'s job first, with the same --resume record.`,
      }),
      1,
    );
  }

  let judged: PolicyJudged = { held: false };
  if (carry) {
    // What the earlier waves applied settles first (#4007), each in its own wave, as a resumed apply's does.
    p.plan.waves.forEach((names, i) => {
      for (const component of names.filter((name) => completed.has(name))) {
        const body: RunEventComponentSettle = { type: "component-settle", wave: i + 1, component, status: "already-applied" };
        events?.emit(body);
        log(body);
      }
    });
    emitResumedGate(events, op, p.gate, carry.check);
  } else {
    const set = await planAll(p, events?.emit);
    approved = set;
    if (set.failed) {
      if (set.policyDenied) return stop(report({ status: "plan-failed", message: "The policy denied a member's plan, so nothing was applied." }), CHANT_EXIT.denied);
      return stop(report({ status: "plan-failed", message: "A member failed to plan, so there is no plan to compare with the approved one. Nothing was applied." }), 1);
    }
    await storeChangeSetForGate(ctx, p, set.doc);
    // #4294: the policy at base judges the whole change set, before the pull request's gate.
    judged = await judgePolicy(p, { stage: "apply", op, pr, set });
    if (judged.stop) return stop(report({ status: "refused", refusal: judged.stop.refusal, message: judged.stop.message }), judged.stop.code);
    const decided = await decideApplyGate(p, { op, pr, set, events, held: judged.held, ...(green ? { green } : {}) });
    approval = decided.approval;
    // #4323: the after-gate hooks hear the decision, a refusal too.
    const afterGate = await runGateHook(p, { op, digest: set.doc.digest, satisfied: decided.satisfied }, p.plan.order);
    if (afterGate && decided.satisfied) return stop(report({ status: "failed", message: afterGate }), 1);
    if (!decided.satisfied) return stop(report({ status: "refused", refusal: decided.refusal, message: decided.message }), decided.refusal === "plan-changed" ? CHANT_EXIT.moved : CHANT_EXIT.waiting);
    via = decided.via;
  }
  const approvedSet = approved!;

  const review = reviewFor(args, p, pr, green);
  const prReview = await review(approval.approvedBy ?? [], "The plan");
  if (prReview && "error" in prReview) return fail(prReview.error);
  if (prReview) {
    emitReviewStop(events, prReview.message);
    return stop(report({ status: "refused", refusal: prReview.refusal, message: prReview.message }), GATED_EXIT_CODE);
  }
  const unspent = await spendPolicy(op, judged, p.head);
  if (unspent) return stop(report({ status: "refused", refusal: "policy-denied", message: unspent }), 1);

  const recordAttempt = (): void => {
    if (!resumePath) return;
    writeFanOutAttempt(resumePath, {
      digest: p.plan.digest,
      completed: [...completed].sort(),
      failed: [...failedSoFar].sort(),
      outputs: outputsSoFar,
      inputs: Object.fromEntries(Object.entries(inputsSoFar).sort(([a], [b]) => a.localeCompare(b))),
      prApply: {
        op,
        gate: p.gate,
        head: p.head,
        digest: approvedSet.doc.digest,
        approvedBy: approval.approvedBy ?? [],
        members: approvedSet.members,
        changeSet: approvedSet.doc,
        planOutputs: approvedSet.outputs,
        ...(waves.length > 0 ? { waves } : {}),
      },
    });
  };
  const setWave = (wave: PrWave): void => {
    waves = [...waves.filter((w) => w.wave !== wave.wave), wave].sort((a, b) => a.wave - b.wave);
    recordAttempt();
  };
  recordAttempt();

  const from = only ?? (left || total + 1);
  const to = only ?? total;
  /** The last apply in this job that failed (#4291): its results give the exit code once every wave ran. */
  let lastFailure: { exitCode: number } | undefined;
  let planFailedIn: number | undefined;
  // #4588: the outputs file the waves' plan-wave and apply-wave steps hand outputs on in.
  const { componentWaveOutputsFile } = await import("../../components/product-pipeline");
  const outputsFile = componentWaveOutputsFile(op);
  for (let k = from; k <= to; k++) {
    // #4291: a component of this wave whose upstream failed, or was blocked by a failure, is blocked; the rest of the wave runs.
    const before = new Set(p.plan.waves.slice(0, k - 1).flat());
    const mine = leftIn(k);
    for (const name of mine) {
      failedSoFar.delete(name);
      blockedSoFar.delete(name);
    }
    const outcomesNow = outcomes();
    for (const [name, by] of blockedSoFar) outcomesNow.set(name, { status: "blocked", by });
    const blockedNow = blockedMembers(mine, upstreams, before, outcomesNow);
    for (const [name, by] of blockedNow) blockedSoFar.set(name, by);
    if (blockedNow.size > 0) console.error(formatWarning({ message: `wave ${k}: ${blockedWords(blockedNow)}, so not planned or applied`, hint: "A failure blocks only the members that depend on it; the rest of the wave goes on." }));
    const wavePlan = prWavePlan(p.plan, p.components, k, [...completed, ...blockedNow.keys()]);
    if (wavePlan.order.length === 0) {
      if (blockedNow.size > 0) recordAttempt();
      continue;
    }
    // #4588: the wave plans, waits or passes its gate, and applies on op waves: the component waves spec,
    // each run a component, through the component plan-wave and apply-wave steps.
    const pending: PrWave = { wave: k, components: wavePlan.order, status: "applied", approval: "pull-request", gate: p.gate, digest: approvedSet.doc.digest };
    // #4288: the wave's apply-side hooks, around its apply.
    const waveBefore = await runStageHook(p, "before-apply", wavePlan.order, undefined, `nothing in wave ${k} was applied`);
    if (waveBefore) {
      setWave({ ...pending, status: "failed" });
      return stop(report({ status: "failed", message: waveBefore }), 1);
    }
    // The outputs the waves before this one left, and the approved set's for what has not applied yet, seed its plans.
    const notApplied = Object.fromEntries(Object.entries(approvedSet.outputs).filter(([name]) => !completed.has(name)));
    mkdirSync(dirname(resolve(outputsFile)), { recursive: true });
    writeFileSync(resolve(outputsFile), JSON.stringify({ ...p.seededOutputs, ...notApplied, ...outputsSoFar }, null, 2) + "\n");
    const ran = await runComponentWave(p, { op, waveGate, k, runs: wavePlan.order, approved: approvedSet.doc, approvedBy: approval.approvedBy ?? [], outputsFile, ...(args.noReleaseRecord ? { noReleaseRecord: true } : {}), review, ...(events ? { events } : {}), log });
    const entry = ran.entry;
    if (ran.review && "error" in ran.review) return fail(ran.review.error);
    if (ran.review && ran.exitCode === CHANT_EXIT.waiting) {
      setWave(entry);
      emitReviewStop(events, ran.review.message);
      return stop(report({ status: "refused", refusal: ran.review.refusal, message: ran.review.message }), GATED_EXIT_CODE);
    }
    for (const name of ran.applied) {
      completed.add(name);
      failedSoFar.delete(name);
      if (inputsNow[name] !== undefined) inputsSoFar[name] = inputsNow[name]!;
      if (ran.outputs[name]) outputsSoFar[name] = ran.outputs[name]!;
    }
    for (const name of ran.failed) failedSoFar.add(name);
    if (ran.exitCode === CHANT_EXIT.waiting || ran.exitCode === CHANT_EXIT.moved) {
      setWave(entry);
      // #4003: the wave's new plan beside the report, for whoever approves its gate.
      if (ran.changeSet) writeWaveChangeSet(ctx, k, ran.changeSet, upload);
      const approveLine = prApproveCommand({ op, gate: entry.gate, digest: entry.digest });
      const message =
        ran.exitCode === CHANT_EXIT.moved
          ? `Wave ${k}'s plan changed after its approval, so nothing in it was applied.${entry.approved ? ` approved: ${entry.approved}; planned now: ${entry.digest}.` : ""} Read the new plan, and if it is right, approve it: ${approveLine}; then run the wave's apply again.`
          : `Wave ${k} was planned after the waves before it applied, and the pull request's approved plan does not cover it${entry.moved?.length ? `: ${entry.moved.join("; ")}` : ""}. ` +
            `Nothing in wave ${k} was applied. Read its plan, and if it is right, approve it: ${approveLine}; then run the wave's apply again.`;
      return stop(report({ status: "refused", refusal: ran.exitCode === CHANT_EXIT.moved ? "wave-plan-changed" : "wave-not-approved", message }), ran.exitCode);
    }
    if (ran.exitCode === CHANT_EXIT.held) {
      setWave({ ...entry, status: "waiting" });
      return stop(report({ status: "refused", refusal: "locked", message: `Wave ${k}: another run holds what it changes, so nothing in it was applied.` }), CHANT_EXIT.held);
    }
    if (ran.exitCode === CHANT_EXIT.denied || ran.exitCode === CHANT_EXIT.declined || ran.exitCode === CHANT_EXIT.superseded) {
      setWave({ ...entry, status: "failed" });
      return stop(report({ status: "failed", message: `Wave ${k} stopped on op waves with exit ${ran.exitCode}; nothing more was applied.` }), ran.exitCode);
    }
    const waveAfter = await runStageHook(p, "after-apply", wavePlan.order.filter((name) => ran.applied.includes(name)), undefined, `wave ${k} counts as failed though its components applied`);
    setWave({ ...entry, status: ran.exitCode === CHANT_EXIT.done && !waveAfter ? "applied" : "failed" });
    if (ran.exitCode !== CHANT_EXIT.done) {
      // #4291: a failed member blocks only its dependents, so the later waves still run.
      lastFailure = { exitCode: ran.exitCode };
      recordAttempt();
      continue;
    }
    if (waveAfter) return stop(report({ status: "failed", message: waveAfter }), 1);
    console.error(formatSuccess(`applied wave ${k} of ${total} under ${entry.approval === "pull-request" ? `the pull request's approval of ${approvedSet.doc.digest}` : `${entry.gate}, approved for ${entry.digest}`} by ${(entry.approvedBy ?? []).join(", ")}`));
  }

  // #4291: a failure, or a member it blocked, fails the job once every other member applied.
  const blockedHere = [...blockedSoFar.keys()].filter((name) => (only === undefined ? true : (p.plan.waves[only - 1] ?? []).includes(name)));
  if (lastFailure || planFailedIn !== undefined || blockedHere.length > 0) {
    const blockedLine = blockedSoFar.size > 0 ? ` Blocked: ${blockedWords(blockedSoFar)}.` : "";
    const message = planFailedIn !== undefined && !lastFailure
      ? `A member of wave ${planFailedIn} failed to plan, so nothing in wave ${planFailedIn} was applied.${blockedLine}`
      : blockedLine ? blockedLine.trim() : undefined;
    return stop(
      report({ status: "failed", ...(message ? { message } : {}) }),
      lastFailure ? lastFailure.exitCode : 1,
    );
  }

  const done = p.plan.order.every((name) => completed.has(name));
  const lost = green && done ? await recordGreenApplied(p, green, approvedSet.doc.digest, approval, via) : false;
  return stop(report({ status: done ? "applied" : "wave-applied" }), lost ? 1 : 0);
}

// ── The component plan-wave and apply-wave steps (#4588) ─────────────────────

/** The outputs earlier waves' components left, from `--wave-outputs`; empty when the file is not there yet. */
function readWaveOutputs(file: string | undefined): { outputs: Record<string, Record<string, unknown>> } | { error: string } {
  if (!file || !existsSync(resolve(file))) return { outputs: {} };
  try {
    const parsed = JSON.parse(readFileSync(resolve(file), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `--wave-outputs ${file} must hold { "<component>": { ...outputs } }` };
    return { outputs: parsed as Record<string, Record<string, unknown>> };
  } catch (err) {
    return { error: `--wave-outputs: could not read "${file}": ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The runs `chant run wave` wrote to `{runs}`: their targets, each a component, and on apply-wave the digest each was approved at. */
function readWaveRuns(file: string | undefined): Array<{ target: string; planDigest?: string }> | { error: string } {
  if (!file) return { error: "the step needs --runs <file>, which chant run wave fills in as {runs}" };
  try {
    const parsed = JSON.parse(readFileSync(resolve(file), "utf8")) as { runs?: unknown };
    if (!Array.isArray(parsed?.runs)) return { error: `--runs ${file} has no runs` };
    return (parsed.runs as Array<{ target?: unknown; planDigest?: unknown }>).flatMap((r) =>
      typeof r?.target === "string" ? [{ target: r.target, ...(typeof r.planDigest === "string" ? { planDigest: r.planDigest } : {}) }] : [],
    );
  } catch (err) {
    return { error: `--runs: could not read "${file}": ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The fan-out plan of `names`, one wave of the derivation, with the rest of that wave counted as done. */
function namedWavePlan(p: Prepared, names: readonly string[]): FanOutPlan | { error: string } {
  const unknown = names.filter((n) => !p.plan.order.includes(n));
  if (unknown.length > 0) return { error: `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in the change between ${p.base.slice(0, 12)} and ${p.head.slice(0, 12)}, so the wave cannot plan ${unknown.length === 1 ? "it" : "them"}` };
  const k = p.plan.waves.findIndex((w) => w.includes(names[0]!)) + 1;
  const wave = p.plan.waves[k - 1] ?? [];
  const across = names.filter((n) => !wave.includes(n));
  if (across.length > 0) return { error: `${names[0]} and ${across.join(", ")} are in different waves of the derivation, so one wave step cannot plan them together` };
  return prWavePlan(p.plan, p.components, k, wave.filter((n) => !names.includes(n)));
}

/** One component's entry in the op-waves plans file: the digest over its members' plans, and whether it changes or destroys anything. */
function componentPlanEntry(set: PrPlanSet, component: string): { target: string; planDigest: string; empty?: true; destructive?: true } {
  const members = set.members.filter((m) => m.component === component).sort((a, b) => a.member.localeCompare(b.member));
  const names = new Set(members.map((m) => m.member));
  const entries = set.doc.entries.filter((e) => names.has(e.member));
  const changes = entries.filter((e) => e.action !== "no-op" && e.action !== "read");
  const destructive = changes.some((e) => e.action === "delete" || e.action === "replace");
  return {
    target: component,
    planDigest: computePlanDigest("component-wave", members.map((m) => ({ member: m.member, planDigest: m.planDigest }))),
    ...(changes.length === 0 ? { empty: true as const } : {}),
    ...(destructive ? { destructive: true as const } : {}),
  };
}

/** The files a component wave step names: `{runs}`, `{plans}` and the outputs file. */
interface WaveStepFiles {
  runs: Array<{ target: string; planDigest?: string }>;
  plansFile: string;
  outputsFile?: string;
  outputs: Record<string, Record<string, unknown>>;
}

/** Read the step's runs and outputs files from its flags. */
function waveStepFiles(args: Pick<CommandContext["args"], "runsFile" | "plansFile" | "waveOutputs">): WaveStepFiles | { error: string } {
  const runs = readWaveRuns(args.runsFile);
  if ("error" in runs) return runs;
  if (!args.plansFile) return { error: "the step needs --plans <file>, which chant run wave fills in as {plans}" };
  const read = readWaveOutputs(args.waveOutputs);
  if ("error" in read) return read;
  return { runs, plansFile: args.plansFile, ...(args.waveOutputs ? { outputsFile: args.waveOutputs } : {}), outputs: read.outputs };
}

/** Plan the step's runs, each a component, against the outputs the earlier waves left. */
async function planComponentRuns(p: Prepared, files: WaveStepFiles): Promise<{ set: PrPlanSet; plan: FanOutPlan } | { error: string }> {
  const names = files.runs.map((r) => r.target);
  const plan = names.length > 0 ? namedWavePlan(p, names) : { ...p.plan, order: [], waves: [] };
  if ("error" in plan) return plan;
  const lockGrain = await declaredLockGrainOf(p);
  const set = await planPrSet({ components: p.components, plan, registry: p.registry, env: p.env, seededOutputs: { ...p.seededOutputs, ...files.outputs }, ...(lockGrain ? { lockGrain } : {}), policyBase: p.base });
  return { set, plan };
}

/** The plan step over `p`: write `{plans}`, one digest per component and the wave's change set. */
async function planComponentWave(p: Prepared, files: WaveStepFiles): Promise<number> {
  const planned = await planComponentRuns(p, files);
  if ("error" in planned) return fail(planned.error);
  const { set } = planned;
  if (set.failed) {
    for (const m of set.members.filter((x) => x.status === "plan-failed")) console.error(formatError({ message: `${m.member} (${m.component}) failed to plan${m.error ? `: ${m.error}` : ""}` }));
    return set.policyDenied ? CHANT_EXIT.denied : 1;
  }
  const file = { runs: files.runs.map((r) => componentPlanEntry(set, r.target)), changeSet: set.doc };
  mkdirSync(dirname(resolve(files.plansFile)), { recursive: true });
  writeFileSync(resolve(files.plansFile), JSON.stringify(file, null, 2) + "\n");
  console.error(formatInfo(`planned ${files.runs.length} component${files.runs.length === 1 ? "" : "s"}: ${files.runs.map((r) => r.target).join(", ") || "(none)"}; change set ${set.doc.digest}`));
  return 0;
}

/** The apply step over `p`: plan the approved runs again, refuse a moved one with 4, else lease, apply, record, and hand the outputs on. */
async function applyComponentWave(p: Prepared, files: WaveStepFiles, opts: { noReleaseRecord?: boolean; onRunEvent?: RunEventSink; runsResult?: string } = {}): Promise<number> {
  if (files.runs.length === 0) return 0;
  const planned = await planComponentRuns(p, files);
  if ("error" in planned) return fail(planned.error);
  const { set, plan } = planned;
  if (set.failed) return fail("A component of the wave failed to plan again, so nothing in it was applied.");
  const moved = files.runs.filter((r) => r.planDigest !== undefined && !samePlanDigest(componentPlanEntry(set, r.target).planDigest, r.planDigest));
  if (moved.length > 0) {
    console.error(formatError({ message: `${moved.map((r) => r.target).join(", ")} now plan${moved.length === 1 ? "s" : ""} something other than the approved plan, so nothing in the wave was applied.`, hint: "Run the wave's job again to plan it afresh and decide its gate." }));
    return CHANT_EXIT.moved;
  }
  const lease = await leaseSetRows(p, set);
  if (typeof lease === "number") return lease;
  if ("held" in lease) {
    console.error(formatError({ message: lease.held }));
    return CHANT_EXIT.held;
  }
  const lockGrain = await declaredLockGrainOf(p);
  const release = autoReleaseRun(`wave-${Date.now()}`);
  let applied: Awaited<ReturnType<typeof applyPrSet>>;
  try {
    applied = await applyPrSet({ components: p.components, plan, registry: p.registry, env: p.env, set, gate: p.gate, ...(lockGrain ? { lockGrain } : {}), policyBase: p.base, ...(opts.onRunEvent ? { onRunEvent: opts.onRunEvent } : {}) });
  } finally {
    await lease.release();
  }
  await recordAutoReleasesForRun(applied.run.results, p.env, release.runId, resolveAutoReleaseDisabled(p.config, opts.noReleaseRecord), release.runOrigin, undefined, undefined, prAppliedDigests(p, applied.members));
  if (files.outputsFile) {
    const next = { ...files.outputs };
    for (const name of applied.run.completed) next[name] = applied.run.componentOutputs[name] ?? {};
    mkdirSync(dirname(resolve(files.outputsFile)), { recursive: true });
    writeFileSync(resolve(files.outputsFile), JSON.stringify(next, null, 2) + "\n");
  }
  for (const m of applied.members) console.error(m.status === "applied" ? formatSuccess(`applied ${m.member} (${m.component})`) : formatWarning({ message: `${m.member} (${m.component}): ${m.status}${m.error ? `, ${m.error}` : ""}` }));
  // #4291: the components that applied, so op waves fails only the others and blocks only what depends on them.
  const runsResult = opts.runsResult ?? (process.env.CHANT_APPLY_RUNS_RESULT ? resolve(process.env.CHANT_APPLY_RUNS_RESULT) : undefined);
  if (runsResult && applied.status !== "applied") {
    mkdirSync(dirname(runsResult), { recursive: true });
    writeFileSync(runsResult, JSON.stringify({ applied: [...applied.run.completed].sort() }, null, 2) + "\n");
  }
  return applied.status === "applied" ? 0 : applied.status === "waiting" ? CHANT_EXIT.waiting : 1;
}

/**
 * `chant components plan-wave --runs <file> --plans <file> --base <ref>
 * --env <env> [--member <m>] [--wave-outputs <file>]` (#4588): the
 * component plan step of a component waves spec. Plans each run, a
 * component, through the project's capabilities against the outputs the
 * waves before it left, and writes `{plans}`: one digest per component over
 * its members' plans, and the wave's change set, which a `pull-request`
 * wave checks the pull request's approval against.
 */
export async function runComponentsPlanWave(ctx: CommandContext): Promise<number> {
  const files = waveStepFiles(ctx.args);
  if ("error" in files) return fail(files.error);
  const p = await prepare(ctx, "apply");
  if (typeof p === "number") return p;
  return planComponentWave(p, files);
}

/**
 * `chant components apply-wave --runs <file> --plans <file> --base <ref>
 * --env <env> [--member <m>] [--wave-outputs <file>]` (#4588): the
 * component apply step. Plans the approved runs again and exits 4 when a
 * component's plan is not the one approved; else leases its rows on the
 * resource grain, applies, records the releases, and adds each applied
 * component's outputs to `--wave-outputs` for the next wave.
 */
export async function runComponentsApplyWave(ctx: CommandContext): Promise<number> {
  const files = waveStepFiles(ctx.args);
  if ("error" in files) return fail(files.error);
  const p = await prepare(ctx, "apply");
  if (typeof p === "number") return p;
  return applyComponentWave(p, files, { noReleaseRecord: ctx.args.noReleaseRecord });
}

/**
 * The component steps in this process (#4588): `pr-apply --wave-gate`
 * already holds the prepared project, so the plan-wave and apply-wave lines
 * of its spec run here against it, rather than in a process that would
 * derive the change again.
 */
function componentWaveExec(p: Prepared, noReleaseRecord?: boolean, onRunEvent?: RunEventSink): (argv: string[], cwd: string, env?: Record<string, string>) => Promise<number> {
  return async (argv, cwd, env) => {
    const at = argv.findIndex((a, i) => a === "components" && (argv[i + 1] === "plan-wave" || argv[i + 1] === "apply-wave"));
    if (at < 0) return fail(`not a component wave step: ${argv.join(" ")}`);
    let args: CommandContext["args"];
    try {
      args = parseArgs(argv.slice(at));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const files = waveStepFiles(args);
    if ("error" in files) return fail(files.error);
    const runsResult = env?.CHANT_APPLY_RUNS_RESULT ? resolve(cwd, env.CHANT_APPLY_RUNS_RESULT) : undefined;
    return argv[at + 1] === "plan-wave" ? planComponentWave(p, files) : applyComponentWave(p, files, { noReleaseRecord, ...(onRunEvent ? { onRunEvent } : {}), ...(runsResult ? { runsResult } : {}) });
  };
}

/**
 * A gate ledger that holds the approval `pr-apply` already decided (#4588):
 * an approval of the pull request's gate under its op, for the approved
 * change set, so an op wave of the component waves spec finds the approval
 * a pull request (or a green commit's merges) gave and checks its own plan
 * against it. Everything else is the real ledger's.
 */
function withDecidedApproval(port: GateLedgerPort, at: { op: string; gate: string; digest: string; approvedBy: string[]; timestamp: string }): GateLedgerPort {
  return {
    ...port,
    appendPending: (input) => port.appendPending(input),
    async read(op) {
      const got = await port.read(op);
      if (op !== at.op) return got;
      const decided: GateResolutionRecord = { version: 1, kind: "resolution", op: at.op, gate: at.gate, resolvedBy: at.approvedBy.join(", ") || "pr-apply", timestamp: at.timestamp, planDigest: at.digest, changeSet: at.digest };
      return { ...got, resolutions: [...got.resolutions, decided] };
    },
  };
}

/**
 * The review rule on a wave's own gate (#4000, #4588): `--require-review`
 * judges an approval of the wave's gate as it judges the pull request's, so
 * an approval it refuses never reaches the op wave, which then waits. The
 * refusal is kept in `refused` for pr-apply's report. The pull request's gate
 * was judged before the waves ran, so its approvals pass as they are.
 */
function withWaveReview(port: GateLedgerPort, at: { prGate: string; what: string; review: (approvedBy: readonly string[], what: string) => Promise<ReviewStop>; refused: { stop?: ReviewStop } }): GateLedgerPort {
  return {
    ...port,
    async read(op) {
      const got = await port.read(op);
      const resolutions: GateResolutionRecord[] = [];
      for (const r of got.resolutions) {
        const stop = r.gate === at.prGate ? undefined : await at.review([r.resolvedBy], at.what);
        if (stop) at.refused.stop ??= stop;
        else resolutions.push(r);
      }
      return { ...got, resolutions };
    },
  };
}

/** What one wave of `pr-apply --wave-gate` on op waves came to (#4588). */
interface ComponentWaveOutcome {
  exitCode: number;
  applied: string[];
  failed: string[];
  entry: PrWave;
  /** The wave's outputs file after it ran. */
  outputs: Record<string, Record<string, unknown>>;
  /** The wave's new plan, when it planned: what an approval of its own gate is asked for. */
  changeSet?: PrPlanSet["doc"];
  /** Why `--require-review` refused an approval of the wave's own gate (#4000). */
  review?: ReviewStop;
}

/**
 * Run wave `k` of `pr-apply --wave-gate` on op waves (#4588): the component
 * waves spec with the wave's runs left to apply, read at base as chant
 * wrote it (the spec is chant's, never the change's), decided under the
 * approval pr-apply holds, planned and applied through the component
 * plan-wave and apply-wave steps.
 */
async function runComponentWave(
  p: Prepared,
  at: {
    op: string;
    waveGate: string;
    k: number;
    runs: string[];
    approved: PrPlanSet["doc"];
    approvedBy: string[];
    outputsFile: string;
    noReleaseRecord?: boolean;
    review: (approvedBy: readonly string[], what: string) => Promise<ReviewStop>;
    events?: RunEventStream;
    log: (body: RunEventBody) => void;
  },
): Promise<ComponentWaveOutcome> {
  const { componentWavesSpec, componentWaveSteps, PRODUCT_WAVES_SPEC_DIR: PRODUCT_WAVES_DIR } = await import("../../components/product-pipeline");
  const { runOpWave, opWavePlansPath } = await import("../../op/op-waves-run");
  const words = activeProductWords();
  const cwd = resolve(".");
  const steps = componentWaveSteps({ ...(words.bin ? { bin: words.bin } : {}), env: p.env, base: p.base, head: p.head, ...(p.member ? { member: p.member } : {}), op: at.op, gate: p.gate, outputs: at.outputsFile });
  const waves = p.plan.waves.map((w, i) => (i === at.k - 1 ? at.runs : w));
  const spec = componentWavesSpec(p.components, words, steps, { op: at.op, gate: at.waveGate, prGate: p.gate, waves });
  const specFile = `${PRODUCT_WAVES_DIR}/${at.op}.spec.json`;
  const refused: { stop?: ReviewStop } = {};
  const result = await runOpWave({
    spec,
    specFile,
    wave: at.k,
    base: p.base,
    head: p.head,
    cwd,
    show: () => ({ sha: p.base, text: JSON.stringify(spec) }),
    gates: withWaveReview(withDecidedApproval(gitGateLedgerPort(), { op: at.op, gate: p.gate, digest: at.approved.digest, approvedBy: at.approvedBy, timestamp: new Date().toISOString() }), {
      prGate: p.gate,
      what: `Wave ${at.k}'s plan`,
      review: at.review,
      refused,
    }),
    // pr-apply's report and the `chant ci run` record stand for the job, so the wave writes no op-wave run record beside them.
    runs: { append: async () => {} },
    changeSets: async (digest) => {
      if (samePlanDigest(digest, at.approved.digest)) return at.approved;
      const { readStoredChangeSet } = await import("../../lifecycle/change-set-store");
      const got = await readStoredChangeSet(digest, { cwd });
      return got.status === "found" ? got.document : undefined;
    },
    lockGate: p.gate,
    // The apply's run events nest in pr-apply's stream with the derivation's wave number, as its log does.
    waveExec: componentWaveExec(p, at.noReleaseRecord, (body) => {
      const numbered = inWave(body, at.k);
      at.events?.nested(numbered);
      if (numbered.type !== "run-start") at.log(numbered);
    }),
    // The outcome files of this commit's waves alone, so a run of another commit on the same checkout blocks nothing here.
    outcomeDir: `${PRODUCT_WAVES_DIR}/${at.op}/outcomes-${p.head.slice(0, 12)}`,
  });
  const d = result.decision;
  const byPullRequest = d?.via === "pull-request";
  // #4553: an approval of the wave's own gate stands, but for another plan: the plan moved after its approval.
  const exitCode = result.exitCode === CHANT_EXIT.waiting && !byPullRequest && d?.mismatch && !refused.stop ? CHANT_EXIT.moved : result.exitCode;
  const entry: PrWave = {
    wave: at.k,
    components: at.runs,
    status: exitCode === CHANT_EXIT.done ? "applied" : exitCode === CHANT_EXIT.waiting || exitCode === CHANT_EXIT.moved ? "waiting" : "failed",
    approval: byPullRequest || !d ? "pull-request" : "wave",
    gate: byPullRequest || !d ? p.gate : d.gate,
    digest: byPullRequest || !d ? at.approved.digest : d.digest,
    ...(byPullRequest ? (at.approvedBy.length > 0 ? { approvedBy: at.approvedBy } : {}) : d?.approvedBy ? { approvedBy: [d.approvedBy] } : {}),
    ...(!byPullRequest && d?.coveredBy?.reason ? { moved: [d.coveredBy.reason] } : {}),
    ...(!byPullRequest && d?.mismatch?.approved ? { approved: d.mismatch.approved } : {}),
  };
  // A wave that waits at its own gate is the stream's gate step there, as before op waves (#4003).
  if (d && !byPullRequest && (exitCode === CHANT_EXIT.waiting || exitCode === CHANT_EXIT.moved)) {
    const waiting = { satisfied: false, pending: { op: at.op }, ...(d.mismatch ? { mismatch: d.mismatch } : {}) } as unknown as GateCheck;
    await emitGateStep(at.events?.emit, { op: at.op, gate: d.gate }, async () => waiting, () =>
      d.mismatch ? `wave ${at.k}'s plan changed after its approval. Approve the plan now: ${prApproveCommand({ op: at.op, gate: d.gate, digest: d.digest })}` : `wave ${at.k}'s plan is not the one the pull request approved. Approve it: ${prApproveCommand({ op: at.op, gate: d.gate, digest: d.digest })}`,
    );
  }
  const read = readWaveOutputs(at.outputsFile);
  let changeSet: PrPlanSet["doc"] | undefined;
  try {
    changeSet = (JSON.parse(readFileSync(join(cwd, opWavePlansPath(spec, at.k)), "utf8")) as { changeSet?: PrPlanSet["doc"] }).changeSet;
  } catch {
    // The wave stopped before it planned.
  }
  return { exitCode, applied: result.applied, failed: result.failed, entry, outputs: "error" in read ? {} : read.outputs, ...(changeSet ? { changeSet } : {}), ...(refused.stop ? { review: refused.stop } : {}) };
}

/** A wave's new plan (#4003), beside the report as `change-set-wave-<k>.json`, for whoever approves its gate. */
function writeWaveChangeSet(ctx: CommandContext, wave: number, doc: PrPlanSet["doc"], upload?: PrReportUpload): void {
  const dir = resolve(ctx.args.output ?? PR_REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  const name = `change-set-wave-${wave}.json`;
  const body = JSON.stringify(doc, null, 2) + "\n";
  writeFileSync(join(dir, name), body);
  upload?.file(name, body);
}

/**
 * chant components pr-post --pr <n> --head <sha> --env <env> --forge <kind> [--member <name>] [--output <dir>] [--result <result>] (#4295)
 * chant components pr-post --open --env <env> --forge gitlab [--branch <branch>] [--member <name>] [--output <dir>] (#4328)
 *
 * Post the plan note and the `chant/plan` status from the report a plan job
 * wrote with `pr-plan --no-status`, in a job that runs none of the change's
 * code. The pull request, the head, the environment and the member come from
 * the flags, and a report that names others is refused (`../../pr-post.ts`).
 * It exits 0 once it has posted, whatever the plan said, so the plan job's
 * own result stays the one that fails the run.
 */
export async function runComponentsPrPost(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.stale) return runComponentsPrPostStale(ctx);
  if (args.open) return runComponentsPrPostOpen(ctx);
  if (args.pr === undefined) return fail("pr-post needs the pull or merge request: --pr <n>");
  if (!args.head || !/^[0-9a-f]{40}$/.test(args.head)) return fail("pr-post needs the full commit the plan job checked out: --head <sha>");
  if (!args.env) return fail("pr-post needs the environment the plan was for: --env <env>");
  if (!args.forge || !(FORGE_KINDS as readonly string[]).includes(args.forge)) return fail(`pr-post posts to a forge: --forge ${FORGE_KINDS.join("|")}`);
  if (args.members && args.members.length > 1) return fail(`pr-post takes one --member, not ${args.members.join(", ")}`);
  let forge: PrForge;
  try {
    forge = forgeFromEnv(args.forge as ForgeKind);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const { postPlanReport } = await import("../../pr-post");
  const member = args.members?.[0];
  const description = await descriptionCheckOf(ctx, forge);
  if (typeof description === "number") return description;
  const posted = await postPlanReport({
    forge,
    dir: resolve(args.output ?? PR_REPORT_DIR),
    pr: args.pr,
    head: args.head,
    env: args.env,
    ...(member ? { member } : {}),
    ...(args.planResult ? { result: args.planResult } : {}),
    // #4289: the plan job could not ask the forge, so the note job does, from the Ops at the commit it checked out.
    overdue: () => overdueOps(forge, member),
    ...(description ? { description } : {}),
    // #4628: the target branch's commit for the note's tip line, and the job summary where the forge keeps one.
    ...(args.tip ? { baseTip: args.tip } : {}),
    ...(args.forge !== "gitlab" && process.env.GITHUB_STEP_SUMMARY ? { summaryFile: process.env.GITHUB_STEP_SUMMARY } : {}),
  });
  for (const message of posted.warnings) console.error(formatWarning({ message }));
  if (posted.refused) console.error(formatWarning({ message: `the plan report was not used: ${posted.refused}` }));
  console.error(formatInfo(`pr-post: ${prStatusContext("plan", member)} ${posted.state}: ${posted.description}${posted.noted ? "; note posted" : ""}`));
  return 0;
}

/**
 * The description check pr-post runs after the note (#4629), when the
 * responses turn it on (`--respond description=check`, or `CHANT_RESPOND`):
 * the `decide.backends` entry `--decide-backend` names, from chant.config
 * at the commit this job checked out (the target branch's, never the pull
 * request's), and the model `--decide-model` pins. On with no backend is
 * refused, so a pipeline that asks for the check learns it never ran.
 */
async function descriptionCheckOf(ctx: CommandContext, forge: PrForge): Promise<((report: PrReport) => Promise<void>) | undefined | number> {
  const { parseRespondList, resolveResponses } = await import("../../ci-respond");
  const given = ctx.args.respond ? parseRespondList(ctx.args.respond) : {};
  if ("error" in given) return fail(given.error);
  if (resolveResponses(given, process.env, (m) => console.error(formatWarning({ message: m }))).description !== "check") return undefined;
  const name = ctx.args.decideBackend;
  if (!name || !ctx.args.decideModel) return fail("the description check asks a decide service, so it needs --decide-backend <name> and --decide-model <id>", "Name a decide.backends entry of chant.config, or turn the check off: --respond description=off");
  const { loadChantConfig } = await import("../../config");
  let backend;
  try {
    const loaded = await loadChantConfig(process.cwd());
    backend = loaded.config.decide?.backends?.[name];
  } catch (err) {
    return fail(`could not read decide.backends from chant.config: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!backend) return fail(`the description check names the backend ${name}, and chant.config has no decide.backends.${name}`);
  const { backendDescriptionAsk, respondDescription } = await import("../../ci-respond-run");
  const ask = backendDescriptionAsk(backend, { name, model: ctx.args.decideModel, cwd: process.cwd() });
  return async (report) => {
    await respondDescription(forge, report, { ask });
  };
}

/**
 * `pr-post --stale --tip <sha> --env <env> --forge <kind> [--branch <branch>]
 * [--member <name>] [--preview-comment]` (#4628): after a push to the target
 * branch, mark each open pull request's note that was posted against
 * another commit stale, naming the comment that previews again with
 * `--preview-comment`, and set its plan status back to pending
 * (`markStaleNotes`, ../../pr-post.ts). The branch is `--branch`, else the
 * job's (`GITHUB_REF_NAME`, `CI_COMMIT_BRANCH`). It exits 0 once it has
 * marked, as `pr-post` does.
 */
async function runComponentsPrPostStale(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.pr !== undefined || args.head) return fail("pr-post --stale finds each open pull request and its head itself, so it takes no --pr or --head");
  if (!args.tip) return fail("pr-post --stale needs the target branch's commit now: --tip <sha>");
  if (!args.env) return fail("pr-post needs the environment the plan was for: --env <env>");
  if (!args.forge || !(FORGE_KINDS as readonly string[]).includes(args.forge)) return fail(`pr-post posts to a forge: --forge ${FORGE_KINDS.join("|")}`);
  if (args.members && args.members.length > 1) return fail(`pr-post takes one --member, not ${args.members.join(", ")}`);
  const branch = args.branch ?? process.env.CI_COMMIT_BRANCH ?? process.env.GITHUB_REF_NAME;
  if (!branch) return fail("pr-post --stale marks the notes of the pull requests into a branch: run it in a job of a push, or pass --branch <branch>");
  let forge: PrForge;
  try {
    forge = forgeFromEnv(args.forge as ForgeKind);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const member = args.members?.[0];
  const { markStaleNotes } = await import("../../pr-post");
  let done: Awaited<ReturnType<typeof markStaleNotes>>;
  try {
    done = await markStaleNotes({ forge, branch, tip: args.tip, env: args.env, ...(member ? { member } : {}), ...(args.previewComment ? { previewComment: true } : {}) });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  for (const message of done.warnings) console.error(formatWarning({ message }));
  const marked = done.marks.filter((m) => m.marked).map((m) => `#${m.pr}`);
  console.error(formatInfo(`pr-post --stale: ${marked.length > 0 ? `marked ${marked.join(", ")} stale` : "no note to mark"} after ${branch} moved to ${args.tip.slice(0, 12)}`));
  return 0;
}

/**
 * `pr-post --open` (#4328): in a pipeline of the target branch on GitLab,
 * post the plan note and status of every open merge request into it whose
 * plan job settled, reading each report from the plan job's artifacts
 * (`postOpenPlanReports`, ../../pr-post.ts). The branch is `--branch`, else
 * the pipeline's own (`CI_COMMIT_BRANCH`). The plan job is `plan`, or
 * `<member>-plan` with `--member`, as the gitlab lexicon names it, and the
 * artifact path is `--output` from the repository root. It exits 0 once it
 * has posted, as `pr-post` does.
 */
async function runComponentsPrPostOpen(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.pr !== undefined || args.head) return fail("pr-post --open finds each merge request and its head itself, so it takes no --pr or --head");
  if (!args.env) return fail("pr-post needs the environment the plan was for: --env <env>");
  if (args.forge !== "gitlab") return fail("pr-post --open is for a GitLab pipeline of the target branch: --forge gitlab");
  if (args.members && args.members.length > 1) return fail(`pr-post takes one --member, not ${args.members.join(", ")}`);
  const branch = args.branch ?? process.env.CI_COMMIT_BRANCH;
  if (!branch) return fail("pr-post --open posts for the merge requests into a branch: run it in a branch pipeline, or pass --branch <branch>");
  let forge: PrForge;
  try {
    forge = forgeFromEnv("gitlab");
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" });
  if (top.status !== 0) return fail("pr-post --open reads the plan report's path from the repository root, and this directory is not in a git repository");
  const member = args.members?.[0];
  const description = await descriptionCheckOf(ctx, forge);
  if (typeof description === "number") return description;
  const artifactDir = relative(realpathSync(top.stdout.trim()), resolve(args.output ?? PR_REPORT_DIR)).split(sep).join("/");
  const { postOpenPlanReports } = await import("../../pr-post");
  const { gitlabPlanJobName } = await import("../../components/pr-pipeline");
  let done: Awaited<ReturnType<typeof postOpenPlanReports>>;
  try {
    done = await postOpenPlanReports({
      forge,
      branch,
      job: gitlabPlanJobName(member),
      artifactDir,
      env: args.env,
      ...(member ? { member } : {}),
      // #4289: the Ops at the commit this pipeline checked out, the target branch's.
      overdue: () => overdueOps(forge, member),
      ...(description ? { description } : {}),
      // #4628: the target branch's commit this pipeline runs at, which each note's tip line names.
      ...(args.tip ? { baseTip: args.tip } : {}),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  for (const message of done.warnings) console.error(formatWarning({ message }));
  for (const p of done.posts) {
    if (p.skipped) {
      console.error(formatInfo(`pr-post: !${p.pr}: ${p.skipped}`));
      continue;
    }
    const posted = p.posted!;
    for (const message of posted.warnings) console.error(formatWarning({ message: `!${p.pr}: ${message}` }));
    if (posted.refused) console.error(formatWarning({ message: `!${p.pr}: the plan report was not used: ${posted.refused}` }));
    console.error(formatInfo(`pr-post: !${p.pr} ${prStatusContext("plan", member)} ${posted.state}: ${posted.description}${posted.noted ? "; note posted" : ""}`));
  }
  if (done.posts.length === 0) console.error(formatInfo(`pr-post: no open merge request into ${branch} has a ${gitlabPlanJobName(member)} job`));
  return 0;
}
