/**
 * `chant components pr-plan` and `chant components pr-apply` (#3183): the
 * pull-request loop the generated CI runs.
 *
 * ```
 * chant components pr-plan  --base <ref> --pr <n> --env <env> [--forge github|gitlab|forgejo]
 * chant approve pr-<n> pr-apply --plan <digest> --approver github:<login> --sign
 * chant components pr-apply --base <ref> --env <env> [--pr <n>] [--forge <kind>] [--require-review]
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
 * Every run writes `pr-plan.json` or `pr-apply.json` (`pr-report.schema.json`),
 * `change-set.json` and `pr-note.md` under `--output` (default `.chant/pr`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadChantConfig, resolveAutoReleaseDisabled, type ChantConfig } from "../../config";
import { resolveCommit, resolveMergeBase } from "../../components/changed-files";
import { deriveFanOut, fanOutRegistry } from "../../components/fan-out-support";
import {
  applyPrSet,
  approvalOf,
  approversWithoutReview,
  decidePrGate,
  planPrSet,
  prReport,
  readOnlyLedger,
  type PrPlanSet,
} from "../../components/pr-run";
import { gitGateLedgerPort } from "../../op/gate";
import {
  describePlanChanged,
  PR_APPLY_GATE,
  PR_STATUS_CONTEXTS,
  prApproveCommand,
  prNoteMarker,
  prOp,
  prStatusDescription,
  prStatusState,
  renderPrNote,
  type PrApproval,
  type PrReport,
} from "../../pr-loop";
import { FORGE_KINDS, forgeFromEnv, forgePrincipalOf, type ForgeKind, type PrForge } from "../../pr-forge";
import { GITHUB_COMMENT_LIMIT, GITLAB_NOTE_LIMIT } from "../../plan-summary";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../format";
import { resolveChangedUnits } from "./fan-out";
import { GATED_EXIT_CODE, recordAutoReleasesForRun } from "./run";
import type { CommandContext } from "../registry";
import type { ComponentChangeSignal, FanOutPlan } from "../../components/fan-out";
import type { DriverComponent } from "../../components/driver";
import type { CapabilityRegistry } from "../../components/capability";


/** Where the reports land unless `--output` says. */
export const PR_REPORT_DIR = ".chant/pr";

interface Prepared {
  config: ChantConfig;
  env: string;
  base: string;
  head: string;
  gate: string;
  forge?: PrForge;
  components: DriverComponent[];
  plan: FanOutPlan;
  signal: ComponentChangeSignal;
  registry: CapabilityRegistry;
  set: PrPlanSet;
}

const fail = (message: string, hint?: string): number => {
  console.error(formatError({ message, ...(hint ? { hint } : {}) }));
  return 1;
};

/** Everything both stages share: the change, the derivation and the plan of every member. */
async function prepare(ctx: CommandContext, stage: "plan" | "apply"): Promise<Prepared | number> {
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
  if (args.forge !== undefined && !(FORGE_KINDS as readonly string[]).includes(args.forge)) {
    return fail(`--forge ${args.forge} is not one of ${FORGE_KINDS.join(", ")}`);
  }

  let forge: PrForge | undefined;
  if (args.forge) {
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
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!derived.success) return fail(derived.error ?? "Could not discover components");

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
  const set = await planPrSet({ components: derived.components, plan: derived.plan, registry, env, seededOutputs });
  return {
    config,
    env,
    base,
    head,
    gate: args.gate ?? PR_APPLY_GATE,
    ...(forge ? { forge } : {}),
    components: derived.components,
    plan: derived.plan,
    signal: derived.signal,
    registry,
    set,
  };
}

/** Write the report, the change set and the note; print the note's path. */
function writeOutputs(ctx: CommandContext, report: PrReport, note: string): void {
  const dir = resolve(ctx.args.output ?? PR_REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pr-${report.stage}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(dir, "change-set.json"), JSON.stringify(report.changeSet, null, 2) + "\n");
  writeFileSync(join(dir, "pr-note.md"), note);
}

/** Post the note and the stage's status. A forge that refuses is a warning: the stage's outcome stands. */
async function publish(forge: PrForge | undefined, report: PrReport, note: string): Promise<void> {
  if (!forge) return;
  const status = {
    context: PR_STATUS_CONTEXTS[report.stage],
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
  try {
    await forge.upsertNote(report.pr, prNoteMarker(report.env), note);
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

async function finish(ctx: CommandContext, p: Prepared, report: PrReport): Promise<void> {
  const note = noteFor(report, p.forge);
  writeOutputs(ctx, report, note);
  await publish(p.forge, report, note);
  if (ctx.args.json) console.log(JSON.stringify(report, null, 2));
}

/** chant components pr-plan --base <ref> --pr <n> [--env <env>] [--gate <name>] [--forge <kind>] [--output <dir>] [--json] */
export async function runComponentsPrPlan(ctx: CommandContext): Promise<number> {
  if (ctx.args.pr === undefined) {
    return fail("pr-plan needs the pull or merge request: --pr <n>", "Its approval is recorded under op pr-<n>, so one pull request's approval never answers another's.");
  }
  const p = await prepare(ctx, "plan");
  if (typeof p === "number") return p;
  const op = prOp(ctx.args.pr);

  let approval: PrApproval = { status: "pending" };
  if (p.plan.order.length > 0) {
    try {
      approval = approvalOf(await decidePrGate(readOnlyLedger(gitGateLedgerPort()), { op, gate: p.gate, digest: p.set.doc.digest }));
    } catch (err) {
      console.error(formatWarning({ message: `could not read the gate ledger, so the approval reads as pending: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }
  const status = p.plan.order.length === 0 ? "nothing" : p.set.failed ? "plan-failed" : "planned";
  const report = prReport({
    stage: "plan",
    pr: ctx.args.pr,
    env: p.env,
    base: p.base,
    head: p.head,
    op,
    gate: p.gate,
    plan: p.plan,
    signal: p.signal,
    set: p.set,
    approval,
    status,
  });
  await finish(ctx, p, report);

  console.error(formatInfo(`pr-plan: ${report.members.length} member(s), ${status}`));
  printMembers(report);
  if (status === "planned") {
    console.error(formatInfo(`plan    : ${report.digest}`));
    console.error(formatInfo(approval.status === "approved" ? `approved by ${(approval.approvedBy ?? []).join(", ")}` : `approve : ${prApproveCommand(report)}`));
  }
  return status === "plan-failed" ? 1 : 0;
}

/** chant components pr-apply --base <ref> [--pr <n>] [--env <env>] [--gate <name>] [--forge <kind>] [--require-review] [--output <dir>] [--json] */
export async function runComponentsPrApply(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.requireReview && !args.forge) return fail("--require-review reads the pull request's reviews, so it needs --forge <kind>");
  const p = await prepare(ctx, "apply");
  if (typeof p === "number") return p;

  let pr: number | null = args.pr ?? null;
  if (pr === null && p.forge && p.plan.order.length > 0) {
    try {
      pr = await p.forge.pullRequestFor(p.head);
    } catch (err) {
      return fail(`could not ask ${p.forge.kind} which pull request merged ${p.head}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const op = pr === null ? "pr-unknown" : prOp(pr);
  const base = { stage: "apply" as const, pr, env: p.env, base: p.base, head: p.head, op, gate: p.gate, plan: p.plan, signal: p.signal, set: p.set };

  const stop = async (report: PrReport, code: number): Promise<number> => {
    await finish(ctx, p, report);
    console.error((code === 0 ? formatInfo : (m: string) => formatWarning({ message: m }))(`pr-apply: ${report.status}${report.refusal ? ` (${report.refusal})` : ""}`));
    if (report.message) console.error(report.message);
    printMembers(report);
    return code;
  };

  if (p.plan.order.length === 0) {
    return stop(prReport({ ...base, approval: { status: "pending" }, status: "nothing" }), 0);
  }
  if (pr === null) {
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
  if (p.set.failed) {
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

  const check = await decidePrGate(gitGateLedgerPort(), {
    op,
    gate: p.gate,
    digest: p.set.doc.digest,
    description: `pull request #${pr}: ${p.plan.order.join(", ")}`,
  });
  const approval = approvalOf(check);
  if (!check.satisfied) {
    const partial = { ...base, approval, status: "refused" as const };
    const report = approval.status === "changed"
      ? prReport({ ...partial, refusal: "plan-changed", message: describePlanChanged({ op, gate: p.gate, digest: p.set.doc.digest, approval }) })
      : prReport({
          ...partial,
          refusal: "not-approved",
          message: `No approval stands for this plan, so nothing was applied. Approve it: ${prApproveCommand({ op, gate: p.gate, digest: p.set.doc.digest })}; then run the apply again.`,
        });
    return stop(report, GATED_EXIT_CODE);
  }

  if (args.requireReview && p.forge) {
    let reviewers: string[];
    try {
      reviewers = (await p.forge.approvers(pr)).map((login) => p.forge!.principalOf(login));
    } catch (err) {
      return fail(`could not read the reviews of #${pr}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const strangers = approversWithoutReview(approval.approvedBy ?? [], reviewers);
    if (strangers.length > 0) {
      return stop(
        prReport({
          ...base,
          approval,
          status: "refused",
          refusal: "not-a-reviewer",
          message:
            `The plan is approved by ${strangers.join(", ")}, who ${strangers.length === 1 ? "has" : "have"} no approving review on #${pr}` +
            ` (approving reviews: ${reviewers.join(", ") || "none"}). Nothing was applied. ` +
            `An approval counts when it names the reviewer the way the forge does: ${p.forge.principalOf("<login>")}.`,
        }),
        GATED_EXIT_CODE,
      );
    }
  }

  const applied = await applyPrSet({ components: p.components, plan: p.plan, registry: p.registry, env: p.env, set: p.set });
  await recordAutoReleasesForRun(applied.run.results, p.env, `${op}-${Date.now()}`, resolveAutoReleaseDisabled(p.config, args.noReleaseRecord));
  const report = prReport({ ...base, approval, status: applied.status, members: applied.members });
  const code = await stop(report, applied.status === "applied" ? 0 : 1);
  if (applied.status === "applied") console.error(formatSuccess(`applied the plan ${report.digest} approved by ${(approval.approvedBy ?? []).join(", ")}`));
  return code;
}
