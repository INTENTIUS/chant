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
  gateAdmission,
  type DeployRunInfo,
  type PromotionItem,
  type PromotionPlan,
} from "../../components/promote";
import { failedRunExitCode, type DriverComponent } from "../../components/driver";
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

const PROMOTE_USAGE =
  "chant components promote --to <env> [--from <env>] [--allow-skip] [--release <label|digest>] [--component <name> [--digest <sha256:...>] | --digest <component>=<sha256:...> ...] [--wave-gate <gate>] [--resume <file>] [--dry-run] [--json]";
const ROLLBACK_USAGE =
  "chant components rollback <env> (--component <name> [--digest <sha256:...>] | --release <label|digest>) [--dry-run] [--json]";
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
  return ctx.args.actor ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER;
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
    if (empty) {
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
    return { binding: { op: gate.RELEASE_GATE_OP, planDigest: doc.digest, releaseDigest, verifyEmpty }, empty };
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
          binding: { op: gate.RELEASE_GATE_OP, planDigest: stored.document.digest, releaseDigest, verifyEmpty },
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
): Promise<number> {
  return withComponentEndpoint(ctx, () => deployPlanIn(ctx, verb, plan, project, actor, record, under), { config: project.config, environment: plan.to });
}

async function deployPlanIn(
  ctx: CommandContext,
  verb: Verb,
  plan: PromotionPlan,
  project: { projectPath: string; config: ChantConfig; targets: DriverComponent[] },
  actor: string | undefined,
  record: (item: PromotionItem, env: string, run: DeployRunInfo) => ReleaseRecordInput,
  under?: UnderRelease,
): Promise<number> {
  const { args } = ctx;
  if (refusesBothStreams(args)) return 1;
  const byName = new Map(project.targets.map((c) => [c.name, applyConfigDefaults(c, project.config)]));
  const prepared: DriverComponent[] = [];
  const removed = new Map<string, string[]>();
  const refusals: string[] = [];
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
    if (args.json) console.log(JSON.stringify({ ...planJson(plan, removed), ...releaseJson }, null, 2));
    else {
      renderPlan(verb, plan, removed);
      if (under) console.error(`  under release ${under.label ?? under.release.releaseDigest}: ${under.target.templates.length} template(s) from its "${plan.to}" target`);
    }
    return 0;
  }
  if (!args.json) renderPlan(verb, plan, removed);
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
  prepared.splice(0, prepared.length, ...(await withDeclaredReads(prepared, registry, project.projectPath)));
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
        ...(resume ? { resume } : {}),
        ...(grouped ? { grouped } : {}),
        groupRuns,
      });
      if (typeof result === "number") {
        tidy();
        return result;
      }
      if (result) {
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
        const input = record(item, plan.to, { runId, ...(runOrigin ? { runOrigin } : {}), actor: actor!, timestamp, ...(approver ? { approver } : {}), ...(admission ? { admission } : {}) });
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
    console.log(JSON.stringify({ ...planJson(plan, removed), ...withChangeSet, ...stagedJson, ...prJson, ...groupsReport, run, recorded, ...(outcome ? { outcome } : {}) }, null, 2));
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
    console.error(formatInfo(`approve : ${approveCommand(pending.op, pending.gate, pending.environment, undefined, sealed)}`));
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
 */
async function resolveUnderRelease(ref: string, env: string, verb: "promote" | "rollback", fix: (release: { releaseDigest: string }) => Promise<string> | string): Promise<UnderRelease | number> {
  const { resolveRelease } = await import("../../lifecycle/release-store");
  const { targetFor, isImplicitRelease } = await import("../../components/release-promote");
  const found = await resolveRelease(ref);
  if (!found) {
    console.error(formatError({ message: `no release is labelled or digested "${ref}" in this member`, hint: "List them with: chant release list" }));
    return 1;
  }
  const target = targetFor(found.release, env);
  if ("error" in target) {
    console.error(formatError({ message: target.error }));
    return 1;
  }
  // #4046: a release of a project with no components records build output
  // and no component, so there is no deploy step here to point at it.
  if (isImplicitRelease(found.release)) {
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
  const who = actorOrRefuse(ctx);
  if (typeof who === "number") return who;

  const project = await loadProject(ctx, args.component ?? "all", to);
  if (typeof project === "number") return project;

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
  const from = resolved.from;
  if (!from) {
    console.error(formatError({ message: "--from <env> is required: this member declares no environments, so there is no promotion order to default it from", hint: PROMOTE_USAGE }));
    return 1;
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
    const found = await resolveUnderRelease(args.release, to, "promote", () =>
      "Promote a release cut from a green commit: `chant ci last-green` names the newest, and `chant release list` marks the revoked releases. Fetch the tags first: git fetch origin --tags",
    );
    if (typeof found === "number") return found;
    under = found;
  }

  const plan = planPromotion({
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
  return deployPlan(ctx, "promote", plan, project, who.actor, promotionRecord, under);
}

export async function runComponentsRollback(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const env = args.extraPositional;
  if (!env || (!args.component && !args.release)) {
    console.error(formatError({ message: "an environment and --component <name> or --release <label|digest> are required", hint: ROLLBACK_USAGE }));
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
    return deployPlan(ctx, "rollback", plan, project, who.actor, rollbackRecord, under);
  }
  return deployPlan(ctx, "rollback", plan, project, who.actor, rollbackRecord);
}

/**
 * `chant components rollback <env> --release <label|digest>` (#4035): a
 * gated promote of an earlier release into `env`. Every component of the
 * release is restored at the digest `env` recorded running it from that
 * release, its deploy reads the templates the release recorded for `env`,
 * and its gates bind the release's change set planned against what `env`
 * runs now, as `promote --release` binds them (#4045).
 */
async function runReleaseRollback(ctx: CommandContext, env: string, ref: string, actor: string | undefined): Promise<number> {
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
  });
  if ("error" in plan) {
    console.error(formatError({ message: plan.error, hint: ROLLBACK_USAGE }));
    return 1;
  }
  return deployPlan(ctx, "rollback", plan, project, actor, rollbackRecord, under);
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
