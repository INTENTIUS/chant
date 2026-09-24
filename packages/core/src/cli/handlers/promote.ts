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
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadChantConfig, type ChantConfig } from "../../config";
import { fetchLifecycle, getHeadCommit, pushLifecycle } from "../../lifecycle/git";
import {
  appendReleaseRecord,
  readReleaseLedger,
  resolveRunId,
  type ReleaseRecord,
  type ReleaseRecordInput,
} from "../../lifecycle/release-ledger";
import { resolveComponentTargets } from "../../components/cli-support";
import { applyConfigDefaults } from "../../components/config-defaults";
import { fanOutRegistry } from "../../components/fan-out-support";
import { renderDriverHuman } from "../../components/driver-output";
import { ndjsonProgressSink } from "../../components/run-progress";
import {
  parseDigestPins,
  planPromotion,
  planRollback,
  planRedeploy,
  withoutBuildSteps,
  runPromotion,
  promotionRecord,
  rollbackRecord,
  redeployRecord,
  gateApprover,
  type DeployRunInfo,
  type PromotionItem,
  type PromotionPlan,
} from "../../components/promote";
import type { DriverComponent } from "../../components/driver";
import { summaryLedgerPrefix, writeGatedRunSummary } from "../../op/gate-summary";
import { approveCommand } from "../../op/gate";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import { formatError, formatWarning, formatSuccess, formatBold, formatInfo } from "../format";
import { GATED_EXIT_CODE } from "./run";
import type { CommandContext } from "../registry";

const PROMOTE_USAGE =
  "chant components promote --from <env> --to <env> [--component <name> [--digest <sha256:...>] | --digest <component>=<sha256:...> ...] [--dry-run] [--json]";
const ROLLBACK_USAGE =
  "chant components rollback <env> --component <name> [--digest <sha256:...>] [--dry-run] [--json]";
const REDEPLOY_USAGE =
  "chant components redeploy <env> --component <name> [--digest <sha256:...>] [--dry-run] [--json]";

type Verb = "promote" | "rollback" | "redeploy";

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
): Promise<number> {
  const { args } = ctx;
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

  if (args.dryRun) {
    if (args.json) console.log(JSON.stringify(planJson(plan, removed), null, 2));
    else renderPlan(verb, plan, removed);
    return 0;
  }
  if (!args.json) renderPlan(verb, plan, removed);

  const seededOutputs: Record<string, Record<string, unknown>> = {};
  for (const file of args.seedOutputs ?? []) {
    try {
      Object.assign(seededOutputs, JSON.parse(readFileSync(resolve(file), "utf8")));
    } catch (err) {
      console.error(formatError({ message: `--seed-outputs: could not read "${file}": ${err instanceof Error ? err.message : String(err)}` }));
      return 1;
    }
  }

  const registry = await fanOutRegistry(project.projectPath, project.config);
  const run = await runPromotion({
    plan,
    components: prepared,
    registry,
    componentOutputs: seededOutputs,
    ...(args.progressJson ? { onProgress: ndjsonProgressSink() } : {}),
  });
  if (!args.json) renderDriverHuman(run);

  // Record every component that deployed, whatever happened to the rest: a
  // component that reached the environment and is missing from its ledger
  // would be exactly the unrecorded deploy the ledger exists to rule out.
  const deployed = plan.items.filter((item) => run.results.some((r) => r.component === item.component && r.status === "ok"));
  const { runId, runOrigin } = resolveRunId(args.runId);
  const timestamp = new Date().toISOString();
  const recorded: ReleaseRecord[] = [];
  let recordError: string | undefined;
  if (deployed.length > 0) {
    try {
      for (const item of deployed) {
        const approver = gateApprover(run.results.find((r) => r.component === item.component));
        const { record: written } = await appendReleaseRecord(
          record(item, plan.to, { runId, ...(runOrigin ? { runOrigin } : {}), actor: actor!, timestamp, ...(approver ? { approver } : {}) }),
        );
        recorded.push(written);
      }
      await pushLifecycle();
    } catch (err) {
      recordError = err instanceof Error ? err.message : String(err);
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ ...planJson(plan, removed), run, recorded }, null, 2));
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

  if (recordError !== undefined) {
    console.error(formatError({
      message: `deployed to "${plan.to}", but the release record was not written: ${recordError}`,
      hint: `Pull the chant/lifecycle branch and check \`chant components status ${plan.to}\` before running this again.`,
    }));
    return 1;
  }

  if (run.status === "gated" && run.gate) {
    const pending = run.gate;
    console.error(formatWarning({ message: `component "${run.gatedComponent}" is gated on "${pending.gate}" — pending approval` }));
    console.error(formatInfo(`approve : ${approveCommand(pending.op, pending.gate)}`));
    console.error(formatInfo(`then run the same ${verb} again`));
    writeGatedRunSummary({
      op: pending.op,
      gate: pending.gate,
      ...(pending.description ? { description: pending.description } : {}),
      expiresAt: pending.expiresAt,
      ...(pending.url ? { url: pending.url } : {}),
      ...(pending.planDigest ? { planDigest: pending.planDigest } : {}),
      ...(await summaryLedgerPrefix()),
    });
    return GATED_EXIT_CODE;
  }

  if (run.status !== "ok") {
    console.error(formatError({ message: `${verb} failed at "${run.failedComponent ?? "unknown"}"` }));
    return 1;
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

export async function runComponentsPromote(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const from = args.migrateFrom;
  const to = args.migrateTo;
  if (!from || !to) {
    console.error(formatError({ message: "--from <env> and --to <env> are required", hint: PROMOTE_USAGE }));
    return 1;
  }
  const who = actorOrRefuse(ctx);
  if (typeof who === "number") return who;

  const project = await loadProject(ctx, args.component ?? "all");
  if (typeof project === "number") return project;

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
  return deployPlan(ctx, "promote", plan, project, who.actor, promotionRecord);
}

export async function runComponentsRollback(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const env = args.extraPositional;
  if (!env || !args.component) {
    console.error(formatError({ message: "an environment and --component <name> are required", hint: ROLLBACK_USAGE }));
    return 1;
  }
  const who = actorOrRefuse(ctx);
  if (typeof who === "number") return who;

  const project = await loadProject(ctx, args.component);
  if (typeof project === "number") return project;

  await fetchLifecycle().catch(() => false);
  const plan = planRollback({
    env,
    records: await readLedger(env),
    declared: project.targets.map((c) => c.name),
    component: args.component,
    ...(args.digest ? { digest: args.digest } : {}),
  });
  if ("error" in plan) {
    console.error(formatError({ message: plan.error, hint: ROLLBACK_USAGE }));
    return 1;
  }
  return deployPlan(ctx, "rollback", plan, project, who.actor, rollbackRecord);
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
  const plan = planRedeploy({
    env,
    records: await readLedger(env),
    declared: project.targets.map((c) => c.name),
    component: args.component,
    ...(args.digest ? { digest: args.digest } : {}),
  });
  if ("error" in plan) {
    console.error(formatError({ message: plan.error, hint: REDEPLOY_USAGE }));
    return 1;
  }
  return deployPlan(ctx, "redeploy", plan, project, who.actor, redeployRecord);
}
