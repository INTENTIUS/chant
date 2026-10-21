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

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadChantConfig, type ChantConfig } from "../../config";
import { promotionOrder } from "../../workspace/promotion-order";
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
import { redeployLine, releaseRollbackLine, rollbackTarget, unsettledComponents } from "../../lifecycle/mixed-environment";

const PROMOTE_USAGE =
  "chant components promote --to <env> [--from <env>] [--allow-skip] [--release <label|digest>] [--component <name> [--digest <sha256:...>] | --digest <component>=<sha256:...> ...] [--dry-run] [--json]";
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

/** Config, params and the declared components, or the exit code of a refusal already printed. */
async function loadProject(ctx: CommandContext, selector: string) {
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

/**
 * Plan, store and bind the release gate for a promote under a release
 * (#4045, ws-104 questions 2 and 6). Undefined when no promoted composition
 * declares a gate, so there is nothing to bind. A number is the exit code of
 * a refusal already printed: a provisional member, or a member that failed
 * to plan. On an empty change set, each gate gets an `empty: true`
 * resolution the run then counts once it reads the stored document back.
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
}): Promise<{ binding: ReleaseGateBinding; doc: ChangeSetDocument; empty: boolean } | number | undefined> {
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

  const doc = await gate.planReleaseChangeSet({
    release: under.release,
    env,
    components: input.prepared,
    digests: new Map(plan.items.map((i) => [i.component, i.digest])),
    registry: input.registry,
    current,
    unsettled,
    seededOutputs: input.seededOutputs,
  });
  const provisional = gate.provisionalMembers(doc);
  if (provisional.length > 0) {
    console.error(formatError({
      message: `the change set of release ${under.label ?? releaseDigest} for "${env}" has provisional members (${provisional.join(", ")}), which no approval covers; nothing was deployed`,
      hint: "Deploy what they read first, so they plan against real values.",
    }));
    return 1;
  }
  const failed = doc.members.filter((m) => m.status === "failed");
  if (failed.length > 0) {
    for (const m of failed) console.error(formatError({ message: `${m.member} failed to plan for "${env}"${m.error ? `: ${m.error}` : ""}` }));
    console.error(formatError({ message: "nothing was deployed" }));
    return 1;
  }

  // The document is stored before the gate is decided, so the plan a pending
  // gate waits on can be read, and an empty pass can be checked.
  const { storeGateChangeSet } = await import("../../lifecycle/gate-change-set");
  try {
    const stored = await storeGateChangeSet({ doc, cwd: input.projectPath, at: input.head ?? null });
    if (stored.warning) console.error(formatWarning({ message: stored.warning }));
  } catch (err) {
    console.error(formatWarning({ message: `could not store the change set ${doc.digest}: ${err instanceof Error ? err.message : String(err)}` }));
  }
  const { isEmptyChangeSet } = await import("../../change-set");
  const empty = isEmptyChangeSet(doc);
  console.error(formatInfo(
    `release gate: change set ${doc.digest} for "${env}"` +
      (empty ? ", empty: its gates pass without an approval" : `, ${doc.summary.entries} entr${doc.summary.entries === 1 ? "y" : "ies"}, ${doc.summary.holes} hole(s)`) +
      ` (chant change-set show ${doc.digest})`,
  ));

  if (empty) {
    if (!port.appendResolution) throw new Error("the gate ledger can't record a resolution, so an empty change set can't pass its gates");
    const { resolutions } = await port.read(gate.RELEASE_GATE_OP);
    const timestamp = new Date().toISOString();
    for (const name of gates) {
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

  const { readStoredChangeSet } = await import("../../lifecycle/change-set-store");
  return {
    doc,
    empty,
    binding: {
      op: gate.RELEASE_GATE_OP,
      planDigest: doc.digest,
      releaseDigest,
      verifyEmpty: gate.emptyVerifier((digest) => readStoredChangeSet(digest, { cwd: input.projectPath }), { releaseDigest, environment: env }),
    },
  };
}

/**
 * Prepare, run and record a plan. Shared by promote, rollback and redeploy,
 * which differ only in how the plan was chosen, whether the publish step runs,
 * and which field names the earlier release on the new record.
 */
async function deployPlan(
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
  for (const item of plan.items) {
    // A rollback and a redeploy deploy a release this environment already
    // received, so neither runs the publish step.
    const result = withoutBuildSteps(
      byName.get(item.component)!,
      verb === "promote" ? {} : { pinDigest: item.digest, verb: `a ${verb}` },
    );
    if ("error" in result) refusals.push(result.error);
    else {
      prepared.push(result.component);
      removed.set(item.component, result.removed);
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
  if (under) {
    const { pinReleaseTemplates } = await import("../../components/release-promote");
    const { readReleaseTemplate } = await import("../../lifecycle/release-store");
    const pinned = await pinReleaseTemplates(prepared, under.release, under.target, (digest, encoding) => readReleaseTemplate(digest, undefined, encoding));
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

  const registry = await fanOutRegistry(project.projectPath, project.config);
  const port = gitGateLedgerPort();
  // #4045: under a release, every gate binds the release's change set for this environment.
  let releaseGate: ReleaseGateBinding | undefined;
  let changeSetJson: { changeSet: string; empty: boolean } | undefined;
  if (under) {
    try {
      const bound = await bindReleaseGate({ plan, prepared, under, registry, port, seededOutputs, actor: actor!, projectPath: project.projectPath, head });
      if (typeof bound === "number") {
        tidy();
        return bound;
      }
      if (bound) {
        releaseGate = bound.binding;
        changeSetJson = { changeSet: bound.doc.digest, empty: bound.empty };
      }
    } catch (err) {
      tidy();
      throw err;
    }
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
  try {
    run = await runPromotion({
      plan,
      components: prepared,
      registry,
      componentOutputs: seededOutputs,
      gates: port,
      ...(releaseGate ? { releaseGate } : {}),
      ...(args.progressJson ? { onProgress: ndjsonProgressSink() } : {}),
      ...(events ? { onRunEvent: events.emit } : {}),
    });
  } catch (err) {
    events?.settle("failed", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    tidy();
  }
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
        const { record: written } = await appendReleaseRecord(under ? { ...input, releaseDigest: under.release.releaseDigest } : input);
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
    console.log(JSON.stringify({ ...planJson(plan, removed), ...withChangeSet, run, recorded, ...(outcome ? { outcome } : {}) }, null, 2));
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
  const who = actorOrRefuse(ctx);
  if (typeof who === "number") return who;

  const project = await loadProject(ctx, args.component ?? "all");
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

  const project = await loadProject(ctx, args.component!);
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
  const project = await loadProject(ctx, "all");
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

  const project = await loadProject(ctx, args.component);
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
