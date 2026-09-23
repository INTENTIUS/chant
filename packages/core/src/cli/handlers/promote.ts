/**
 * `chant components promote --from <env> --to <env>` (#2530): deploy the
 * artifact digests the source environment's release ledger already records
 * to the target environment, without a build. The mechanism lives in
 * ../../components/promote.ts; this handler reads the ledger, prints the plan,
 * runs it, and appends the target's release records.
 *
 * Every component that deployed gets a record in the target ledger, even
 * when a later component failed or stopped at a gate, so the ledger never
 * misses a deploy that happened. Unlike an auto-recorded release, the record
 * is what a promote is for, so a failed write is an error rather than a
 * warning.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadChantConfig, type ChantConfig } from "../../config";
import { fetchLifecycle, getHeadCommit, pushLifecycle } from "../../lifecycle/git";
import { appendReleaseRecord, readReleaseLedger, resolveRunId, type ReleaseRecord } from "../../lifecycle/release-ledger";
import { resolveComponentTargets } from "../../components/cli-support";
import { applyConfigDefaults } from "../../components/config-defaults";
import { fanOutRegistry } from "../../components/fan-out-support";
import { renderDriverHuman } from "../../components/driver-output";
import { ndjsonProgressSink } from "../../components/run-progress";
import {
  planPromotion,
  withoutBuildSteps,
  runPromotion,
  promotionRecord,
  gateApprover,
  type PromotionPlan,
} from "../../components/promote";
import type { DriverComponent } from "../../components/driver";
import { writeGatedRunSummary } from "../../op/gate-summary";
import { approveCommand } from "../../op/gate";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import { formatError, formatWarning, formatSuccess, formatBold, formatInfo } from "../format";
import { GATED_EXIT_CODE } from "./run";
import type { CommandContext } from "../registry";

const USAGE =
  "chant components promote --from <env> --to <env> [--component <name> [--digest <sha256:...>]] [--dry-run] [--json]";

function renderPlan(plan: PromotionPlan, removed: Map<string, string[]>): void {
  console.error(formatBold(`promote ${plan.from} -> ${plan.to}`));
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

export async function runComponentsPromote(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const from = args.migrateFrom;
  const to = args.migrateTo;
  if (!from || !to) {
    console.error(formatError({ message: "--from <env> and --to <env> are required", hint: USAGE }));
    return 1;
  }

  // An unattributed record defeats the ledger, so resolve the actor before
  // anything deploys rather than after.
  const actor = args.actor ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER;
  if (!actor && !args.dryRun) {
    console.error(formatError({
      message: "Could not resolve --actor from the environment",
      hint: "Pass --actor explicitly, or set GITHUB_ACTOR / GITLAB_USER_LOGIN / USER.",
    }));
    return 1;
  }

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

  await fetchLifecycle().catch(() => false);
  const ledger = await readReleaseLedger(from);
  if (ledger.malformed > 0) {
    console.error(formatWarning({ message: `${ledger.malformed} malformed line(s) in the "${from}" release ledger were skipped` }));
  }

  const targets = await resolveComponentTargets(projectPath, args.component ?? "all", args.sandbox, paramsResolution.provenance);
  if (!targets.success) {
    console.error(formatError({ message: targets.error ?? "Could not discover components" }));
    return 1;
  }

  const plan = planPromotion({
    from,
    to,
    sourceRecords: ledger.records,
    declared: targets.targets.map((c) => c.name),
    ...(args.component ? { component: args.component } : {}),
    ...(args.digest ? { digest: args.digest } : {}),
  });
  if ("error" in plan) {
    console.error(formatError({ message: plan.error, hint: USAGE }));
    return 1;
  }

  const byName = new Map(targets.targets.map((c) => [c.name, applyConfigDefaults(c, config)]));
  const promotable: DriverComponent[] = [];
  const removed = new Map<string, string[]>();
  const refusals: string[] = [];
  for (const item of plan.items) {
    const prepared = withoutBuildSteps(byName.get(item.component)!);
    if ("error" in prepared) refusals.push(prepared.error);
    else {
      promotable.push(prepared.component);
      removed.set(item.component, prepared.removed);
    }
  }
  if (refusals.length > 0) {
    for (const message of refusals) console.error(formatError({ message }));
    console.error(formatError({ message: "nothing was promoted" }));
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
    else renderPlan(plan, removed);
    return 0;
  }
  if (!args.json) renderPlan(plan, removed);

  const seededOutputs: Record<string, Record<string, unknown>> = {};
  for (const file of args.seedOutputs ?? []) {
    try {
      Object.assign(seededOutputs, JSON.parse(readFileSync(resolve(file), "utf8")));
    } catch (err) {
      console.error(formatError({ message: `--seed-outputs: could not read "${file}": ${err instanceof Error ? err.message : String(err)}` }));
      return 1;
    }
  }

  const registry = await fanOutRegistry(projectPath, config);
  const run = await runPromotion({
    plan,
    components: promotable,
    registry,
    componentOutputs: seededOutputs,
    ...(args.progressJson ? { onProgress: ndjsonProgressSink() } : {}),
  });
  if (!args.json) renderDriverHuman(run);

  // Record every component that deployed, whatever happened to the rest: a
  // component that reached prod and is missing from prod's ledger would be
  // exactly the unrecorded deploy the ledger exists to rule out.
  const deployed = plan.items.filter((item) => run.results.some((r) => r.component === item.component && r.status === "ok"));
  const { runId, runOrigin } = resolveRunId(args.runId);
  const timestamp = new Date().toISOString();
  const recorded: ReleaseRecord[] = [];
  let recordError: string | undefined;
  if (deployed.length > 0) {
    try {
      for (const item of deployed) {
        const approver = gateApprover(run.results.find((r) => r.component === item.component));
        const { record } = await appendReleaseRecord(
          promotionRecord(item, to, { runId, ...(runOrigin ? { runOrigin } : {}), actor: actor!, timestamp, ...(approver ? { approver } : {}) }),
        );
        recorded.push(record);
      }
      await pushLifecycle();
    } catch (err) {
      recordError = err instanceof Error ? err.message : String(err);
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ ...planJson(plan, removed), run, recorded }, null, 2));
  } else {
    for (const record of recorded) {
      console.error(formatSuccess(`Promoted ${formatBold(record.component)} ${from} -> ${to}: ${record.digest}`));
    }
  }

  if (recordError !== undefined) {
    console.error(formatError({
      message: `deployed to "${to}", but the release record was not written: ${recordError}`,
      hint: `Pull the chant/lifecycle branch and check \`chant components status ${to}\` before promoting again.`,
    }));
    return 1;
  }

  if (run.status === "gated" && run.gate) {
    const pending = run.gate;
    console.error(formatWarning({ message: `component "${run.gatedComponent}" is gated on "${pending.gate}" — pending approval` }));
    console.error(formatInfo(`approve : ${approveCommand(pending.op, pending.gate)}`));
    console.error(formatInfo("then run the same promote again"));
    writeGatedRunSummary({
      op: pending.op,
      gate: pending.gate,
      ...(pending.description ? { description: pending.description } : {}),
      expiresAt: pending.expiresAt,
      ...(pending.url ? { url: pending.url } : {}),
      ...(pending.planDigest ? { planDigest: pending.planDigest } : {}),
    });
    return GATED_EXIT_CODE;
  }

  if (run.status !== "ok") {
    console.error(formatError({ message: `promote failed at "${run.failedComponent ?? "unknown"}"` }));
    return 1;
  }
  return 0;
}
