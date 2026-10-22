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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadChantConfig, resolveAutoReleaseDisabled, type ChantConfig } from "../../config";
import { resolveCommit, resolveMergeBase } from "../../components/changed-files";
import { deriveFanOut, fanOutRegistry } from "../../components/fan-out-support";
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
  waveNotCovered,
  type PrPlanSet,
} from "../../components/pr-run";
import { composeChangeSet, verifyChangeSetDigest } from "../../change-set";
import { waveGateName } from "../../gated-waves";
import { readFanOutAttempt, writeFanOutAttempt, type FanOutAttempt, type PrApplyRecord } from "../../components/fan-out-record";
import { componentInputDigests, progressThatCarries } from "../../components/fan-out-inputs";
import { samePlanDigest } from "../../lifecycle/plan-digest";
import { gitGateLedgerPort, type GateCheck } from "../../op/gate";
import { emitGateStep, gateEventsOf, GATE_PHASE, type RunEventSink, type RunEventStream } from "../../run-event-stream";
import type { RunEventBody, RunEventComponentSettle, RunEventSettleStatus } from "../../run-event";
import { openCliRunEvents, refusesEventsWithJson } from "../run-events";
import { openPrReportUpload, parseReportUrl, reportKey, type PrReportUpload, type ReportTarget } from "../../pr-report-url";
import {
  describePlanChanged,
  PR_APPLY_GATE,
  prApproveCommand,
  prNoteMarker,
  prOp,
  prStatusDescription,
  prStatusContext,
  prStatusState,
  renderPrNote,
  type PrApproval,
  type PrMember,
  type PrReport,
  type PrWave,
  type PrRound,
} from "../../pr-loop";
import { FORGE_KINDS, forgeFromEnv, forgePrincipalOf, type ForgeKind, type PrForge } from "../../pr-forge";
import { GITHUB_COMMENT_LIMIT, GITLAB_NOTE_LIMIT } from "../../plan-summary";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../format";
import { reportUninstalledDependencies } from "../dependencies";
import { findWorkspaceRoot } from "../../project-root";
import { resolveChangedUnits } from "./fan-out";
import { coverByMerges, greenOp, type GreenTarget } from "../../components/green-cover";
import { GATED_EXIT_CODE, autoReleaseRun, recordAutoReleasesForRun } from "./run";
import { appliedDigestOf } from "../../components/auto-release";
import type { CommandContext } from "../registry";
import { withComponentEndpoint } from "../component-endpoint";
import type { ComponentChangeSignal, FanOutPlan } from "../../components/fan-out";
import { failedRunExitCode, type DriverComponent } from "../../components/driver";
import type { CapabilityRegistry } from "../../components/capability";


/** Where the reports land unless `--output` says. */
export const PR_REPORT_DIR = ".chant/pr";

interface Prepared {
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
}

const fail = (message: string, hint?: string): number => {
  console.error(formatError({ message, ...(hint ? { hint } : {}) }));
  return 1;
};

/** Everything both stages share: the change and the derivation. Each stage plans the members itself. */
async function prepare(ctx: CommandContext, stage: "plan" | "apply" | "record"): Promise<Prepared | number> {
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

  let derived;
  try {
    derived = await deriveFanOut({
      path: projectPath,
      units: signal.units,
      sandbox: args.sandbox,
      buildParams: paramsResolution.provenance,
      config,
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

  const env = args.env ?? "local";
  const registry = await fanOutRegistry(projectPath, config);
  return {
    config,
    env,
    ...(member ? { member } : {}),
    base,
    head,
    gate: args.gate ?? PR_APPLY_GATE,
    ...(forge ? { forge } : {}),
    components: derived.components,
    plan: derived.plan,
    signal: derived.signal,
    registry,
    seededOutputs,
  };
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

/** Plan every member the derivation selects. */
function planAll(p: Prepared, onRunEvent?: RunEventSink): Promise<PrPlanSet> {
  return planPrSet({
    components: p.components,
    plan: p.plan,
    registry: p.registry,
    env: p.env,
    seededOutputs: p.seededOutputs,
    ...(onRunEvent ? { onRunEvent } : {}),
  });
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
  if (report.member && report.status === "nothing") return;
  try {
    await forge.upsertNote(report.pr, prNoteMarker(report.env, report.member), note);
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
  const op = prOp(ctx.args.pr, p.member);
  const upload = openUpload(stage, "plan", ctx.args.pr, p);
  // `--events-json` (#4041): planning, then where the approval stands.
  const events = await openCliRunEvents(ctx.args, { kind: "component", name: `pr-plan ${op}`, cwd: resolve(".") }, upload?.line);
  stage.stream = events;
  events?.emit({ type: "run-start", waves: p.plan.waves });
  const set = await planAll(p, events?.emit);

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
  const report = prReport({
    stage: "plan",
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
  await finish(ctx, p, report, upload);
  // The plan stage settles on its planning: an approval still to come is what it reports, not a stop.
  events?.settle(settleOf(status), status === "plan-failed" ? "a member failed to plan" : undefined);

  console.error(formatInfo(`pr-plan: ${report.members.length} member(s), ${status}`));
  printMembers(report);
  if (status === "planned") {
    console.error(formatInfo(`plan    : ${report.digest}`));
    console.error(formatInfo(approval.status === "approved" ? `approved by ${(approval.approvedBy ?? []).join(", ")}` : `approve : ${prApproveCommand(report)}`));
  }
  return status === "plan-failed" ? 1 : 0;
}

/** chant components pr-apply --base <ref> [--pr <n>] [--env <env>] [--gate <name>] [--forge <kind>] [--require-review] [--output <dir>] [--json] [--events-json] [--report-url <url>] */
export function runComponentsPrApply(ctx: CommandContext): Promise<number> {
  if (refusesEventsWithJson(ctx.args, "the stage's report")) return Promise.resolve(1);
  return withStageEvents("pr-apply", ctx, (events) => withComponentEndpoint(ctx, () => prApply(ctx, events)));
}

async function prApply(ctx: CommandContext, stage: StageEvents): Promise<number> {
  // #4168: the review-rules security group turns --require-review on, read from the declaration at base.
  const { securityGroupsAt } = await import("../../workspace/security");
  const reviewRules = !ctx.args.requireReview && securityGroupsAt(process.cwd(), ctx.args.base).has("review-rules");
  if (reviewRules && !ctx.args.forge) return fail("the workspace opts into review-rules, which reads the pull request's reviews, so pr-apply needs --forge <kind>");
  if (reviewRules) ctx = { ...ctx, args: { ...ctx.args, requireReview: true } };
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

  let pr: number | null = args.pr ?? null;
  if (pr === null && !green && p.forge && p.plan.order.length > 0) {
    try {
      pr = await p.forge.pullRequestFor(p.head);
    } catch (err) {
      return fail(`could not ask ${p.forge.kind} which pull request merged ${p.head}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const op = green ? greenOp(green.commit, p.member) : pr === null ? "pr-unknown" : prOp(pr, p.member);
  // The run id the release records carry, chosen before the run so that
  // `--events-json` (#4041, #4007) names the run by it too.
  const release = autoReleaseRun(`${op}-${Date.now()}`);
  const upload = openUpload(stage, "apply", pr, p);
  const events = await openCliRunEvents(args, { kind: "component", name: `pr-apply ${op}`, runId: release.runId, cwd: resolve(".") }, upload?.line);
  stage.stream = events;
  events?.emit({ type: "run-start", waves: p.plan.waves });
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
        message: "A member failed to plan, so there is no plan to compare with the approved one. Nothing was applied.",
      }),
      1,
    );
  }

  // #4022: keep the change set the gate binds on chant/lifecycle under its
  // digest before deciding the gate, so the plan an approval bound, or the
  // one a pending fact waits on, can be read once this job is gone.
  await storeChangeSetForGate(ctx, p, set.doc);

  let approval: PrApproval;
  let via: "merges" | "gate" = "gate";
  if (resumed) {
    approval = resumed.approval;
  } else {
    const decided = await decideApplyGate(p, { op, pr, set, events, ...(green ? { green } : {}) });
    approval = decided.approval;
    if (!decided.satisfied) return stop(prReport({ ...base, approval, status: "refused", refusal: decided.refusal, message: decided.message }), GATED_EXIT_CODE);
    via = decided.via;
  }

  const reviewOf = reviewFor(args, p, pr, green);
  const review = await reviewOf(approval.approvedBy ?? [], "The plan");
  if (review && "error" in review) return fail(review.error);
  if (review) {
    emitReviewStop(events, review.message);
    return stop(prReport({ ...base, approval, status: "refused", refusal: review.refusal, message: review.message }), GATED_EXIT_CODE);
  }

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

  const applied = await applyPrSet({
    components: p.components,
    plan: resumed?.plan ?? p.plan,
    registry: p.registry,
    env: p.env,
    set,
    gate: p.gate,
    decideRound,
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
  recordAttempt();
  await recordAutoReleasesForRun(applied.run.results, p.env, release.runId, resolveAutoReleaseDisabled(p.config, args.noReleaseRecord), release.runOrigin, undefined, undefined, prAppliedDigests(p, applied.members));
  const report = prReport({
    ...base,
    approval,
    status: applied.status,
    members: applied.members,
    ...(resumed ? { resumed: resumed.completed } : {}),
    ...(applied.rounds ? { rounds: applied.rounds } : {}),
    ...(applied.status === "waiting" ? { message: waitingMessage(op, applied.rounds) } : {}),
  });
  // A component that stopped at a gate of its own leaves the apply waiting on
  // a person. A step that refused its plan because the target moved since
  // the approval exits 3, as a moved digest does before anything applies (#3997).
  const exit = applied.status === "applied" ? 0 : applied.status === "waiting" ? GATED_EXIT_CODE : failedRunExitCode(applied.run.results);
  if (green && applied.status === "applied") await recordGreenApplied(p, green, set.doc.digest, approval, via);
  const code = await stop(report, exit, applied.run.status === "gated" ? "gated" : undefined);
  if (applied.status === "applied") console.error(formatSuccess(`applied the plan ${report.digest} approved by ${(approval.approvedBy ?? []).join(", ")}`));
  return code;
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
  const { pushLifecycleReport } = await import("../../lifecycle/git");
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
      const pushed = await pushLifecycleReport();
      if (pushed.pushWarning) console.error(formatWarning({ message: pushed.pushWarning }));
    }
  } catch (err) {
    console.error(formatWarning({ message: `could not write the merge record for ${p.head}: ${err instanceof Error ? err.message : String(err)}` }));
  }

  const stop = stopper(ctx, p, events, upload);
  return stop(report, status === "plan-failed" ? 1 : 0);
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
  at: { op: string; pr: number | null; set: PrPlanSet; events?: RunEventStream; green?: GreenTarget },
): Promise<{ approval: PrApproval; satisfied: true; via: "merges" | "gate" } | { approval: PrApproval; satisfied: false; refusal: "plan-changed" | "not-approved"; message: string }> {
  const { op, pr, set, events, green } = at;
  let uncovered: string[] = [];
  if (green) {
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

/** Record the green commit as applied to the environment (#4168 step 9), and push `chant/lifecycle`. A failure warns. */
async function recordGreenApplied(p: Prepared, green: GreenTarget, digest: string, approval: PrApproval, via: "merges" | "gate"): Promise<void> {
  const { writeGreenApply, GREEN_APPLY_CONTRACT } = await import("../../lifecycle/green-apply");
  const { pushLifecycleReport } = await import("../../lifecycle/git");
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
    const pushed = await pushLifecycleReport();
    if (pushed.pushWarning) console.error(formatWarning({ message: pushed.pushWarning }));
  } catch (err) {
    console.error(formatWarning({ message: `could not record ${green.commit.slice(0, 12)} as applied to ${p.env}: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

/** How a stage stops: settle its events, write and publish the report, say how it ended, and return `code`. */
function stopper(ctx: CommandContext, p: Prepared, events: RunEventStream | undefined, upload: PrReportUpload | undefined) {
  return async (report: PrReport, code: number, settle?: RunEventSettleStatus): Promise<number> => {
    events?.settle(settle ?? settleOf(report.status), report.status === "plan-failed" || report.status === "failed" ? report.message ?? `pr-${report.stage} ${report.status}` : undefined);
    await finish(ctx, p, report, upload);
    console.error((code === 0 ? formatInfo : (m: string) => formatWarning({ message: m }))(`pr-${report.stage}: ${report.status}${report.refusal ? ` (${report.refusal})` : ""}`));
    if (report.message) console.error(report.message);
    printMembers(report);
    return code;
  };
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
 * graph (`storeGateChangeSet`), and push. A failure is a warning: the gate
 * decides the same either way.
 */
async function storeChangeSetForGate(ctx: CommandContext, p: Prepared, doc: PrPlanSet["doc"]): Promise<void> {
  const { storeGateChangeSet, gateGraphReader } = await import("../../lifecycle/gate-change-set");
  const { pushLifecycleReport } = await import("../../lifecycle/git");
  const graphArgs = [
    ...(ctx.args.param ?? []).flatMap((kv) => ["--param", kv]),
    ...(ctx.args.paramsFile ? ["--params-file", ctx.args.paramsFile] : []),
  ];
  try {
    const stored = await storeGateChangeSet({ doc, cwd: resolve("."), at: p.head, readGraph: gateGraphReader(graphArgs) });
    if (stored.warning) console.error(formatWarning({ message: stored.warning }));
    // The push's own outcome is said by the gate's pending fact, or by the
    // release records the apply writes, which push the same branch.
    if (stored.written) await pushLifecycleReport();
  } catch (err) {
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
    record,
    completed,
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

/** A run event with its wave renumbered to `wave`: the fan-out that applies one wave numbers it 1. */
function inWave(body: RunEventBody, wave: number): RunEventBody {
  return "wave" in body && typeof (body as { wave?: unknown }).wave === "number" ? ({ ...body, wave } as RunEventBody) : body;
}

/**
 * `pr-apply --wave-gate <gate>` (#4003): apply the pull request's approved
 * set a wave at a time, each wave planned after the one before it applied.
 *
 * The first job plans every member, as pr-apply does, and decides the pull
 * request's gate against that digest. Approved, wave 1 applies with those
 * plans. Each later wave is planned again against the outputs the waves
 * before it left. When the approved change set covers its plan
 * (`planCoveredBy`, as on a resume) it applies under the pull request's
 * approval; when it does not, it waits at `<gate>-wave-<k>` under the pull
 * request's op for an approval of its new plan, and exits 3.
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
  const failedSoFar = new Set<string>();
  let waves: PrWave[] = carry?.record.waves ?? [];
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
      if (now) return { ...m, status: now.status, ...(now.error ? { error: now.error } : {}) };
      return completed.has(m.component) ? { ...m, status: "applied" } : m;
    });
    return prReport({ ...reportBase, set, approval, members, waves, ...input });
  };

  // `--wave <k>` reached before an earlier wave applied: nothing runs, as `fan-out --wave` refuses.
  const left = firstLeft();
  if (only !== undefined && left > 0 && left < only) {
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

  let planned: PrPlanSet | undefined;
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
      return stop(report({ status: "plan-failed", message: "A member failed to plan, so there is no plan to compare with the approved one. Nothing was applied." }), 1);
    }
    await storeChangeSetForGate(ctx, p, set.doc);
    const decided = await decideApplyGate(p, { op, pr, set, events, ...(green ? { green } : {}) });
    approval = decided.approval;
    if (!decided.satisfied) return stop(report({ status: "refused", refusal: decided.refusal, message: decided.message }), GATED_EXIT_CODE);
    via = decided.via;
    planned = set;
  }
  const approvedSet = approved!;

  const review = reviewFor(args, p, pr, green);
  const prReview = await review(approval.approvedBy ?? [], "The plan");
  if (prReview && "error" in prReview) return fail(prReview.error);
  if (prReview) {
    emitReviewStop(events, prReview.message);
    return stop(report({ status: "refused", refusal: prReview.refusal, message: prReview.message }), GATED_EXIT_CODE);
  }

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
  for (let k = from; k <= to; k++) {
    const wavePlan = prWavePlan(p.plan, p.components, k, [...completed]);
    if (wavePlan.order.length === 0) continue;
    const inThisWave = new Set(wavePlan.order);

    // Wave 1 of the apply that just planned every member applies those plans:
    // they are the approved set's. Every other wave is planned again, against
    // the outputs the waves before it left.
    let set: PrPlanSet;
    let entry: PrWave;
    if (planned && k === 1) {
      set = {
        ...planned,
        members: planned.members.filter((m) => inThisWave.has(m.component)),
        plans: Object.fromEntries(Object.entries(planned.plans).filter(([name]) => inThisWave.has(name))),
      };
      entry = { wave: k, components: wavePlan.order, status: "applied", approval: "pull-request", gate: p.gate, digest: approvedSet.doc.digest, ...(approval.approvedBy ? { approvedBy: approval.approvedBy } : {}) };
    } else {
      const notApplied = Object.fromEntries(Object.entries(approvedSet.outputs).filter(([name]) => !completed.has(name)));
      const fresh = await planPrSet({
        components: p.components,
        plan: wavePlan,
        registry: p.registry,
        env: p.env,
        seededOutputs: { ...p.seededOutputs, ...notApplied, ...outputsSoFar },
        ...(events ? { onRunEvent: (body: RunEventBody) => events.emit(body) } : {}),
      });
      if (fresh.failed) {
        for (const m of fresh.members) after.set(m.member, m);
        setWave({ wave: k, components: wavePlan.order, status: "plan-failed", approval: "pull-request", gate: p.gate, digest: approvedSet.doc.digest });
        return stop(report({ status: "plan-failed", message: `A member of wave ${k} failed to plan, so nothing in wave ${k} was applied.` }), 1);
      }
      const moved = waveNotCovered(approvedSet.doc, fresh.doc, approvedSet.members);
      set = fresh;
      if (moved.length === 0) {
        console.error(formatInfo(`wave ${k}: the approved plan covers what it plans now, so it applies under the pull request's approval`));
        entry = { wave: k, components: wavePlan.order, status: "applied", approval: "pull-request", gate: p.gate, digest: approvedSet.doc.digest, ...(approval.approvedBy ? { approvedBy: approval.approvedBy } : {}) };
      } else {
        const gate = waveGateName(waveGate, k);
        const digest = fresh.doc.digest;
        console.error(formatInfo(`wave ${k}: its plan moved since the pull request's (${moved.join("; ")}), so it needs an approval of ${gate}`));
        await storeChangeSetForGate(ctx, p, fresh.doc);
        writeWaveChangeSet(ctx, k, fresh.doc, upload);
        const approveLine = prApproveCommand({ op, gate, digest });
        const check = await emitGateStep(
          events?.emit,
          { op, gate },
          () => decidePrGate(gitGateLedgerPort(), { op, gate, digest, description: `${changeLabel(pr, green)}, wave ${k} of ${total}: ${wavePlan.order.join(", ")}` }),
          (unapproved) =>
            unapproved.mismatch
              ? `wave ${k}'s plan changed after its approval. Approve the plan now: ${approveLine}`
              : `wave ${k}'s plan is not the one the pull request approved. Approve it: ${approveLine}`,
        );
        const waveApproval = approvalOf(check);
        const waiting: PrWave = {
          wave: k,
          components: wavePlan.order,
          status: "waiting",
          approval: "wave",
          gate,
          digest,
          moved,
          ...(waveApproval.approved ? { approved: waveApproval.approved } : {}),
        };
        if (!check.satisfied) {
          setWave(waiting);
          const message =
            waveApproval.status === "changed"
              ? `Wave ${k}'s plan changed after its approval, so nothing in it was applied. approved: ${waveApproval.approved ?? "(none)"}; planned now: ${digest}. ` +
                `Read the new plan, and if it is right, approve it: ${approveLine}; then run the wave's apply again.`
              : `Wave ${k} was planned after the waves before it applied, and the pull request's approved plan does not cover it: ${moved.join("; ")}. ` +
                `Nothing in wave ${k} was applied. Read its plan, and if it is right, approve it: ${approveLine}; then run the wave's apply again.`;
          return stop(report({ status: "refused", refusal: waveApproval.status === "changed" ? "wave-plan-changed" : "wave-not-approved", message }), GATED_EXIT_CODE);
        }
        const waveReview = await review(waveApproval.approvedBy ?? [], `Wave ${k}'s plan`);
        if (waveReview && "error" in waveReview) return fail(waveReview.error);
        if (waveReview) {
          setWave(waiting);
          emitReviewStop(events, waveReview.message);
          return stop(report({ status: "refused", refusal: waveReview.refusal, message: waveReview.message }), GATED_EXIT_CODE);
        }
        entry = { wave: k, components: wavePlan.order, status: "applied", approval: "wave", gate, digest, moved, ...(waveApproval.approvedBy ? { approvedBy: waveApproval.approvedBy } : {}) };
      }
    }

    const applied = await applyPrSet({
      components: p.components,
      plan: wavePlan,
      registry: p.registry,
      env: p.env,
      set,
      // One wave's fan-out numbers its wave 1; the events and the log carry the derivation's number.
      onRunEvent: (body: RunEventBody) => {
        const numbered = inWave(body, k);
        events?.nested(numbered);
        if (numbered.type !== "run-start") log(numbered);
      },
      onComponentSettled: (settled, outputs) => {
        if (settled.status === "ok") {
          completed.add(settled.component);
          if (inputsNow[settled.component] !== undefined) inputsSoFar[settled.component] = inputsNow[settled.component]!;
          if (outputs) outputsSoFar[settled.component] = outputs;
        } else if (settled.status === "fail") {
          failedSoFar.add(settled.component);
        }
        recordAttempt();
      },
    });
    for (const m of applied.members) after.set(m.member, m);
    for (const name of applied.run.completed) {
      completed.add(name);
      const outputs = applied.run.componentOutputs[name];
      if (outputs) outputsSoFar[name] = outputs;
    }
    setWave({ ...entry, status: applied.status === "applied" ? "applied" : "failed" });
    await recordAutoReleasesForRun(applied.run.results, p.env, at.release.runId, resolveAutoReleaseDisabled(p.config, args.noReleaseRecord), at.release.runOrigin, undefined, undefined, prAppliedDigests(p, applied.members));
    if (applied.status !== "applied") {
      return stop(report({ status: "failed" }), failedRunExitCode(applied.run.results), applied.run.status === "gated" ? "gated" : undefined);
    }
    console.error(formatSuccess(`applied wave ${k} of ${total} under ${entry.approval === "pull-request" ? `the pull request's approval of ${approvedSet.doc.digest}` : `${entry.gate}, approved for ${entry.digest}`} by ${(entry.approvedBy ?? []).join(", ")}`));
  }

  const done = p.plan.order.every((name) => completed.has(name));
  if (green && done) await recordGreenApplied(p, green, approvedSet.doc.digest, approval, via);
  return stop(report({ status: done ? "applied" : "wave-applied" }), 0);
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
