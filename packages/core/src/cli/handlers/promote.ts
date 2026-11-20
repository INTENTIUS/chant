/**
 * `chant components promote --from <env> --to <env>` (#2530), `chant
 * components rollback <env>` (#2531) and `chant components redeploy <env>`
 * (#2604): deploy digests a release ledger already records, without a build.
 * A promote takes them from another environment's ledger; a rollback takes an
 * earlier release from the environment's own, and a redeploy the release it
 * records as current. The
 * mechanism lives in ../../components/promote.ts; these handlers read the
 * ledger, print the plan, run it, and append the release records.
 *
 * Every component that deployed gets a record, even when a later component
 * failed or stopped at a gate, so the ledger never misses a deploy that
 * happened. Unlike an auto-recorded release, the record is what these
 * commands are for, so a failed write is an error rather than a warning.
 * A run that applied partly, or failed, also appends a deploy outcome
 * (#4035, ../../lifecycle/deploy-outcome.ts) naming what it did to each
 * component, so `workspace status` reads the environment as mixed.
 *
 * `rollback --release` (#4035) is a promote of an earlier release into the
 * environment: every component of the release at the digest the environment
 * ran from it, through the release gate `promote --release` binds (#4045).
 */

import { ENV_VAR } from "../../env";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadChantConfig, type ChantConfig } from "../../config";
import { promotionOrder } from "../../workspace/promotion-order";
import { releaseTargetRefusal } from "../../components/pr-environment";
import { resolvePromotionSource } from "../../components/promote-order";
import { fetchLifecycle, getHeadCommit, pushLifecycle } from "../../lifecycle/git";
import {
  appendReleaseRecord,
  latestPerComponent,
  readReleaseLedger,
  resolveRunId,
  type ReleaseRecord,
  type ReleaseRecordInput,
} from "../../lifecycle/release-ledger";
import { isComponentList, resolveComponentTargets } from "../../components/cli-support";
import { applyConfigDefaults } from "../../components/config-defaults";
import { componentForEnvironment } from "../../components/step-environments";
import { withDeclaredReads } from "../../components/declared-reads";
import { fanOutRegistry } from "../../components/fan-out-support";
import { renderDriverHuman } from "../../components/driver-output";
import { ndjsonProgressSink } from "../../components/run-progress";
import { openCliRunEvents, refusesBothStreams } from "../run-events";
import {
  parseDigestPins,
  planPromotion,
  planRollback,
  planReleaseRollback,
  planRedeploy,
  withoutBuildSteps,
  runPromotion,
  promotionRecord,
  rollbackRecord,
  redeployRecord,
  gateApprover,
  gatesSkipped,
  gateAdmission,
  type DeployRunInfo,
  type PromotionItem,
  type PromotionPlan,
} from "../../components/promote";
import { failedRunExitCode, type DriverComponent, type DriverRunResult } from "../../components/driver";
import { summaryLedgerPrefix, writeGatedRunSummary } from "../../op/gate-summary";
import { approveCommand, describeGateMismatch, gateIsSealed, gitGateLedgerPort, type GateLedgerPort } from "../../op/gate";
import type { ReleaseGateBinding } from "../../components/driver";
import type { ChangeSetDocument } from "../../change-set";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import { formatError, formatWarning, formatSuccess, formatBold, formatInfo } from "../format";
import { GATED_EXIT_CODE } from "./run";
import type { CommandContext } from "../registry";
import { withComponentEndpoint } from "../component-endpoint";
import { redeployLine, releaseRollbackLine, rollbackTarget, unsettledComponents } from "../../lifecycle/mixed-environment";
import { actorFromEnv } from "../../actor";
import { promoteBase, readPipelineAt } from "../../pipeline/read";
import { pipelinePromoteRejected, pipelinePromoteSoaks, pipelinePromoteSource, pipelineStageEntry, pipelineStageFinished, pipelineUrgentUpstream, promotedDigest, urgentUpstreamStop, type PipelinePromoteStop } from "../../pipeline/promote";
import { gitStageLedgerPort, pauseLine, releaseMissingIn, stagePaused, stagePausedLine, supersededBy, waitingLine, type StageLedgerPort } from "../../pipeline/stage-ledger";
import { stageSoakGate } from "../../pipeline/soak-gate";
import { stageWavesName } from "../../pipeline/stages";
import { stageReleaseItems, stageRunsWaves } from "../../pipeline/stage-waves";
import { canaryStagesBefore } from "../../pipeline/spec";
import { soakCheckReader } from "../../pipeline/soak-checks";
import { jobSoakSources } from "../../pipeline/soak-sources";
import { isPendingGateExpired } from "../../lifecycle/gate-ledger-select";
import { failedVerify } from "../../components/verify-step";
import { failureDetail, memberStatesOf, soakFailureOf, requestedRollbackGate, requestStageRollback, rolledBackLine, stageOnVerifyFail, stageRollbackGate, standingRollbackRequest } from "../../pipeline/verify-rollback";
import { activeProductWords } from "../../ci-product-words";

const PROMOTE_USAGE =
  "chant components promote --to <env> [--from <env>] [--allow-skip] [--pending] [--release <label|digest> [--plan-only]] [--urgent --reason <text>] [--component <name> [--digest <sha256:...>] | --digest <component>=<sha256:...> ...] [--wave-gate <gate>] [--resume <file>] [--dry-run] [--json]";
const ROLLBACK_USAGE =
  "chant components rollback <env> (--component <name> [--digest <sha256:...>] | --release <label|digest> | --requested) [--dry-run] [--json]";
const REDEPLOY_USAGE =
  "chant components redeploy <env> --component <name> [--digest <sha256:...>] [--dry-run] [--json]";

type Verb = "promote" | "rollback" | "redeploy";

/** The release a promote deploys under (#4026), and its target for the environment promoted to. */
interface UnderRelease {
  release: import("../../lifecycle/release-store").Release;
  label: string | null;
  target: import("../../lifecycle/release-store").ReleaseTarget;
}

function renderPlan(verb: Verb, plan: PromotionPlan, removed: Map<string, string[]>): void {
  console.error(formatBold(verb === "promote" ? `promote ${plan.from} -> ${plan.to}` : `${verb} ${plan.to}`));
  for (const item of plan.items) {
    console.error(`  ${item.component}  ${item.digest}`);
    console.error(`    released to ${plan.from} at ${item.source.timestamp} (run ${item.source.runId}, git ${item.source.gitSha.slice(0, 12)})`);
    const kinds = removed.get(item.component) ?? [];
    if (kinds.length > 0) console.error(`    not run: ${kinds.join(", ")}`);
  }
  for (const skipped of plan.notPromoted) {
    console.error(`  ${skipped.component}  not promoted: ${skipped.reason}`);
  }
}

function planJson(plan: PromotionPlan, removed: Map<string, string[]>) {
  return {
    from: plan.from,
    to: plan.to,
    items: plan.items.map((i) => ({
      component: i.component,
      digest: i.digest,
      source: i.source,
      notRun: removed.get(i.component) ?? [],
    })),
    notPromoted: plan.notPromoted,
  };
}

function resolveActor(ctx: CommandContext): string | undefined {
  return ctx.args.actor ?? (actorFromEnv(process.env, "") || undefined);
}

/**
 * Config, params and the declared components, or the exit code of a refusal
 * already printed. `env` is the environment being deployed: it is set as
 * `CHANT_ENV` before the components load, as `--env` sets it for `chant run`
 * (../main.ts), so a component that reads it (a stack name per environment)
 * deploys to that environment and not to the one it was promoted from (#4222).
 */
async function loadProject(ctx: CommandContext, selector: string, env: string) {
  const { args } = ctx;
  process.env[ENV_VAR] = env;
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
  // A comma list is `chant run --components`' selector (#3950), which pulls in
  // dependencies; promote, rollback and redeploy act on the one named component.
  if (isComponentList(selector)) {
    console.error(formatError({ message: `--component takes one component name, not a list ("${selector}")` }));
    return 1;
  }
  const targets = await resolveComponentTargets(projectPath, selector, args.sandbox, paramsResolution.provenance);
  if (!targets.success) {
    console.error(formatError({ message: targets.error ?? "Could not discover components" }));
    return 1;
  }
  return { projectPath, config, targets: targets.targets };
}

async function readLedger(env: string): Promise<ReleaseRecord[]> {
  const ledger = await readReleaseLedger(env);
  if (ledger.malformed > 0) {
    console.error(formatWarning({ message: `${ledger.malformed} malformed line(s) in the "${env}" release ledger were skipped` }));
  }
  return ledger.records;
}

/** What {@link bindReleaseGate} hands the run: the round-one binding, and how to plan and bind a later round or wave (#4168 step 4). */
interface BoundReleaseGate {
  binding: ReleaseGateBinding;
  doc: ChangeSetDocument;
  empty: boolean;
  reads: import("../../components/release-gate").ReleasePlan["reads"];
  plannedOutputs?: Record<string, string[]>;
  unknownInputs?: Record<string, string[]>;
  /** The approval a resume record carried on, when it still covers what is left. */
  resumedFrom?: string;
  /** The groups the plan planned as one (#4465), and the components that could have grouped and did not. */
  groups?: import("../../components/release-gate").ReleasePlanGroup[];
  fallbacks?: import("../../components/fan-out").FanOutGroupFallback[];
  replan: (only: ReadonlySet<string>, outputs: Record<string, Record<string, unknown>>) => Promise<ChangeSetDocument>;
  bind: (doc: ChangeSetDocument, gates: string[]) => Promise<ReleaseGateBinding>;
}

/**
 * Plan, store and bind the release gate for a promote under a release
 * (#4045, ws-104 questions 2 and 6). Undefined when no promoted composition
 * declares a gate, so there is nothing to bind. A number is the exit code of
 * a refusal already printed: a provisional member, or a member that failed
 * to plan. On an empty change set, each gate gets an `empty: true`
 * resolution the run then counts once it reads the stored document back.
 *
 * A dependent is planned against what a promoted upstream's plan says it will
 * expose (#4168 step 4). With a resume record, only what is left is planned,
 * against the outputs the record kept, and the approval the record names
 * carries on when it covers that plan.
 */
async function bindReleaseGate(input: {
  plan: PromotionPlan;
  prepared: DriverComponent[];
  under: UnderRelease;
  registry: Awaited<ReturnType<typeof fanOutRegistry>>;
  port: GateLedgerPort;
  seededOutputs: Record<string, Record<string, unknown>>;
  actor: string;
  projectPath: string;
  head: string | undefined;
  resume?: import("../../components/promote-rounds").PromoteResume;
  /** The grouped fan-out (#4465): its groups plan as one. */
  grouped?: import("../../components/fan-out").FanOutPlan;
  /** Each group plan this binding makes is added here, the newest first, for the run to apply. */
  groupRuns: import("../../components/capability").GroupRun[];
  /** `--plan-only` (#4037): plan and store the change set, and record nothing in the gate ledger, an empty pass included. */
  planOnly?: boolean;
}): Promise<BoundReleaseGate | number | undefined> {
  const { plan, under, port } = input;
  const gate = await import("../../components/release-gate");
  const gates = gate.gateNamesOf(input.prepared);
  if (gates.length === 0) return undefined;
  const env = plan.to;
  const releaseDigest = under.release.releaseDigest;

  // What the environment runs now, to compare each component with.
  const { readRelease } = await import("../../lifecycle/release-store");
  const envRecords = (await readLedger(env)).filter((r) => r.env === env);
  const latest = latestPerComponent(envRecords);
  const releases = new Map<string, import("../../lifecycle/release-store").Release | null>();
  const current = new Map<string, import("../../components/release-gate").CurrentDeploy>();
  for (const item of plan.items) {
    const record = latest.get(item.component);
    if (!record) continue;
    const named = record.releaseDigest;
    if (named !== undefined && !releases.has(named)) releases.set(named, await readRelease(named).catch(() => null));
    current.set(item.component, { record, release: named !== undefined ? (releases.get(named) ?? null) : null });
  }

  // #4035: a component a run left failed or gated runs something the ledger doesn't say.
  const { readDeployOutcomes } = await import("../../lifecycle/deploy-outcome");
  const unsettled = new Map<string, string>();
  for (const [component, u] of unsettledComponents(envRecords, await readDeployOutcomes(env).catch(() => []))) {
    unsettled.set(component, `the ${u.outcome.verb} run ${u.outcome.runId} left ${component} ${u.state} in "${env}" and nothing has been recorded for it since, so what it runs is not known`);
  }

  const digests = new Map(plan.items.map((i) => [i.component, i.digest]));
  const planSet = async (only: ReadonlySet<string> | undefined, outputs: Record<string, Record<string, unknown>>) => {
    const planned = await gate.planReleaseSet({
      release: under.release,
      env,
      components: input.prepared,
      digests,
      registry: input.registry,
      current,
      unsettled,
      seededOutputs: outputs,
      ...(only ? { only } : {}),
      ...(input.grouped ? { grouped: input.grouped } : {}),
    });
    // #4465: the run applies the plan the gate bound, the newest one for a group planned again.
    for (const g of planned.groups ?? []) if (g.run) input.groupRuns.unshift(g.run);
    return planned;
  };
  const groupsOf = (p: Awaited<ReturnType<typeof planSet>>) => ({ ...(p.groups ? { groups: p.groups } : {}), ...(p.fallbacks ? { fallbacks: p.fallbacks } : {}) });

  const { storeGateChangeSet } = await import("../../lifecycle/gate-change-set");
  const { readStoredChangeSet } = await import("../../lifecycle/change-set-store");
  const { isEmptyChangeSet } = await import("../../change-set");
  const verifyEmpty = gate.emptyVerifier((digest) => readStoredChangeSet(digest, { cwd: input.projectPath }), { releaseDigest, environment: env });
  // #4037: a promote a train started under a workspace gate may take that gate's approval in place of its own.
  const { resolveWorkspaceRun } = await import("../../op/workspace-run-env");
  const underWorkspace = resolveWorkspaceRun();
  const workspace = underWorkspace?.gate ? { workspace: releaseWorkspaceGate(input.projectPath, underWorkspace.gate) } : {};

  /** Refuse, store, and pass the gates of an empty plan; the binding, or the exit code of a refusal already printed. */
  const bindDoc = async (doc: ChangeSetDocument, names: readonly string[], what: string): Promise<{ binding: ReleaseGateBinding; empty: boolean } | number> => {
    const provisional = gate.provisionalMembers(doc);
    if (provisional.length > 0) {
      console.error(formatError({
        message: `${what} of release ${under.label ?? releaseDigest} for "${env}" has provisional members (${provisional.join(", ")}), which no approval covers; nothing more was deployed`,
        hint: "Deploy what they read first, so they plan against real values.",
      }));
      return 1;
    }
    const failed = doc.members.filter((m) => m.status === "failed");
    if (failed.length > 0) {
      for (const m of failed) console.error(formatError({ message: `${m.member} failed to plan for "${env}"${m.error ? `: ${m.error}` : ""}` }));
      console.error(formatError({ message: "nothing more was deployed" }));
      return 1;
    }
    // The document is stored before the gate is decided, so the plan a pending
    // gate waits on can be read, and an empty pass can be checked.
    try {
      const stored = await storeGateChangeSet({ doc, cwd: input.projectPath, at: input.head ?? null });
      if (stored.warning) console.error(formatWarning({ message: stored.warning }));
    } catch (err) {
      console.error(formatWarning({ message: `could not store the change set ${doc.digest}: ${err instanceof Error ? err.message : String(err)}` }));
    }
    const empty = isEmptyChangeSet(doc);
    console.error(formatInfo(
      `release gate: ${what} ${doc.digest} for "${env}"` +
        (empty ? ", empty: its gates pass without an approval" : `, ${doc.summary.entries} entr${doc.summary.entries === 1 ? "y" : "ies"}, ${doc.summary.holes} hole(s)`) +
        ` (chant change-set show ${doc.digest})`,
    ));
    if (empty && !input.planOnly) {
      if (!port.appendResolution) throw new Error("the gate ledger can't record a resolution, so an empty change set can't pass its gates");
      const { resolutions } = await port.read(gate.RELEASE_GATE_OP);
      const timestamp = new Date().toISOString();
      for (const name of names) {
        const standing = resolutions.some(
          (r) => r.empty === true && r.gate === name && r.environment === env && r.releaseDigest === releaseDigest && r.planDigest === doc.digest,
        );
        if (standing) continue;
        // Pushed with the resolution; the deploy records the promote writes push the same branch.
        await port.appendResolution(
          gate.emptyResolution({ gate: name, doc, actor: input.actor, timestamp, ...(input.head ? { gitSha: input.head } : {}) }),
        );
      }
    }
    return { binding: { op: gate.RELEASE_GATE_OP, planDigest: doc.digest, releaseDigest, verifyEmpty, ...workspace }, empty };
  };

  const later = {
    replan: async (only: ReadonlySet<string>, outputs: Record<string, Record<string, unknown>>) => (await planSet(only, outputs)).doc,
    bind: async (doc: ChangeSetDocument, names: string[]) => {
      const bound = await bindDoc(doc, names, "a later plan");
      if (typeof bound === "number") throw new PromoteStageRefused();
      return bound.binding;
    },
  };

  // #4168 step 4: a resume plans what is left against the outputs it kept.
  if (input.resume) {
    const done = new Set(input.resume.completed);
    const left = new Set(plan.items.map((i) => i.component).filter((c) => !done.has(c)));
    const fresh = await planSet(left, { ...input.seededOutputs, ...input.resume.outputs });
    const stored = await readStoredChangeSet(input.resume.approvedDigest, { cwd: input.projectPath });
    if (stored.status === "found") {
      const { waveNotCovered } = await import("../../components/pr-run");
      const notCovered = waveNotCovered(stored.document, fresh.doc);
      if (notCovered.length === 0) {
        console.error(formatInfo(`resuming: ${done.size} component(s) applied earlier; what is left is covered by change set ${stored.document.digest}`));
        return {
          doc: stored.document,
          empty: isEmptyChangeSet(stored.document),
          binding: { op: gate.RELEASE_GATE_OP, planDigest: stored.document.digest, releaseDigest, verifyEmpty, ...workspace },
          reads: fresh.reads,
          resumedFrom: stored.document.digest,
          ...groupsOf(fresh),
          ...(fresh.plannedOutputs ? { plannedOutputs: fresh.plannedOutputs } : {}),
          ...(fresh.unknownInputs ? { unknownInputs: fresh.unknownInputs } : {}),
          ...later,
        };
      }
      for (const line of notCovered) console.error(formatWarning({ message: `resume: ${line}` }));
    }
    const bound = await bindDoc(fresh.doc, gates, "change set");
    if (typeof bound === "number") return bound;
    return { doc: fresh.doc, ...bound, reads: fresh.reads, ...groupsOf(fresh), ...(fresh.plannedOutputs ? { plannedOutputs: fresh.plannedOutputs } : {}), ...(fresh.unknownInputs ? { unknownInputs: fresh.unknownInputs } : {}), ...later };
  }

  const first = await planSet(undefined, input.seededOutputs);
  const bound = await bindDoc(first.doc, gates, "change set");
  if (typeof bound === "number") return bound;
  for (const [component, refs] of Object.entries(first.unknownInputs ?? {})) {
    console.error(formatInfo(`${component} reads ${refs.join(", ")}, known only once its upstream applies; it is planned again then, and needs its own approval if its plan moves`));
  }
  return { doc: first.doc, ...bound, reads: first.reads, ...groupsOf(first), ...(first.plannedOutputs ? { plannedOutputs: first.plannedOutputs } : {}), ...(first.unknownInputs ? { unknownInputs: first.unknownInputs } : {}), ...later };
}

/**
 * The workspace gate stand-in for a release gate (#4037, ws-039), loading the
 * workspace code only when a gate is asked about it. The approval must cover
 * this member's gate, change set, environment and release.
 */
function releaseWorkspaceGate(cwd: string, gate: string): import("../../op/gate").WorkspaceGateStandIn {
  return {
    async standIn(q) {
      const { memberGateStandIn } = await import("../../workspace/workspace-gates");
      return memberGateStandIn(cwd, gate, q);
    },
  };
}

/** A later round's or wave's plan was refused (provisional or failed members); the refusal is already printed. */
class PromoteStageRefused extends Error {
  constructor() {
    super("a later round's plan was refused");
    this.name = "PromoteStageRefused";
  }
}

/**
 * The pull requests a release carries into `env` and how each was approved
 * on merge (#4168 decision 2): shown beside the release gate, never counted
 * by it. The commits are the release commit's first-parent history since
 * the commits `env` runs, at most 200, read from the merge records.
 */
async function pullRequestApprovals(release: { commit: string }, since: readonly string[], cwd: string): Promise<Array<import("../../lifecycle/merge-record").MergeRecord>> {
  const { execFileSync } = await import("node:child_process");
  const { readMergeRecord } = await import("../../lifecycle/merge-record");
  let commits: string[] = [];
  try {
    const out = execFileSync("git", ["rev-list", "--first-parent", "--max-count=200", release.commit, ...since.map((c) => `^${c}`)], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    commits = out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const records: Array<import("../../lifecycle/merge-record").MergeRecord> = [];
  for (const commit of commits) {
    const record = await readMergeRecord(commit, { cwd }).catch(() => null);
    if (record) records.push(record);
  }
  return records;
}

/** One line per merge record: where it came from and how its plan stood against its approval. */
function approvalLine(r: import("../../lifecycle/merge-record").MergeRecord): string {
  const from = r.source.kind === "pull-request" ? `#${r.source.pr}` : r.source.kind === "work-item" ? r.source.records.map((x) => `${x.kind}:${x.id}`).join(", ") : "direct push";
  const how =
    r.plan === "approved"
      ? `approved by ${r.approvedBy.join(", ") || "nobody named"}${r.authorApproved?.length ? ` (by its author: ${r.authorApproved.join(", ")})` : ""}`
      : r.plan === "changed"
        ? `its plan moved after the approval of ${r.approvedDigest ?? "another digest"}`
        : r.plan;
  return `${r.commit.slice(0, 12)} ${from}: ${how}`;
}

/**
 * Prepare, run and record a plan. Shared by promote, rollback and redeploy,
 * which differ only in how the plan was chosen, whether the publish step runs,
 * and which field names the earlier release on the new record.
 */
/** {@link deployPlanIn}, with `plan.to`'s declared endpoint applied (#4281). */
function deployPlan(
  ctx: CommandContext,
  verb: Verb,
  plan: PromotionPlan,
  project: { projectPath: string; config: ChantConfig; targets: DriverComponent[] },
  actor: string | undefined,
  record: (item: PromotionItem, env: string, run: DeployRunInfo) => ReleaseRecordInput,
  under?: UnderRelease,
  observe?: (run: DriverRunResult) => void,
): Promise<number> {
  return withComponentEndpoint(ctx, () => deployPlanIn(ctx, verb, plan, project, actor, record, under, observe), { config: project.config, environment: plan.to });
}

async function deployPlanIn(
  ctx: CommandContext,
  verb: Verb,
  plan: PromotionPlan,
  project: { projectPath: string; config: ChantConfig; targets: DriverComponent[] },
  actor: string | undefined,
  record: (item: PromotionItem, env: string, run: DeployRunInfo) => ReleaseRecordInput,
  under?: UnderRelease,
  /** Handed the run once it ended (#5328), so a promote can read each member's state. */
  observe?: (run: DriverRunResult) => void,
): Promise<number> {
  const { args } = ctx;
  if (refusesBothStreams(args)) return 1;
  // #5360: each step's inputs for the environment deployed to, so the plan, the release pin and the run read that environment's target.
  const resolvedFor = new Map(project.targets.map((c) => [c.name, componentForEnvironment(applyConfigDefaults(c, project.config), plan.to)]));
  const byName = new Map([...resolvedFor].map(([name, r]) => [name, r.component]));
  const prepared: DriverComponent[] = [];
  const removed = new Map<string, string[]>();
  const refusals: string[] = plan.items.flatMap((item) => (resolvedFor.get(item.component)?.refusals ?? []).map((r) => r.message));
  // #5401: the gates that name other environments, which this run skips; the plan lists them.
  const skippedGates = plan.items.flatMap((item) => resolvedFor.get(item.component)?.skippedGates ?? []);
  const skippedJson = skippedGates.length > 0 ? { gatesSkipped: skippedGates.map((g) => ({ component: g.component, phase: g.phase, gate: g.gate, environments: g.environments })) } : {};
  const skippedLines = (): void => {
    for (const g of skippedGates) console.error(formatInfo(`${g.component}: gate "${g.gate}" is skipped in "${plan.to}"; it applies in ${g.environments.join(", ")}`));
  };
  if (refusals.length > 0) {
    for (const message of refusals) console.error(formatError({ message }));
    console.error(formatError({ message: `nothing was deployed` }));
    return 1;
  }
  // #4222: a component with no artifact, deployed from the templates the release records, and its record's digest.
  const templateDigests = new Map<string, string>();
  const { releaseTemplatesDigest } = await import("../../components/release-promote");
  for (const item of plan.items) {
    const templates = under ? releaseTemplatesDigest(under.target, item.component) : null;
    // A rollback and a redeploy deploy a release this environment already
    // received, so neither runs the publish step.
    const result = withoutBuildSteps(
      byName.get(item.component)!,
      { ...(verb === "promote" ? {} : { pinDigest: item.digest, verb: `a ${verb}` }), templatesPinned: templates !== null },
    );
    if ("error" in result) refusals.push(result.error);
    else {
      prepared.push(result.component);
      removed.set(item.component, result.removed);
      if (result.templateOnly && templates !== null) templateDigests.set(item.component, templates);
    }
  }
  if (refusals.length > 0) {
    for (const message of refusals) console.error(formatError({ message }));
    console.error(formatError({ message: `nothing was deployed` }));
    return 1;
  }

  // #4026: under a release, the deploy reads the templates the release
  // recorded for this environment, checked against their digests.
  let pinnedFiles: import("../../components/release-promote").PinnedTemplate[] = [];
  // #4542: read before the pin too, since a capability names the files of a step that names them indirectly (a terraform root).
  const registry = await fanOutRegistry(project.projectPath, project.config);
  if (under) {
    const { pinReleaseTemplates } = await import("../../components/release-promote");
    const { readReleaseTemplate } = await import("../../lifecycle/release-store");
    const pinned = await pinReleaseTemplates(prepared, under.release, under.target, (digest, encoding) => readReleaseTemplate(digest, undefined, encoding), {
      registry,
      memberDir: project.projectPath,
    });
    if ("errors" in pinned) {
      for (const message of pinned.errors) console.error(formatError({ message }));
      console.error(formatError({ message: `nothing was deployed` }));
      return 1;
    }
    prepared.splice(0, prepared.length, ...pinned.components);
    pinnedFiles = pinned.files;
    for (const item of plan.items) {
      const named = item.source.releaseDigest;
      if (named !== undefined && named !== under.release.releaseDigest) {
        console.error(formatWarning({ message: `${item.component}: the ${plan.from} deploy being promoted came from release ${named}, not ${under.release.releaseDigest}` }));
      }
    }
    // #4045: the artifact deployed against the artifacts the release built.
    const { releaseArtifactMismatches } = await import("../../components/release-promote");
    const { readBuildManifest } = await import("../../lifecycle/build-ledger-store");
    const mismatches = await releaseArtifactMismatches(
      under.release,
      plan.items.map((i) => ({ component: i.component, source: i.source })),
      (digest) => readBuildManifest(digest).catch(() => null),
    );
    for (const message of mismatches) console.error(formatWarning({ message }));
  }

  // The composition deployed is this checkout's. Say so when it is not the
  // commit the artifact was built from.
  const head = await getHeadCommit().catch(() => undefined);
  for (const item of plan.items) {
    if (head && head !== item.source.gitSha) {
      console.error(formatWarning({
        message: `${item.component}: the artifact was built from ${item.source.gitSha.slice(0, 12)}, ` +
          `but its deploy steps come from this checkout at ${head.slice(0, 12)}`,
      }));
    }
  }

  const releaseJson: { release?: { releaseDigest: string; label: string | null; templates: unknown[] } } = under
    ? { release: { releaseDigest: under.release.releaseDigest, label: under.label, templates: under.target.templates } }
    : {};
  if (args.dryRun) {
    if (args.json) console.log(JSON.stringify({ ...planJson(plan, removed), ...releaseJson, ...skippedJson }, null, 2));
    else {
      renderPlan(verb, plan, removed);
      skippedLines();
      if (under) console.error(`  under release ${under.label ?? under.release.releaseDigest}: ${under.target.templates.length} template(s) from its "${plan.to}" target`);
    }
    return 0;
  }
  if (!args.json) {
    renderPlan(verb, plan, removed);
    skippedLines();
  }
  // #4045: the pinned templates are written for this run and removed after it.
  const { writePinnedTemplates, removePinnedTemplates } = await import("../../components/release-promote");
  const tidy = () => {
    if (pinnedFiles.length > 0) removePinnedTemplates(project.projectPath, pinnedFiles);
  };
  if (pinnedFiles.length > 0) writePinnedTemplates(project.projectPath, pinnedFiles);

  const seededOutputs: Record<string, Record<string, unknown>> = {};
  for (const file of args.seedOutputs ?? []) {
    try {
      Object.assign(seededOutputs, JSON.parse(readFileSync(resolve(file), "utf8")));
    } catch (err) {
      console.error(formatError({ message: `--seed-outputs: could not read "${file}": ${err instanceof Error ? err.message : String(err)}` }));
      tidy();
      return 1;
    }
  }

  // #4516: the reads a capability finds in its steps' files (a template's
  // Fn::ImportValue) order the promote as `deriveFanOut` orders a fan-out, so
  // an importer deploys after the exporter it reads. Read once the release's
  // templates are written, so they are the files read; a read of a component
  // this promote does not deploy is left out.
  prepared.splice(0, prepared.length, ...(await withDeclaredReads(prepared, registry, project.projectPath, { env: plan.to })));
  const port = gitGateLedgerPort();
  // #4045: under a release, every gate binds the release's change set for this environment.
  let releaseGate: ReleaseGateBinding | undefined;
  let changeSetJson: { changeSet: string; empty: boolean } | undefined;
  let bound: BoundReleaseGate | undefined;
  // #4168 step 4: a promote that stopped at a round's or a wave's gate left a resume record.
  const rounds = await import("../../components/promote-rounds");
  const resumePath = resolve(project.projectPath, args.resume ?? join(".chant", "promote", `${plan.to}.resume.json`));
  let resume: import("../../components/promote-rounds").PromoteResume | undefined;
  if (under && existsSync(resumePath)) {
    try {
      const record = JSON.parse(readFileSync(resumePath, "utf8")) as import("../../components/promote-rounds").PromoteResume;
      if (record.schema === rounds.PROMOTE_RESUME_SCHEMA && record.env === plan.to && record.releaseDigest === under.release.releaseDigest) resume = record;
      else if (args.resume) console.error(formatWarning({ message: `--resume ${args.resume} is for another release or environment; planning from the start` }));
    } catch (err) {
      console.error(formatWarning({ message: `could not read the resume record ${resumePath}: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }
  // ws-107 (#4465): under a release, the components a capability takes as one
  // plan and apply as one group; under --wave-gate none forms (ruling 1).
  // A resume groups again what is left of each group.
  let grouped: import("../../components/fan-out").FanOutPlan | undefined;
  const groupRuns: import("../../components/capability").GroupRun[] = [];
  if (under) {
    const groups = await import("../../components/groups");
    const whole = await groups.formRunGroups({
      components: prepared,
      plan: groups.componentSetFanOut(prepared),
      registry,
      env: plan.to,
      ...(args.waveGate !== undefined ? { waveGate: true } : {}),
    });
    if (resume && whole.groups?.length) {
      const { remainingFanOut } = await import("../../components/fan-out");
      grouped = await groups.regroupRemaining({
        components: prepared,
        plan: remainingFanOut(whole, prepared, { completed: resume.completed }),
        registry,
        env: plan.to,
        groups: whole.groups,
        ...(whole.fallbacks ? { fallbacks: whole.fallbacks } : {}),
      });
    } else {
      grouped = whole;
    }
  }
  let pullRequests: Array<import("../../lifecycle/merge-record").MergeRecord> = [];
  if (under) {
    try {
      const result = await bindReleaseGate({
        plan,
        prepared,
        under,
        registry,
        port,
        seededOutputs,
        actor: actor!,
        projectPath: project.projectPath,
        head,
        ...(resume && !args.planOnly ? { resume } : {}),
        ...(grouped ? { grouped } : {}),
        groupRuns,
        ...(args.planOnly ? { planOnly: true } : {}),
      });
      if (typeof result === "number") {
        tidy();
        return result;
      }
      if (result && args.planOnly) {
        bound = result;
      } else if (result) {
        bound = result;
        releaseGate = result.binding;
        changeSetJson = { changeSet: result.doc.digest, empty: result.empty };
        // #4168 decision 2: the pull requests' own approvals, shown beside the gate.
        const since = [...new Set((await readLedger(plan.to)).filter((r) => r.env === plan.to).map((r) => r.gitSha))];
        pullRequests = await pullRequestApprovals(under.release, since, project.projectPath);
        if (pullRequests.length > 0 && !args.json) {
          console.error(formatInfo(`pull requests this release carries into "${plan.to}" (shown, not counted by the release gate):`));
          for (const r of pullRequests) console.error(`  ${approvalLine(r)}`);
        }
      }
    } catch (err) {
      tidy();
      throw err;
    }
  }
  // #4037: --plan-only stops here, with the change set planned and stored, and nothing deployed.
  if (args.planOnly && under) {
    tidy();
    const { gateNamesOf, RELEASE_GATE_OP: op } = await import("../../components/release-gate");
    const planned = {
      env: plan.to,
      releaseDigest: under.release.releaseDigest,
      label: under.label,
      op,
      gates: bound ? gateNamesOf(prepared) : [],
      changeSet: bound?.doc.digest ?? null,
      empty: bound?.empty ?? null,
      components: plan.items.map((i) => i.component),
      ...skippedJson,
    };
    if (args.json) console.log(JSON.stringify(planned, null, 2));
    else if (!bound) console.error(formatInfo(`release ${under.label ?? under.release.releaseDigest} for "${plan.to}": no promoted composition declares a gate${skippedGates.length > 0 ? ` that applies in "${plan.to}"` : ""}, so there is no change set to approve; nothing was deployed`));
    else console.error(formatInfo(`release ${under.label ?? under.release.releaseDigest} for "${plan.to}": change set ${planned.changeSet}${planned.empty ? ", empty" : ""}, gates ${planned.gates.join(", ")}; nothing was deployed`));
    return 0;
  }
  if (args.waveGate && !bound) {
    console.error(formatError({ message: "--wave-gate needs a promote under --release whose compositions declare a gate", hint: PROMOTE_USAGE }));
    tidy();
    return 1;
  }
  // The run id the release records carry, chosen before the run so that
  // `--events-json` (#4041) names the run by it too.
  const { runId, runOrigin } = resolveRunId(args.runId);
  const events = await openCliRunEvents(args, {
    kind: "component",
    name: `${verb} ${plan.items.map((i) => i.component).join(",")} in ${plan.to}`,
    runId,
    cwd: project.projectPath,
  });
  // #4594: ci.lockGrain, and on the resource grain the row lease each step and group takes in the pull-request loop's rows file.
  const { applyLeaseOptions } = await import("../../components/apply-lease");
  const leasing = await applyLeaseOptions(process.cwd());
  let run: Awaited<ReturnType<typeof runPromotion>>;
  let staged: import("../../components/promote-rounds").PromoteRoundsResult | undefined;
  // #4168 step 4: a wave at a time when a dependent read an upstream's plan,
  // under --wave-gate, or on a resume; one run otherwise.
  const inPlan = new Set(plan.items.map((i) => i.component));
  const readsPlanned = bound?.plannedOutputs !== undefined && Object.keys(bound.plannedOutputs).some((d) => inPlan.has(d));
  const inRounds = bound !== undefined && (readsPlanned || args.waveGate !== undefined || resume !== undefined);
  try {
    if (inRounds && bound) {
      staged = await rounds.runPromotionInRounds({
        components: prepared,
        outputs: { ...seededOutputs, ...(resume?.outputs ?? {}) },
        binding: bound.binding,
        approved: bound.doc,
        reads: bound.reads,
        ...(resume ? { completed: resume.completed } : {}),
        ...(args.waveGate ? { waveGate: args.waveGate } : {}),
        replan: bound.replan,
        bind: bound.bind,
        ...(grouped?.groups?.length ? { grouped } : {}),
        run: (components, outputs, binding) =>
          runPromotion({
            plan: { ...plan, items: plan.items.filter((i) => components.some((c) => c.name === i.component)) },
            components,
            registry,
            componentOutputs: outputs,
            gates: port,
            releaseGate: binding,
            ...leasing,
            ...(grouped?.groups?.length ? { grouped, groupRuns } : {}),
            ...(args.progressJson ? { onProgress: ndjsonProgressSink() } : {}),
            ...(events ? { onRunEvent: events.emit } : {}),
          }),
      });
      run = staged.run;
    } else {
      run = await runPromotion({
        plan,
        components: prepared,
        registry,
        componentOutputs: seededOutputs,
        gates: port,
        ...(releaseGate ? { releaseGate } : {}),
        ...leasing,
        // #4465: with no release gate to bind, nothing planned the groups beforehand, so each plans in its wave.
        ...(grouped?.groups?.length ? { grouped, groupRuns, planGroupsAtWave: bound === undefined } : {}),
        ...(args.progressJson ? { onProgress: ndjsonProgressSink() } : {}),
        ...(events ? { onRunEvent: events.emit } : {}),
      });
    }
  } catch (err) {
    if (err instanceof PromoteStageRefused) {
      events?.settle("failed", err.message);
      return 1;
    }
    events?.settle("failed", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    tidy();
  }
  if (staged && bound) {
    for (const stage of staged.stages) {
      const label = stage.kind === "round" ? `round ${stage.number}` : `wave ${stage.number}`;
      console.error(formatInfo(`${label} (${stage.components.join(", ")}): planned again as ${stage.digest}, ${stage.status}`));
      for (const line of stage.notCovered) console.error(`  not covered by ${bound.doc.digest}: ${line}`);
      if (stage.message) console.error(formatError({ message: stage.message }));
    }
    if (run.status === "ok") {
      rmSync(resumePath, { force: true });
    } else if (staged.completed.length > 0) {
      const record: import("../../components/promote-rounds").PromoteResume = {
        schema: rounds.PROMOTE_RESUME_SCHEMA,
        env: plan.to,
        releaseDigest: under!.release.releaseDigest,
        approvedDigest: resume?.approvedDigest ?? bound.resumedFrom ?? bound.doc.digest,
        completed: staged.completed,
        outputs: staged.outputs,
        at: new Date().toISOString(),
      };
      mkdirSync(dirname(resumePath), { recursive: true });
      writeFileSync(resumePath, `${JSON.stringify(record, null, 2)}\n`);
      console.error(formatInfo(`resume record: ${resumePath}; the same promote carries on from here`));
    }
  }
  // #4465: the groups applied as one, and how each member ended, as pr-report says it.
  const { runGroupsReport, renderRunGroups } = await import("../../components/run-groups");
  const groupsReport = runGroupsReport({
    grouped,
    ...(bound?.groups ? { planned: bound.groups } : {}),
    ...(bound ? { doc: bound.doc } : {}),
    ...(run.groupOutcomes ? { outcomes: run.groupOutcomes } : {}),
  });
  if (!args.json) for (const line of renderRunGroups(groupsReport, `the same ${verb}`)) console.error(formatInfo(line));
  // The driver settles the stream; this only ends one it left open.
  events?.settle(run.status === "fail" ? "failed" : run.status);
  if (!args.json) renderDriverHuman(run);
  observe?.(run);

  // Record every component that deployed, whatever happened to the rest: a
  // component that reached the environment and is missing from its ledger
  // would be exactly the unrecorded deploy the ledger exists to rule out.
  const deployed = plan.items.filter((item) => run.results.some((r) => r.component === item.component && r.status === "ok"));
  const timestamp = new Date().toISOString();
  const recorded: ReleaseRecord[] = [];
  let recordError: string | undefined;
  // #4035: a run that applied partly, or failed, records what it did to each
  // component, so the environment reads as mixed until it is settled.
  const { deployOutcomeOf, appendDeployOutcome } = await import("../../lifecycle/deploy-outcome");
  const outcome = deployOutcomeOf({ verb, plan, run, releaseDigest: under?.release.releaseDigest ?? null, runId, timestamp, actor: actor! });
  if (deployed.length > 0 || outcome) {
    try {
      for (const item of deployed) {
        const result = run.results.find((r) => r.component === item.component);
        const approver = gateApprover(result);
        const admission = gateAdmission(result);
        const skipped = gatesSkipped(result);
        const input = record(item, plan.to, { runId, ...(runOrigin ? { runOrigin } : {}), actor: actor!, timestamp, ...(approver ? { approver } : {}), ...(admission ? { admission } : {}), ...(skipped ? { gatesSkipped: skipped } : {}) });
        const templates = templateDigests.get(item.component);
        const { record: written } = await appendReleaseRecord(under ? { ...input, ...(templates ? { digest: templates, digestKind: "templates" as const } : {}), releaseDigest: under.release.releaseDigest } : input);
        recorded.push(written);
      }
      if (outcome) await appendDeployOutcome(outcome);
      await pushLifecycle();
    } catch (err) {
      recordError = err instanceof Error ? err.message : String(err);
    }
  }

  if (args.json) {
    const withChangeSet = under && changeSetJson ? { release: { ...releaseJson.release!, ...changeSetJson } } : releaseJson;
    const stagedJson = staged ? { stages: staged.stages, ...(bound?.plannedOutputs ? { plannedOutputs: bound.plannedOutputs } : {}), ...(bound?.unknownInputs ? { unknownInputs: bound.unknownInputs } : {}) } : {};
    const prJson = pullRequests.length > 0 ? { pullRequests: pullRequests.map((r) => ({ commit: r.commit, source: r.source, plan: r.plan, digest: r.digest, approvedBy: r.approvedBy, ...(r.authorApproved ? { authorApproved: r.authorApproved } : {}) })) } : {};
    console.log(JSON.stringify({ ...planJson(plan, removed), ...withChangeSet, ...skippedJson, ...stagedJson, ...prJson, ...groupsReport, run, recorded, ...(outcome ? { outcome } : {}) }, null, 2));
  } else {
    for (const r of recorded) {
      console.error(formatSuccess(
        verb === "promote"
          ? `Promoted ${formatBold(r.component)} ${plan.from} -> ${plan.to}: ${r.digest}`
          : verb === "rollback"
            ? `Rolled back ${formatBold(r.component)} in ${plan.to} to ${r.digest}`
            : `Redeployed ${formatBold(r.component)} in ${plan.to} at ${r.digest}`,
      ));
    }
  }

  if (outcome && recordError === undefined) {
    const unsettled = outcome.components.filter((c) => c.outcome === "failed" || c.outcome === "gated");
    console.error(formatWarning({
      message: `"${plan.to}" now runs a mix: ${outcome.components.map((c) => `${c.component} ${c.outcome}`).join(", ")}. ` +
        `chant workspace status ${plan.to} --json lists what each component runs and the rollback line`,
    }));
    for (const c of unsettled) console.error(formatInfo(`settle ${c.component}: ${redeployLine(plan.to, c.component)}, or run the same ${verb} again`));
  }

  if (recordError !== undefined) {
    console.error(formatError({
      message: deployed.length > 0
        ? `deployed to "${plan.to}", but the release record was not written: ${recordError}`
        : `the outcome of the ${verb} in "${plan.to}" was not written: ${recordError}`,
      hint: `Pull the chant/lifecycle branch and check \`chant components status ${plan.to}\` before running this again.`,
    }));
    return 1;
  }

  if (run.status === "gated" && run.gate) {
    const pending = run.gate;
    console.error(formatWarning({ message: `component "${run.gatedComponent}" is gated on "${pending.gate}" — pending approval` }));
    // #2574: an approval stands, but for another environment, plan or none.
    const sealed = await gateIsSealed(pending.gate);
    if (run.gateMismatch) {
      console.error(formatWarning({ message: describeGateMismatch(pending.op, pending.gate, run.gateMismatch, sealed) }));
    }
    console.error(formatInfo(`approve : ${approveCommand(pending.op, pending.gate, pending.environment, pending.planDigest, sealed)}`));
    console.error(formatInfo(`then run the same ${verb} again`));
    writeGatedRunSummary({
      sealed,
      op: pending.op,
      gate: pending.gate,
      ...(pending.description ? { description: pending.description } : {}),
      expiresAt: pending.expiresAt,
      ...(pending.url ? { url: pending.url } : {}),
      ...(pending.planDigest ? { planDigest: pending.planDigest } : {}),
      ...(await summaryLedgerPrefix()),
      ...(pending.environment ? { environment: pending.environment } : {}),
    });
    return GATED_EXIT_CODE;
  }

  if (run.status !== "ok") {
    // #5339: a failed verify step is a fact for the verify-failed agent, with CHANT_AGENT_FACTS=verify-failed; the exit stands either way.
    if (verb !== "rollback" && !ctx.args.dryRun) {
      const { recordVerifyFailed, verifyFailedRecords } = await import("../../ci-agent-verify-failed");
      const records = verifyFailedRecords({ stage: plan.to, verb, ...(under ? { releaseDigest: under.release.releaseDigest } : {}), steps: run.results.flatMap((r) => r.records) });
      const line = await recordVerifyFailed(records, {});
      if (line) console.error(formatInfo(line));
    }
    console.error(formatError({ message: `${verb} failed at "${run.failedComponent ?? "unknown"}"` }));
    // A step that refused a plan that moved since it was approved exits 3 (#3997).
    return failedRunExitCode(run.results);
  }
  return 0;
}

/** Refuse before anything deploys when nobody can be named on the record. */
function actorOrRefuse(ctx: CommandContext): { actor: string | undefined } | number {
  const actor = resolveActor(ctx);
  if (!actor && !ctx.args.dryRun) {
    console.error(formatError({
      message: "Could not resolve --actor from the environment",
      hint: "Pass --actor explicitly, or set GITHUB_ACTOR / GITLAB_USER_LOGIN / USER.",
    }));
    return 1;
  }
  return { actor };
}

/** The revoked commits, or the exit code of a refusal already printed when the ci tags can't be judged (#4033). */
async function revokedOrRefuse(what: string): Promise<Map<string, import("../../lifecycle/release-revocation").ReleaseRevocation> | number> {
  const { readRevokedCommits } = await import("../../lifecycle/release-revocation");
  try {
    return await readRevokedCommits(process.cwd());
  } catch (err) {
    console.error(formatError({
      message: `the ci tags can't be judged, so whether ${what} is revoked is unknown: ${err instanceof Error ? err.message : String(err)} [declaration-invalid]`,
      hint: "Fix ci.green in chant.workspace.json at base; chant workspace check names the problem.",
    }));
    return 1;
  }
}

/**
 * Resolve `--release` for a promote or a rollback to `env` (#4026, #4035):
 * the release, its label and its target for `env`. Refused, with the exit
 * code returned, when the release can't be found, has no target for `env`,
 * is of a project with no components (#4046), or was cut from a revoked
 * commit (#4033), so a gate pending for it can't pass.
 *
 * With `waves` (#5427), the release is promoted by a stage's op waves, which
 * apply from the checkout and read no template the release recorded: a
 * release with no target for `env`, or of a project with no components, is
 * taken, with an empty target.
 */
async function resolveUnderRelease(ref: string, env: string, verb: "promote" | "rollback", fix: (release: { releaseDigest: string }) => Promise<string> | string, opts: { waves?: boolean } = {}): Promise<UnderRelease | number> {
  const { resolveRelease } = await import("../../lifecycle/release-store");
  const { targetFor, isImplicitRelease } = await import("../../components/release-promote");
  const found = await resolveRelease(ref);
  if (!found) {
    console.error(formatError({ message: `no release is labelled or digested "${ref}" in this member`, hint: "List them with: chant release list" }));
    return 1;
  }
  const targetOf = targetFor(found.release, env);
  const target = "error" in targetOf && opts.waves ? { target: { env, templates: [], params: [] } } : targetOf;
  if ("error" in target) {
    console.error(formatError({ message: target.error }));
    return 1;
  }
  // #4046: a release of a project with no components records build output
  // and no component, so there is no deploy step here to point at it.
  if (isImplicitRelease(found.release) && !opts.waves) {
    const name = found.label ?? found.release.releaseDigest;
    console.error(formatError({
      message: `release ${name} is of a project with no components, so ${verb} has no component to deploy`,
      hint: `Write its "${env}" build output with \`chant release export ${name} --env ${env}\`, then run the project's own deploy against those files.`,
    }));
    return 1;
  }
  // #4033 (ws-105): a release cut from a revoked commit is never deployed,
  // so a gate pending for it can't pass. Read from local tags, as the cut reads them.
  const revoked = await revokedOrRefuse(`release ${found.label ?? found.release.releaseDigest}`);
  if (typeof revoked === "number") return revoked;
  const { revocationOf, revokedRefusal } = await import("../../lifecycle/release-revocation");
  const revocation = revocationOf(found.release, revoked);
  if (revocation) {
    console.error(formatError(revokedRefusal({ releaseDigest: found.release.releaseDigest, label: found.label }, revocation, await fix(found.release))));
    return 1;
  }
  // #4168: under verified-releases a release deploys only once `chant release verify` passes for it.
  const { securityGroupsAt } = await import("../../workspace/security");
  if (securityGroupsAt(process.cwd()).has("verified-releases")) {
    const { verifyRelease, verificationCode } = await import("../../lifecycle/release-verify");
    const name = found.label ?? found.release.releaseDigest;
    const v = await verifyRelease({ cwd: process.cwd(), ref: found.release.releaseDigest });
    const code = "error" in v ? v.error.code : verificationCode(v);
    if (code) {
      console.error(formatError({
        message: `${code}: release ${name} does not verify (${"error" in v ? v.error.message : v.reason}), and the workspace opts into verified-releases, so ${verb} deploys only a verified release`,
        hint: `Check it with: chant release verify ${name}`,
      }));
      return 1;
    }
  }
  return { release: found.release, label: found.label, target: target.target };
}

/**
 * The line that rolls `env` back past `exclude` (#4035): to the newest
 * release in its ledger that is still kept and not revoked, by label, or
 * null when there is none.
 */
async function rollbackLineFor(env: string, records: readonly ReleaseRecord[], exclude: ReadonlySet<string>, revoked: ReadonlyMap<string, import("../../lifecycle/release-revocation").ReleaseRevocation>): Promise<string | null> {
  const { readRelease, readCuts, labelsByDigest } = await import("../../lifecycle/release-store");
  const { revocationOf } = await import("../../lifecycle/release-revocation");
  const target = await rollbackTarget({
    records,
    exclude,
    check: async (digest) => {
      const release = await readRelease(digest).catch(() => null);
      return { kept: release !== null, revoked: release !== null && revocationOf(release, revoked) !== null };
    },
  });
  if (!target) return null;
  const labels = await readCuts().then((c) => labelsByDigest(c.cuts), () => new Map<string, string>());
  return releaseRollbackLine(env, target, labels.get(target));
}

/**
 * Refuse a rollback or a redeploy that would put back a release cut from a
 * revoked commit (#4033, #4035), naming the release to go back to instead.
 * Returns the exit code of the refusal, or undefined when nothing restored
 * names a revoked release.
 */
async function refuseRevokedRestore(verb: "rollback" | "redeploy", plan: PromotionPlan, records: readonly ReleaseRecord[]): Promise<number | undefined> {
  const named = [...new Set(plan.items.map((i) => i.source.releaseDigest).filter((d): d is string => d !== undefined))];
  if (named.length === 0) return undefined;
  const revoked = await revokedOrRefuse(`the release this ${verb} restores`);
  if (typeof revoked === "number") return revoked;
  if (revoked.size === 0) return undefined;
  const { readRelease, readCuts, labelsByDigest } = await import("../../lifecycle/release-store");
  const { revocationOf, revokedRefusal } = await import("../../lifecycle/release-revocation");
  for (const digest of named) {
    const release = await readRelease(digest).catch(() => null);
    const revocation = release ? revocationOf(release, revoked) : null;
    if (!revocation) continue;
    const labels = await readCuts().then((c) => labelsByDigest(c.cuts), () => new Map<string, string>());
    const back = await rollbackLineFor(plan.to, records, new Set([digest]), revoked);
    console.error(formatError(revokedRefusal(
      { releaseDigest: digest, label: labels.get(digest) ?? null },
      revocation,
      back ? `Restore a release cut from a green commit instead: ${back}` : `No other release "${plan.to}" ran is kept and green; promote a release cut from a green commit (\`chant ci last-green\` names the newest).`,
    )));
    console.error(formatError({ message: "nothing was deployed" }));
    return 1;
  }
  return undefined;
}

export async function runComponentsPromote(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const to = args.migrateTo;
  if (!to) {
    console.error(formatError({ message: "--to <env> is required", hint: PROMOTE_USAGE }));
    return 1;
  }
  // #4298: a pull request's environment is neither a release's target nor its source.
  for (const env of [to, args.migrateFrom]) {
    const refusal = env ? releaseTargetRefusal(env) : undefined;
    if (refusal) {
      console.error(formatError({ message: refusal }));
      return 1;
    }
  }
  if (args.planOnly && !args.release) {
    console.error(formatError({ message: "--plan-only plans a release's change set: it needs --release <label|digest>", hint: PROMOTE_USAGE }));
    return 1;
  }
  if (args.pendingPromotion) return runPendingPromotion(ctx, to);
  const who = actorOrRefuse(ctx);
  if (typeof who === "number") return who;

  const project = await loadProject(ctx, args.component ?? "all", to);
  if (typeof project === "number") return project;

  // #5324: a member's pipeline, read at the default branch's tip, orders the
  // stages, holds and freezes them, and gates each promotion and each skip.
  const pipeline = readPromotePipeline(project.projectPath, to);
  if (typeof pipeline === "number") return pipeline;
  // #5355: the urgent path is a pipeline stage's rule, for one release, with a reason on the record.
  if (args.urgent) {
    const missing = !pipeline ? "--urgent passes a pipeline stage's urgent rule, and this member's pipeline has no stage " + JSON.stringify(to) : !args.release ? "--urgent promotes one release: it needs --release <label|digest>" : !args.reason ? "--urgent needs --reason <text>, which the stage's ledger records" : undefined;
    if (missing) {
      console.error(formatError({ message: missing, hint: PROMOTE_USAGE }));
      return 1;
    }
  }
  let skipped: import("../../pipeline/spec").PipelineStage[] = [];
  let upstreams: string[] | undefined;
  let from: string | undefined;
  if (pipeline) {
    const source = pipelinePromoteSource({ spec: pipeline, to, ...(args.migrateFrom ? { from: args.migrateFrom } : {}), ...(args.allowSkip ? { allowSkip: true } : {}), ...(args.urgent ? { urgent: true } : {}), now: new Date() });
    if (source && "exitCode" in source) {
      console.error(formatError({ message: `${source.message}${source.code ? ` [${source.code}]` : ""}`, ...(source.hint ? { hint: source.hint } : {}) }));
      return source.exitCode;
    }
    from = source!.from;
    skipped = source!.skipped;
    upstreams = source!.upstreams;
  } else {
    // The member's `environments` array is its promotion order (#4030). It
    // defaults --from and refuses a skipped step; a member that declares none
    // has no order, so --from is required and nothing is refused.
    const resolved = resolvePromotionSource({
      order: promotionOrder(project.config.environments),
      to,
      ...(args.migrateFrom ? { from: args.migrateFrom } : {}),
      ...(args.allowSkip ? { allowSkip: true } : {}),
    });
    if ("error" in resolved) {
      console.error(formatError({ message: `${resolved.error.message} [${resolved.error.code}]`, hint: resolved.error.fix }));
      return 1;
    }
    from = resolved.from;
  }
  if (!from) {
    console.error(formatError({ message: "--from <env> is required: this member declares no environments, so there is no promotion order to default it from", hint: PROMOTE_USAGE }));
    return 1;
  }
  // #5427: a member with no components promotes into a stage that applies through a step by running the stage's op waves.
  const waves = pipeline !== undefined && project.targets.length === 0 && !args.component && stageRunsWaves(pipeline, to);
  if (waves) {
    const refusal = !args.release
      ? "needs --release <label|digest>: the stage's op waves apply one release, and the stage's gate binds that release"
      : args.digest || args.digests?.length
        ? "takes no --digest: the stage's op waves plan what the release applies, and their gates bind those plans"
        : args.planOnly || args.waveGate !== undefined || args.resume !== undefined
          ? `takes no ${args.planOnly ? "--plan-only" : args.waveGate !== undefined ? "--wave-gate" : "--resume"}: each of the stage's op waves plans and decides its own gate, and the same promote carries on from the wave that waits`
          : undefined;
    if (refusal) {
      console.error(formatError({ message: `stage "${to}" applies through its op waves and this member declares no components, so the promote ${refusal}`, hint: PROMOTE_USAGE }));
      return 1;
    }
  }

  // Without --component, each --digest is <component>=<digest> (#2602): a
  // generated promote job pins every component to the release its own
  // pipeline run recorded, rather than whatever is latest in --from.
  const digests = args.digests ?? (args.digest ? [args.digest] : []);
  let pins: Record<string, string> | undefined;
  if (!args.component && digests.length > 0) {
    const parsed = parseDigestPins(digests);
    if ("error" in parsed) {
      console.error(formatError({ message: parsed.error, hint: PROMOTE_USAGE }));
      return 1;
    }
    pins = parsed.pins;
  } else if (args.component && digests.length > 1) {
    console.error(formatError({ message: "--component takes one --digest", hint: PROMOTE_USAGE }));
    return 1;
  }

  await fetchLifecycle().catch(() => false);

  // #4026: --release names the release this promote deploys, by label or digest.
  let under: UnderRelease | undefined;
  if (args.release) {
    const found = await resolveUnderRelease(
      args.release,
      to,
      "promote",
      () => "Promote a release cut from a green commit: `chant ci last-green` names the newest, and `chant release list` marks the revoked releases. Fetch the tags first: git fetch origin --tags",
      waves ? { waves } : {},
    );
    if (typeof found === "number") return found;
    under = found;
  }

  // #5356: the artifacts of earlier stages the stage reads, of this same
  // release, refused before any gate or deploy when one was not published.
  let readVariables: Record<string, string> = {};
  if (pipeline) {
    const { gitStageArtifactPort, resolveStageReads } = await import("../../pipeline/artifacts");
    const reads = await resolveStageReads(pipeline, to, under?.release.releaseDigest, gitStageArtifactPort());
    if (reads.status === "refused") {
      console.error(formatError({ message: `nothing was promoted into "${to}": ${reads.problems.join("; ")}` }));
      return 1;
    }
    readVariables = reads.variables;
    for (const r of reads.reads) console.error(formatInfo(`${r.variable}: artifact "${r.artifact}" of stage "${r.stage}"${r.kind === "secret" ? ", a secret's reference" : ""}`));
  }

  // #5427: under op waves, what the stage promoted from applied of the release, which its soak's clock reads.
  const wavesRelease = waves && under ? { releaseDigest: under.release.releaseDigest, commit: under.release.commit } : undefined;
  const plan: PromotionPlan | { error: string } = wavesRelease
    ? stageWavesPlan(from, to, under!, stageReleaseItems(await readLedger(from), from, wavesRelease))
    : planPromotion({
        from,
        to,
        sourceRecords: await readLedger(from),
        declared: project.targets.map((c) => c.name),
        ...(args.component ? { component: args.component } : {}),
        ...(args.component && args.digest ? { digest: args.digest } : {}),
        ...(pins ? { pins } : {}),
      });
  if ("error" in plan) {
    console.error(formatError({ message: plan.error, hint: PROMOTE_USAGE }));
    return 1;
  }
  // #5355: a paused stage refuses with exit 3 and records the release that waited; a release a resume superseded is refused.
  const stageDigest = under?.release.releaseDigest ?? promotedDigest(plan.items);
  const stagePort = gitStageLedgerPort();
  if (pipeline) {
    const stopped = await pausedOrSuperseded({ spec: pipeline, to, port: stagePort, digest: stageDigest, label: under?.label ?? null, by: who.actor ?? "unknown", record: !args.dryRun });
    if (stopped) {
      console.error(formatError({ message: `${stopped.message}${stopped.code ? ` [${stopped.code}]` : ""}`, ...(stopped.hint ? { hint: stopped.hint } : {}) }));
      return stopped.exitCode;
    }
  }
  // #5355: the urgent path takes only a release that succeeded in every stage upstream of the target.
  if (pipeline && args.urgent && under) {
    const { readDeployOutcomes } = await import("../../lifecycle/deploy-outcome");
    const components = plan.items.map((i) => i.component);
    const missing = await pipelineUrgentUpstream({
      spec: pipeline,
      to,
      missingIn: async (stage) =>
        releaseMissingIn({ records: (await readLedger(stage)).filter((r) => r.env === stage), outcomes: await readDeployOutcomes(stage).catch(() => []), releaseDigest: under!.release.releaseDigest, commit: under!.release.commit, components }),
    });
    if (missing.length > 0) {
      const stop = urgentUpstreamStop(under.label ?? under.release.releaseDigest, missing);
      console.error(formatError({ message: `${stop.message} [${stop.code}]`, ...(stop.hint ? { hint: stop.hint } : {}) }));
      return stop.exitCode;
    }
  }
  // #5324: the skipped stages' gates, then the stage's own, bound to the release (or the digests promoted).
  // #5353: a stage that follows several opens once the release applied in each, and a queued stage takes one release at a time.
  let entered: import("../../lifecycle/stage-log").StageLine | undefined;
  const { gitStageLogPort } = await import("../../lifecycle/stage-log");
  const log = gitStageLogPort();
  if (pipeline && !args.dryRun) {
    const digest = under?.release.releaseDigest ?? promotedDigest(plan.items);
    const port = gitGateLedgerPort();
    const head = await getHeadCommit().then((sha) => (sha ? { gitSha: sha } : {}), () => ({}));
    const proof = await promoteProof(project.projectPath);
    // The order at promote: a pause (above), then a rejection, then the soak of each stage promoted from and of each canary upstream, then the gates and risk.
    // #5354: a rejected release stops here, before a soak records anything for it.
    const rejection = await pipelinePromoteRejected({ spec: pipeline, to, skipped, digest, ...(under ? { releaseDigest: under.release.releaseDigest } : {}), port, ...(proof ? { proof } : {}), ...(args.urgent ? { urgent: true } : {}) });
    if (rejection) {
      for (const line of rejection.lines ?? []) console.error(formatInfo(line));
      console.error(formatError({ message: `${rejection.message} [${rejection.code}]`, ...(rejection.hint ? { hint: rejection.hint } : {}) }));
      return rejection.exitCode;
    }
    // #5326: the soak of each stage promoted from holds the promotion next; it adds a wait and never stands in for a gate.
    // An urgent promote waits on it too, unless a person ends the soak through its gate.
    // #5327: then the soak of each canary stage upstream, through its own gate, so a later stage or a skip waits for the canary.
    const soak = await pipelinePromoteSoaks({
      spec: pipeline,
      from,
      to,
      ...(upstreams ? { upstreams } : {}),
      items: async (source) =>
        source === from ? plan.items : wavesRelease ? stageReleaseItems(await readLedger(source), source, wavesRelease) : soakItemsOf(await readLedger(source), plan.items, under?.release.releaseDigest),
      digest,
      ...(under ? { releaseDigest: under.release.releaseDigest } : {}),
      port,
      read: (source) => soakCheckReader(jobSoakSources({ op: stageWavesName(pipeline, source), cwd: project.projectPath })),
      now: new Date(),
      ...head,
      ...(pipeline.defaults?.notify ? { notify: { config: pipeline.defaults.notify, source: activeProductWords().notify.source, project: pipeline.name } } : {}),
    });
    for (const line of soak.notes) console.error(formatInfo(line));
    if (!soak.passed) {
      console.error(formatError({ message: `${soak.message} [${soak.code}]`, hint: soak.hint }));
      // #5328: a failed check of a soak requests the rollback of the stage whose soak it is (a canary upstream, or the stage promoted from),
      // when that stage's onVerifyFail is rollback. A check that could not be read holds the soak, and is no failure to roll back for.
      const failedSoak = soakFailureOf(soak);
      if (failedSoak) {
        const current = latestPerComponent((await readLedger(failedSoak.stage)).filter((r) => r.env === failedSoak.stage && failedSoak.members.includes(r.component)));
        await requestRollbackAfterFailure({
          pipeline,
          stage: failedSoak.stage,
          failure: "soak",
          failed: { digest, label: under?.label ?? null },
          members: failedSoak.members.map((member) => ({ member, state: "applied" as const })),
          detail: soak.lines,
          exclude: new Set([...(under ? [under.release.releaseDigest] : []), ...[...current.values()].map((r) => r.releaseDigest).filter((d): d is string => d !== undefined)]),
          actor: who.actor ?? "unknown",
        });
      }
      return soak.exitCode;
    }
    for (const line of soak.lines) console.error(formatInfo(line));
    // #5358: each agent step's answer for the release, and the gate's policy over them, before the gate.
    const { pipelinePromoteAgentSteps } = await import("../../pipeline/promote");
    const { gitStageAgentAnswerPort } = await import("../../pipeline/agent-steps");
    const { stageAgentPolicy } = await import("./pipeline-agent");
    const agent = await pipelinePromoteAgentSteps({
      spec: pipeline,
      to,
      ...(under ? { release: { digest: under.release.releaseDigest, label: under.label } } : {}),
      port: gitStageAgentAnswerPort(),
      policy: (answers) => stageAgentPolicy(project.projectPath, pipeline, to, answers),
    });
    if (!agent.passed) {
      console.error(formatError({ message: `${agent.message}${agent.code ? ` [${agent.code}]` : ""}`, ...(agent.hint ? { hint: agent.hint } : {}) }));
      return agent.exitCode;
    }
    for (const line of agent.lines) console.error(formatInfo(line));
    const release = under ? await entryRelease(under) : undefined;
    const first = pipeline.stages[0]!.name;
    const firstStageCommits = upstreams?.includes(first) ? new Set((await readLedger(first)).filter((r) => r.env === first).map((r) => r.gitSha)) : undefined;
    const gates = await pipelineStageEntry({
      spec: pipeline,
      to,
      skipped,
      ...(upstreams ? { upstreams } : {}),
      ...(args.allowSkip ? { allowSkip: true } : {}),
      digest,
      ...(release ? { release } : {}),
      ...(firstStageCommits ? { firstStageCommits } : {}),
      port,
      log,
      ...(args.urgent ? { urgent: true } : {}),
      ...(who.actor ? { actor: who.actor } : {}),
      ...head,
      now: new Date(),
      // #5354: the signers and roles at the commit the pipeline is read at prove who approved or rejected.
      ...(proof ? { proof } : {}),
      // #5358: the agent steps' levels are reasons of the risk the stage's gate reads.
      ...(agent.risk.length > 0 ? { agentRisk: agent.risk } : {}),
    });
    if (!gates.passed) {
      for (const line of gates.lines ?? []) console.error(formatInfo(line));
      const hint = gates.hint ? (gates.code === "pipeline-gate-waiting" ? `Approve it with: ${gates.hint}` : gates.hint) : undefined;
      console.error(formatError({ message: `${gates.message}${gates.code ? ` [${gates.code}]` : ""}`, ...(hint ? { hint } : {}) }));
      return gates.exitCode;
    }
    for (const line of gates.lines) console.error(formatInfo(line));
    entered = gates.entered;
    // #5355: an urgent entry is marked on the stage's ledger and told to the pipeline's notify.
    if (gates.urgent && under) await recordUrgent({ spec: pipeline, to, port: stagePort, by: who.actor ?? "unknown", reason: args.reason!, release: { digest: under.release.releaseDigest, label: under.label }, approval: gates.urgent.approval, role: gates.urgent.role });
  }
  const { withStageReadVariables } = await import("../../pipeline/artifacts");
  let ran: DriverRunResult | undefined;
  // #5427: after the stage's gate passed, its op waves run in place of the component driver.
  const code = await withStageReadVariables(readVariables, () =>
    waves && pipeline && under ? promoteByStageWaves(ctx, project.projectPath, pipeline, to, under) : deployPlan(ctx, "promote", plan, project, who.actor, promotionRecord, under, (run) => (ran = run)),
  );
  // #5353: a deploy still waiting at a component's gate stays in the stage; any other end is written.
  if (entered && code !== GATED_EXIT_CODE) {
    try {
      await pipelineStageFinished(log, entered, code === 0 ? "applied" : "failed", new Date());
    } catch (err) {
      console.error(formatError({ message: `the deploy ended, but the stage log was not written: ${err instanceof Error ? err.message : String(err)}`, hint: "Run the same promote again: the release in the stage carries on and the line is written then." }));
      return code === 0 ? 1 : code;
    }
  }
  // #5328: a failed verify step in a stage whose onVerifyFail is rollback requests the rollback to the stage's previous release, and exits 3.
  // A failed verify is what #5339's agent trigger counts (`failedVerify`); a failed apply holds as before.
  const failedRun = ran as DriverRunResult | undefined;
  if (pipeline && !args.dryRun && failedRun?.status === "fail" && failedVerify(failedRun.results.flatMap((r) => r.records))) {
    const requested = await requestRollbackAfterFailure({
      pipeline,
      stage: to,
      failure: "verify",
      failed: { digest: stageDigest, label: under?.label ?? null },
      members: memberStatesOf(plan.items.map((i) => i.component), failedRun.results),
      detail: failureDetail(failedRun.results),
      exclude: new Set(under ? [under.release.releaseDigest] : []),
      actor: who.actor ?? "unknown",
    });
    if (requested !== undefined) return requested;
  }
  // #5356: the stage publishes its artifacts once the deploy applied, after the stage log says so.
  if (code !== 0 || !pipeline || args.dryRun || args.planOnly) return code;
  return publishAfterPromote(project.projectPath, pipeline, to, under);
}

/**
 * What an upstream stage other than `--from` applied of the promoted
 * components (#5326), for its soak's clock: each component's newest record
 * there, of the release when one is promoted, else of the digest promoted
 * (#5327). A component with none is left out; with none at all the soak
 * cannot count its clock and holds.
 */
function soakItemsOf(records: ReleaseRecord[], items: readonly { component: string; digest: string }[], releaseDigest: string | undefined): { component: string; source: { timestamp: string } }[] {
  const out: { component: string; source: { timestamp: string } }[] = [];
  for (const { component, digest } of items) {
    const own = records.filter((r) => r.component === component && (releaseDigest === undefined ? r.digest === digest : r.releaseDigest === releaseDigest));
    const newest = own.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1);
    if (newest) out.push({ component, source: { timestamp: newest.timestamp } });
  }
  return out;
}

/** The release a promote deploys, as the stage log names it (#5353): its label, commit and when it was first cut, and the change risk its cut carries (#5387). */
async function entryRelease(under: UnderRelease): Promise<import("../../pipeline/promote").PipelineEntryRelease> {
  const { readCuts } = await import("../../lifecycle/release-store");
  const cuts = await readCuts().then((r) => r.cuts, () => []);
  const cut = cuts.find((c) => c.releaseDigest === under.release.releaseDigest);
  // #5387: the change risk a cut of the release bound, which each stage gate with holds.risk reads.
  const risk = cuts.find((c) => c.releaseDigest === under.release.releaseDigest && c.risk)?.risk;
  return {
    releaseDigest: under.release.releaseDigest,
    commit: under.release.commit,
    ...(under.label ? { label: under.label } : {}),
    ...(cut ? { cutAt: cut.timestamp } : {}),
    ...(risk ? { risk } : {}),
  };
}

/**
 * The plan of a promote by a stage's op waves (#5427): what `from` applied
 * of the release, each component's newest record, which the soak of `from`
 * reads. Refused when `from` applied none of it.
 */
function stageWavesPlan(from: string, to: string, under: UnderRelease, items: PromotionItem[]): PromotionPlan | { error: string } {
  if (items.length > 0) return { from, to, items, notPromoted: [] };
  const name = under.label ?? under.release.releaseDigest;
  return { error: `release ${name} has not applied in "${from}": its ledger has no record of the release or of the commit it was cut from (${under.release.commit.slice(0, 12)}), so nothing of it is promoted into "${to}". Promote it into ${from} first` };
}

/**
 * Run stage `to`'s op waves for release `under` (#5427), once the stage's
 * gate passed: `runStageWaves` with the product's in-process hooks and
 * capabilities, as `chant run wave` runs a wave job, the spec's notify told
 * after each wave. The waves plan and apply this checkout, which must hold
 * the commit the release was cut from. Returns the exit code of the first
 * wave that did not end with 0 (3 while one waits for an approval), else 0.
 * A dry run prints the waves and runs none.
 */
async function promoteByStageWaves(ctx: CommandContext, projectPath: string, pipeline: import("../../pipeline/spec").PipelineSpec, to: string, under: UnderRelease): Promise<number> {
  const { args } = ctx;
  const name = under.label ?? under.release.releaseDigest;
  const { runStageWaves, stageRunSpec } = await import("../../pipeline/stage-waves");
  const { pipelineStageSpecFile } = await import("../../pipeline/generate");
  const shape = stageRunSpec(pipeline, to);
  if (args.dryRun) {
    const out = { to, releaseDigest: under.release.releaseDigest, label: under.label, specFile: pipelineStageSpecFile(pipeline, to), waves: shape.waves.map((w, i) => ({ wave: i + 1, name: w.name, runs: (w.runs ?? []).map((r) => r.target), gate: w.gate ?? "always" })) };
    if (args.json) console.log(JSON.stringify(out, null, 2));
    else {
      console.error(formatBold(`promote release ${name} into ${to} through its op waves`));
      for (const w of out.waves) console.error(`  wave ${w.wave} (${w.name}): ${w.runs.join(", ") || "runs found at plan"}, gate ${w.gate}`);
    }
    return 0;
  }
  const base = promoteBase(projectPath);
  if (!base) {
    console.error(formatError({ message: `the default branch's commit cannot be read, so the gates of stage "${to}"'s waves cannot be read and nothing was applied` }));
    return 1;
  }
  // The waves plan and apply this checkout: it must hold the release's commit, and a later commit is said.
  const head = await getHeadCommit().catch(() => undefined);
  const { execFileSync } = await import("node:child_process");
  let holds = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", under.release.commit, "HEAD"], { cwd: projectPath, stdio: "ignore" });
    holds = true;
  } catch {
    holds = false;
  }
  if (!holds) {
    console.error(formatError({
      message: `release ${name} was cut from ${under.release.commit.slice(0, 12)}, which this checkout does not hold, so stage "${to}"'s waves would not apply it; nothing was applied`,
      hint: "Run the promote in a checkout of the default branch with its full history (fetch-depth: 0 on GitHub and Forgejo, GIT_DEPTH: \"0\" on GitLab).",
    }));
    return 1;
  }
  if (head && head !== under.release.commit) {
    console.error(formatWarning({ message: `release ${name} was cut from ${under.release.commit.slice(0, 12)}, and stage "${to}"'s waves plan this checkout at ${head.slice(0, 12)}; each wave's gate binds the plan made here` }));
  }
  const { activeProductWaveHook } = await import("../../op/op-waves-after-plan");
  const { notifyOpWave } = await import("../../op/op-waves-notify");
  const product = activeProductWaveHook();
  const ran = await runStageWaves({
    spec: pipeline,
    stage: to,
    base,
    cwd: projectPath,
    release: { releaseDigest: under.release.releaseDigest },
    options: {
      ...(product?.afterPlan ? { afterPlan: product.afterPlan } : {}),
      ...(product?.capabilities ? { capabilities: product.capabilities } : {}),
      ...(product?.hookExec ? { hookExec: product.hookExec } : {}),
      ...(product?.runHooks ? { runHooks: product.runHooks } : {}),
      ...(product?.hooks ? { inProcessHooks: product.hooks } : {}),
    },
    // Delivery never changes the exit code.
    afterWave: async (wave, spec) => {
      try {
        await notifyOpWave(spec, wave.wave, { result: wave.result });
      } catch (err) {
        console.error(formatWarning({ message: `wave ${wave.wave}'s notify was not sent: ${err instanceof Error ? err.message : String(err)}` }));
      }
    },
  });
  if (args.json) console.log(JSON.stringify({ to, releaseDigest: under.release.releaseDigest, label: under.label, specFile: ran.specFile, exitCode: ran.exitCode, waves: ran.waves.map((w) => ({ wave: w.wave, name: w.name, ...w.result })) }, null, 2));
  for (const w of ran.waves) {
    const r = w.result;
    console.error(formatInfo(`wave ${w.wave} (${w.name}) of ${ran.spec.name}: ${r.exitCode === 0 ? `applied ${r.applied.join(", ") || "nothing"}` : `exit ${r.exitCode}${r.failed.length > 0 ? `, failed ${r.failed.join(", ")}` : ""}`}`));
  }
  const last = ran.waves.at(-1)?.result;
  if (ran.exitCode === GATED_EXIT_CODE) {
    const approve = last?.decision?.approve;
    console.error(formatWarning({ message: `release ${name} entered stage "${to}", and wave ${ran.waves.at(-1)?.wave} of ${ran.spec.name} waits for an approval of its plan${last?.decision?.digest ? ` ${last.decision.digest}` : ""}` }));
    if (approve) console.error(formatInfo(`approve : ${approve}`));
    console.error(formatInfo("then run the same promote again"));
    return ran.exitCode;
  }
  if (ran.exitCode !== 0) {
    console.error(formatError({ message: `promote of release ${name} into "${to}" stopped at wave ${ran.waves.at(-1)?.wave} of ${ran.spec.name} (exit ${ran.exitCode})` }));
    return ran.exitCode;
  }
  console.error(formatSuccess(`Promoted release ${formatBold(name)} into ${to} through ${ran.waves.length} wave(s) of ${ran.spec.name}`));
  return 0;
}

/**
 * #5356: once a promote under a release deployed, the stage publishes the
 * artifacts it declares for that release. A promote of digests alone names
 * no release, so it publishes none and says so. A refused publish fails the
 * promote after the deploy (exit 1), naming the artifacts and never a value.
 */
async function publishAfterPromote(projectPath: string, pipeline: import("../../pipeline/spec").PipelineSpec, to: string, under: UnderRelease | undefined): Promise<number> {
  const declared = pipeline.stages.find((s) => s.name === to)?.publish;
  if (!declared || Object.keys(declared).length === 0) return 0;
  if (!under) {
    console.error(formatWarning({ message: `stage "${to}" publishes artifacts for the release it takes, and this promote named none, so none were published` }));
    return 0;
  }
  const { publishStageFrom, publishRefusedMessage } = await import("./pipeline-artifacts");
  const result = await publishStageFrom({ cwd: projectPath, spec: pipeline, stage: to, release: { digest: under.release.releaseDigest, label: under.label, gitSha: under.release.commit } });
  if (result.status === "refused") {
    console.error(formatError({ message: `${publishRefusedMessage(result)}; the release was deployed` }));
    return 1;
  }
  if (result.status === "published") console.error(formatInfo(`stage "${to}" published ${Object.keys(result.record.artifacts).sort().join(", ")} for release ${under.label ?? under.release.releaseDigest}`));
  return 0;
}

/**
 * #5328: after a failed verify or soak in `stage`, the rollback request its
 * `onVerifyFail: "rollback"` asks for (`../../pipeline/verify-rollback.ts`).
 * Returns 3 when a request was written or one stands already, and undefined
 * when the stage holds (its `onVerifyFail` is `hold`, or no rollback could
 * be requested, which it says), so the caller keeps its own exit code.
 */
async function requestRollbackAfterFailure(input: {
  pipeline: import("../../pipeline/spec").PipelineSpec;
  stage: string;
  failure: "verify" | "soak";
  failed: { digest: string; label: string | null };
  members: import("../../pipeline/stage-ledger").StageMemberState[];
  detail: string[];
  exclude: ReadonlySet<string>;
  actor: string;
}): Promise<number | undefined> {
  const { pipeline, stage } = input;
  if (stageOnVerifyFail(pipeline.stages.find((s) => s.name === stage)) !== "rollback") return undefined;
  const { readRelease, readCuts, labelsByDigest } = await import("../../lifecycle/release-store");
  const { readRevokedCommits, revocationOf, describeRevocation } = await import("../../lifecycle/release-revocation");
  const labels = await readCuts().then((c) => labelsByDigest(c.cuts), () => new Map<string, string>());
  let revoked: Map<string, import("../../lifecycle/release-revocation").ReleaseRevocation> | string;
  try {
    revoked = await readRevokedCommits(process.cwd());
  } catch (err) {
    revoked = `the ci tags can't be judged: ${err instanceof Error ? err.message : String(err)}`;
  }
  const head = await getHeadCommit().catch(() => undefined);
  const outcome = await requestStageRollback({
    spec: pipeline,
    stage,
    failure: input.failure,
    failed: input.failed,
    members: input.members,
    detail: input.detail,
    records: (await readLedger(stage)).filter((r) => r.env === stage),
    exclude: input.exclude,
    check: async (digest) => {
      const release = await readRelease(digest).catch(() => null);
      if (!release) return { kept: false, revoked: null };
      // A release whose revocation can't be read is not restored on trust.
      if (typeof revoked === "string") return { kept: true, revoked };
      const revocation = revocationOf(release, revoked);
      return { kept: true, revoked: revocation ? describeRevocation(revocation) : null };
    },
    label: (digest) => labels.get(digest) ?? null,
    stages: gitStageLedgerPort(),
    gates: gitGateLedgerPort(),
    by: input.actor,
    now: new Date(),
    ...(head ? { gitSha: head } : {}),
    ...(pipeline.defaults?.notify ? { notify: { config: pipeline.defaults.notify, source: activeProductWords().notify.source } } : {}),
  });
  if (outcome.status === "hold") return undefined;
  for (const line of outcome.lines) console.error(formatInfo(line));
  if (outcome.status === "held") {
    console.error(formatWarning({ message: `stage ${stage} holds: ${outcome.reason}` }));
    return undefined;
  }
  console.error(formatError({ message: `stage ${stage} requested its rollback, which waits for an approval [pipeline-rollback-requested]`, hint: outcome.hint }));
  return outcome.exitCode;
}

/**
 * The signers, passkeys and role grants at the commit a promote reads its
 * pipeline at (#5354), which prove who approved or rejected at a stage's
 * gate. A trust config that can't be read proves nobody.
 */
async function promoteProof(projectPath: string): Promise<import("../../pipeline/promote").PipelineGateProof | undefined> {
  try {
    const { scopeSource } = await import("../../workspace/write-scope");
    const { policy } = scopeSource(projectPath, promoteBase(projectPath));
    return { signers: policy, roles: policy.roles };
  } catch {
    return undefined;
  }
}

/**
 * The stop a stage's ledger puts on a promote (#5355): a pause, which exits 3
 * and records the release as waiting (unless `record` is false, as on a dry
 * run), or a resume that superseded this release. Undefined when it goes on.
 */
async function pausedOrSuperseded(input: { spec: import("../../pipeline/spec").PipelineSpec; to: string; port: StageLedgerPort; digest: string; label: string | null; by: string; record: boolean }): Promise<PipelinePromoteStop | undefined> {
  const lines = await input.port.read(input.spec.name, input.to);
  const pause = stagePaused(lines);
  if (pause) {
    if (input.record) await input.port.append(waitingLine({ pipeline: input.spec.name, stage: input.to, by: input.by, release: { digest: input.digest, label: input.label }, now: new Date() }));
    return {
      exitCode: 3,
      code: "pipeline-stage-paused",
      message: `${stagePausedLine(pause)}${input.record ? `; release ${input.label ?? input.digest} waits` : ""}`,
      hint: `chant stage resume ${input.to} lets the newest waiting release in.`,
    };
  }
  const resume = supersededBy(lines, input.digest);
  if (resume) {
    const admits = resume.admits ? resume.admits.label ?? resume.admits.digest : "a newer release";
    return {
      exitCode: 1,
      code: "pipeline-release-superseded",
      message: `release ${input.label ?? input.digest} waited while stage "${input.to}" was paused, and the resume at ${resume.timestamp} let ${admits} in instead`,
      hint: `Promote ${admits}: chant components promote --to ${input.to} --release ${admits}`,
    };
  }
  return undefined;
}

/** Mark an urgent promote on the stage's ledger and tell the pipeline's notify (#5355). */
async function recordUrgent(input: {
  spec: import("../../pipeline/spec").PipelineSpec;
  to: string;
  port: StageLedgerPort;
  by: string;
  reason: string;
  release: { digest: string; label: string | null };
  approval: import("../../lifecycle/gate-ledger").GateResolutionRecord;
  role: string;
}): Promise<void> {
  const now = new Date();
  const pushed = await input.port.append({
    version: 1,
    kind: "urgent",
    pipeline: input.spec.name,
    stage: input.to,
    by: input.by,
    reason: input.reason,
    timestamp: now.toISOString(),
    release: input.release,
    approval: { by: input.approval.resolvedBy, at: input.approval.timestamp, role: input.role, ...(input.approval.note ? { note: input.approval.note } : {}) },
  });
  if (!pushed.pushed) console.error(formatWarning({ message: `the urgent promote is recorded locally and did not reach the remote${pushed.pushWarning ? `: ${pushed.pushWarning}` : ""}` }));
  const { makeNotifyEvent, sendNotify } = await import("../../notify");
  const name = input.release.label ?? input.release.digest;
  await sendNotify(
    input.spec.defaults?.notify,
    makeNotifyEvent({
      source: "chant",
      event: "urgent",
      project: input.spec.name,
      environment: input.to,
      summary: `release ${name} promoted into ${input.to} on its urgent rule, approved by ${input.approval.resolvedBy} (${input.role}), promoted by ${input.by}: ${input.reason}`,
      digest: input.release.digest,
      reason: input.reason,
      detail: { urgent: true, stage: input.to, release: input.release, approvedBy: input.approval.resolvedBy, role: input.role, promotedBy: input.by },
    }, { now }),
  );
}

/**
 * `components promote --to <stage> --pending` (#5326): the promotion into
 * `stage` that a soak holds, run again. The stage before it in the pipeline
 * read at base, and each canary stage upstream of it (#5327), names a
 * soak's gate; the newest standing pending fact of those for `stage` names
 * the release. Nothing pending, or the stage already running
 * that release, exits 0 with a line; otherwise the promote runs as `--release
 * <digest>` would, soak and gates included.
 */
async function runPendingPromotion(ctx: CommandContext, to: string): Promise<number> {
  const { args } = ctx;
  if (args.release || args.component || args.digest || args.digests?.length || args.migrateFrom) {
    console.error(formatError({ message: "--pending reads the release from the soak's pending fact, so it takes only --to", hint: PROMOTE_USAGE }));
    return 1;
  }
  const projectPath = resolve(".");
  const pipeline = readPromotePipeline(projectPath, to);
  if (typeof pipeline === "number") return pipeline;
  const at = pipeline ? pipeline.stages.findIndex((s) => s.name === to) : -1;
  if (!pipeline || at <= 0) {
    console.error(formatInfo(`no promotion into ${to} is pending: ${pipeline ? `${to} is the pipeline's first stage` : "the member has no pipeline with that stage"}`));
    return 0;
  }
  const from = pipeline.stages[at - 1]!.name;
  // #5327: a canary stage upstream holds the promotion through its own soak gate too.
  const holders = [from, ...canaryStagesBefore(pipeline, to).map((s) => s.name).filter((n) => n !== from)];
  const gates = new Map(holders.map((n) => [stageSoakGate(n), n]));
  await fetchLifecycle().catch(() => false);
  const now = new Date().toISOString();
  const { pending } = await gitGateLedgerPort().read(pipeline.name);
  const standing = pending
    .filter((p) => gates.has(p.gate) && p.soak?.to === to && p.releaseDigest && !isPendingGateExpired(p, now))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .at(-1);
  if (!standing?.releaseDigest) {
    console.error(formatInfo(`no promotion into ${to} is pending`));
    return 0;
  }
  if ((await readLedger(to)).some((r) => r.releaseDigest === standing.releaseDigest)) {
    console.error(formatInfo(`${to} already runs the release ${standing.releaseDigest}, so nothing is pending`));
    return 0;
  }
  console.error(formatInfo(`promoting the release ${standing.releaseDigest} into ${to}, held since ${standing.timestamp} by the soak of ${gates.get(standing.gate) ?? from}`));
  return runComponentsPromote({ ...ctx, args: { ...args, pendingPromotion: false, release: standing.releaseDigest } });
}

/**
 * The member's folded pipeline as the default branch has it (#5324), when it
 * has a stage `to`; undefined otherwise, and the member's `environments`
 * order applies as before. A pipeline at base that does not fold refuses
 * the promote (exit 1): its gates cannot be read, and none is skipped.
 */
function readPromotePipeline(projectPath: string, to: string): import("../../pipeline/spec").PipelineSpec | number | undefined {
  const base = promoteBase(projectPath);
  if (!base) return undefined;
  const read = readPipelineAt(base, projectPath);
  if (read.status === "refused") {
    console.error(formatError({ message: `the pipeline at ${base.slice(0, 12)} does not fold, so its gates cannot be read and nothing is promoted: ${read.line}` }));
    return 1;
  }
  return read.status === "folded" && read.spec.stages.some((s) => s.name === to) ? read.spec : undefined;
}

export async function runComponentsRollback(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const env = args.extraPositional;
  if (env && args.rollbackRequested) {
    const who = actorOrRefuse(ctx);
    if (typeof who === "number") return who;
    return runRequestedRollback(ctx, env, who.actor);
  }
  if (!env || (!args.component && !args.release)) {
    console.error(formatError({ message: "an environment and --component <name>, --release <label|digest> or --requested are required", hint: ROLLBACK_USAGE }));
    return 1;
  }
  if (args.component && args.release) {
    console.error(formatError({ message: "--release rolls back every component of a release, so it does not take --component", hint: ROLLBACK_USAGE }));
    return 1;
  }
  if (args.release && args.digest) {
    console.error(formatError({ message: "--digest picks one release of one component, so it needs --component, not --release", hint: ROLLBACK_USAGE }));
    return 1;
  }
  const who = actorOrRefuse(ctx);
  if (typeof who === "number") return who;
  if (args.release) return runReleaseRollback(ctx, env, args.release, who.actor);

  const project = await loadProject(ctx, args.component!, env);
  if (typeof project === "number") return project;

  await fetchLifecycle().catch(() => false);
  const records = await readLedger(env);
  const plan = planRollback({
    env,
    records,
    declared: project.targets.map((c) => c.name),
    component: args.component!,
    ...(args.digest ? { digest: args.digest } : {}),
  });
  if ("error" in plan) {
    console.error(formatError({ message: plan.error, hint: ROLLBACK_USAGE }));
    return 1;
  }
  const refused = await refuseRevokedRestore("rollback", plan, records);
  if (refused !== undefined) return refused;
  // #4542: a component with no artifact (a terraform root) was recorded with
  // the templates digest of the release it deployed from, so it rolls back
  // under that release: its recorded files, planned and bound to the release gate.
  const item = plan.items[0];
  if (item?.source.digestKind === "templates" && item.source.releaseDigest !== undefined) {
    const under = await resolveUnderRelease(item.source.releaseDigest, env, "rollback", () =>
      "Roll back to a release cut from a green commit; `chant release list` marks the revoked releases.",
    );
    if (typeof under === "number") return under;
    return afterRollback(ctx, project.projectPath, env, who.actor, { digest: under.release.releaseDigest, label: under.label }, await deployPlan(ctx, "rollback", plan, project, who.actor, rollbackRecord, under));
  }
  const back = item?.source.releaseDigest;
  return afterRollback(ctx, project.projectPath, env, who.actor, back ? { digest: back, label: null } : undefined, await deployPlan(ctx, "rollback", plan, project, who.actor, rollbackRecord));
}

/**
 * A rollback that finished pauses its stage (#5355) when the member's
 * pipeline at base sets `pauseAfterRollback` on it, and says so, so the next
 * release waits for `chant stage resume`. A dry run, or a rollback that did
 * not finish, pauses nothing. Returns the rollback's exit code.
 */
async function afterRollback(ctx: CommandContext, projectPath: string, env: string, actor: string | undefined, release: { digest: string; label: string | null } | undefined, exitCode: number): Promise<number> {
  if (exitCode !== 0 || ctx.args.dryRun) return exitCode;
  const base = promoteBase(projectPath);
  const read = base ? readPipelineAt(base, projectPath) : undefined;
  if (read?.status !== "folded") return exitCode;
  const pipeline = read.spec;
  const stage = pipeline.stages.find((s) => s.name === env);
  if (!stage?.pauseAfterRollback) return exitCode;
  const port = gitStageLedgerPort();
  const line = pauseLine({ pipeline: pipeline.name, stage: env, by: actor ?? "unknown", lines: await port.read(pipeline.name, env), now: new Date(), cause: "rollback", ...(release ? { release } : {}) });
  if ("refused" in line) {
    console.error(formatInfo(`stage ${env} stays paused: ${line.refused}`));
    return exitCode;
  }
  const pushed = await port.append(line);
  console.error(formatInfo(`paused stage ${env} after the rollback: a promote into it exits 3 until chant stage resume ${env}`));
  if (!pushed.pushed) console.error(formatWarning({ message: `the pause is recorded locally and did not reach the remote${pushed.pushWarning ? `: ${pushed.pushWarning}` : ""}` }));
  return exitCode;
}

/**
 * `chant components rollback <stage> --requested` (#5328): carry out the
 * rollback a stage requested when its verify or soak failed. The newest
 * request on the stage's ledger names the release and the members; its gate
 * (`<stage>-rollback` under the pipeline's op) must pass first, on a
 * person's approval given since the request, whatever the stage's gate
 * policy. Then the members roll back as `--release` rolls them back, the
 * approval is spent, and a `rolled-back` line links the rollback to its
 * request and its failure. A dry run reads no gate and applies nothing.
 */
async function runRequestedRollback(ctx: CommandContext, env: string, actor: string | undefined): Promise<number> {
  const { args } = ctx;
  if (args.component || args.release || args.digest) {
    console.error(formatError({ message: "--requested reads the release and the members from the stage's request, so it takes only the stage", hint: ROLLBACK_USAGE }));
    return 1;
  }
  const projectPath = resolve(".");
  const pipeline = readPromotePipeline(projectPath, env);
  if (typeof pipeline === "number") return pipeline;
  if (!pipeline) {
    console.error(formatError({ message: `--requested carries out a rollback a pipeline stage requested, and this member's pipeline has no stage "${env}"`, hint: ROLLBACK_USAGE }));
    return 1;
  }
  await fetchLifecycle().catch(() => false);
  const stagePort = gitStageLedgerPort();
  const request = standingRollbackRequest(await stagePort.read(pipeline.name, env));
  if (!request?.release) {
    console.error(formatInfo(`no rollback of stage ${env} is requested`));
    return 0;
  }
  const to = request.release;
  const members = (request.members ?? []).filter((m) => m.rollback === "requested").map((m) => m.member);
  console.error(formatInfo(`stage ${env} requested its rollback to release ${to.label ?? to.digest} at ${request.timestamp}, for ${members.join(", ")}`));
  if (args.dryRun) return runReleaseRollback(ctx, env, to.digest, actor, new Set(members));
  const port = gitGateLedgerPort();
  const head = await getHeadCommit().catch(() => undefined);
  const proof = await promoteProof(projectPath);
  const gate = await requestedRollbackGate({ spec: pipeline, stage: env, request, port, ...(proof ? { proof } : {}), now: new Date(), ...(head ? { gitSha: head } : {}) });
  if (!gate.passed) {
    console.error(formatError({ message: `${gate.message} [${gate.code}]`, hint: gate.hint }));
    return gate.exitCode;
  }
  for (const line of gate.lines) console.error(formatInfo(line));
  const code = await runReleaseRollback(ctx, env, to.digest, actor, new Set(members));
  if (code !== 0) return code;
  const now = new Date();
  await port.appendApplied?.({ version: 1, kind: "applied", op: pipeline.name, gate: stageRollbackGate(env), planDigest: to.digest, approvedAt: gate.approval.timestamp, approvedBy: gate.approval.resolvedBy, timestamp: now.toISOString(), ...(head ? { commit: head } : {}) });
  const pushed = await stagePort.append(rolledBackLine({ request, by: actor ?? "unknown", approval: gate.approval, now }));
  console.error(formatSuccess(`stage ${env} rolled back to release ${to.label ?? to.digest}, as requested at ${request.timestamp} and approved by ${gate.approval.resolvedBy}`));
  if (!pushed.pushed) console.error(formatWarning({ message: `the rollback is recorded locally and did not reach the remote${pushed.pushWarning ? `: ${pushed.pushWarning}` : ""}` }));
  return 0;
}

/**
 * `chant components rollback <env> --release <label|digest>` (#4035): a
 * gated promote of an earlier release into `env`. Every component of the
 * release is restored at the digest `env` recorded running it from that
 * release, its deploy reads the templates the release recorded for `env`,
 * and its gates bind the release's change set planned against what `env`
 * runs now, as `promote --release` binds them (#4045).
 */
async function runReleaseRollback(ctx: CommandContext, env: string, ref: string, actor: string | undefined, only?: ReadonlySet<string>): Promise<number> {
  const project = await loadProject(ctx, "all", env);
  if (typeof project === "number") return project;
  await fetchLifecycle().catch(() => false);
  const records = await readLedger(env);
  const under = await resolveUnderRelease(ref, env, "rollback", async (release) => {
    const revoked = await revokedOrRefuse("the release before it").then((r) => (typeof r === "number" ? new Map() : r));
    const back = await rollbackLineFor(env, records, new Set([release.releaseDigest]), revoked);
    return back ? `Roll back to a release cut from a green commit: ${back}` : "Roll back to a release cut from a green commit; `chant release list` marks the revoked releases.";
  });
  if (typeof under === "number") return under;
  const { readDeployOutcomes } = await import("../../lifecycle/deploy-outcome");
  const outcomes = await readDeployOutcomes(env).catch(() => []);
  const plan = planReleaseRollback({
    env,
    records,
    declared: project.targets.map((c) => c.name),
    release: under.release,
    label: under.label,
    unsettled: new Set(unsettledComponents(records, outcomes).keys()),
    ...(only ? { only } : {}),
  });
  if ("error" in plan) {
    console.error(formatError({ message: plan.error, hint: ROLLBACK_USAGE }));
    return 1;
  }
  return afterRollback(ctx, project.projectPath, env, actor, { digest: under.release.releaseDigest, label: under.label }, await deployPlan(ctx, "rollback", plan, project, actor, rollbackRecord, under));
}

export async function runComponentsRedeploy(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const env = args.extraPositional;
  if (!env || !args.component) {
    console.error(formatError({ message: "an environment and --component <name> are required", hint: REDEPLOY_USAGE }));
    return 1;
  }
  const who = actorOrRefuse(ctx);
  if (typeof who === "number") return who;

  const project = await loadProject(ctx, args.component, env);
  if (typeof project === "number") return project;

  await fetchLifecycle().catch(() => false);
  const records = await readLedger(env);
  const plan = planRedeploy({
    env,
    records,
    declared: project.targets.map((c) => c.name),
    component: args.component,
    ...(args.digest ? { digest: args.digest } : {}),
  });
  if ("error" in plan) {
    console.error(formatError({ message: plan.error, hint: REDEPLOY_USAGE }));
    return 1;
  }
  const refused = await refuseRevokedRestore("redeploy", plan, records);
  if (refused !== undefined) return refused;
  return deployPlan(ctx, "redeploy", plan, project, who.actor, redeployRecord);
}
