/**
 * `chant components pr-plan` and `chant components pr-apply` (#3183): the
 * pull-request loop the generated CI runs.
 *
 * ```
 * chant components pr-plan  --base <ref> --pr <n> --env <env> [--forge github|gitlab|forgejo]
 * chant approve pr-<n> pr-apply --plan <digest> --approver github:<login> --sign
 * chant components pr-apply --base <ref> --env <env> [--pr <n>] [--forge <kind>] [--require-review] [--resume <file>]
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
 * Every run writes `pr-plan.json` or `pr-apply.json` (`pr-report.schema.json`),
 * `change-set.json` and `pr-note.md` under `--output` (default `.chant/pr`). *
 * `--member <name>` (#3465) runs a workspace member's loop: the member's
 * generated pipeline passes it from the member's directory. The gate is
 * recorded under `pr-<n>-<member>`, and the note and the statuses carry the
 * member's name, so each member's loop on one pull request stands apart.
 * The name must be the member that owns the current directory.
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
  resumePrSet,
  type PrPlanSet,
} from "../../components/pr-run";
import { readFanOutAttempt, writeFanOutAttempt, type FanOutAttempt, type PrApplyRecord } from "../../components/fan-out-record";
import { samePlanDigest } from "../../lifecycle/plan-digest";
import { gitGateLedgerPort } from "../../op/gate";
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
  type PrReport,
} from "../../pr-loop";
import { FORGE_KINDS, forgeFromEnv, forgePrincipalOf, type ForgeKind, type PrForge } from "../../pr-forge";
import { GITHUB_COMMENT_LIMIT, GITLAB_NOTE_LIMIT } from "../../plan-summary";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../format";
import { findWorkspaceRoot } from "../../project-root";
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
  /** The workspace member, with `--member` (#3465). */
  member?: string;
  base: string;
  head: string;
  gate: string;
  forge?: PrForge;
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
function planAll(p: Prepared): Promise<PrPlanSet> {
  return planPrSet({ components: p.components, plan: p.plan, registry: p.registry, env: p.env, seededOutputs: p.seededOutputs });
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
  const set = await planAll(p);
  const op = prOp(ctx.args.pr, p.member);

  let approval: PrApproval = { status: "pending" };
  if (p.plan.order.length > 0) {
    try {
      approval = approvalOf(await decidePrGate(readOnlyLedger(gitGateLedgerPort()), { op, gate: p.gate, digest: set.doc.digest }));
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
  const op = pr === null ? "pr-unknown" : prOp(pr, p.member);

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
  const resumed = pr !== null && p.plan.order.length > 0 && attempt ? await tryResume(p, attempt, args.resume!, op) : undefined;

  const set = resumed?.set ?? (await planAll(p));
  const base = { stage: "apply" as const, pr, env: p.env, ...(p.member ? { member: p.member } : {}), base: p.base, head: p.head, op, gate: p.gate, plan: p.plan, signal: p.signal, set };

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

  let approval: PrApproval;
  if (resumed) {
    approval = resumed.approval;
  } else {
    const check = await decidePrGate(gitGateLedgerPort(), {
      op,
      gate: p.gate,
      digest: set.doc.digest,
      description: `pull request #${pr}: ${p.plan.order.join(", ")}`,
    });
    approval = approvalOf(check);
    if (!check.satisfied) {
      const partial = { ...base, approval, status: "refused" as const };
      const report = approval.status === "changed"
        ? prReport({ ...partial, refusal: "plan-changed", message: describePlanChanged({ op, gate: p.gate, digest: set.doc.digest, approval }) })
        : prReport({
            ...partial,
            refusal: "not-approved",
            message: `No approval stands for this plan, so nothing was applied. Approve it: ${prApproveCommand({ op, gate: p.gate, digest: set.doc.digest })}; then run the apply again.`,
          });
      return stop(report, GATED_EXIT_CODE);
    }
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

  // The record is written before the first component runs and again as each
  // one settles, so a run killed partway still knows what applied.
  const prior = resumed ? { completed: resumed.completed, outputs: resumed.outputs } : { completed: [], outputs: {} };
  const completedSoFar = new Set<string>(prior.completed);
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
      prApply: record,
    });
  };
  recordAttempt();

  const applied = await applyPrSet({
    components: p.components,
    plan: resumed?.plan ?? p.plan,
    registry: p.registry,
    env: p.env,
    set,
    ...(resumed ? { resumed: prior } : {}),
    ...(resumePath
      ? {
          onComponentSettled: (settled, outputs) => {
            if (settled.status === "ok") {
              completedSoFar.add(settled.component);
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
  await recordAutoReleasesForRun(applied.run.results, p.env, `${op}-${Date.now()}`, resolveAutoReleaseDisabled(p.config, args.noReleaseRecord));
  const report = prReport({
    ...base,
    approval,
    status: applied.status,
    members: applied.members,
    ...(resumed ? { resumed: resumed.completed } : {}),
  });
  const code = await stop(report, applied.status === "applied" ? 0 : 1);
  if (applied.status === "applied") console.error(formatSuccess(`applied the plan ${report.digest} approved by ${(approval.approvedBy ?? []).join(", ")}`));
  return code;
}

interface Resumed {
  plan: FanOutPlan;
  set: PrPlanSet;
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
 */
async function tryResume(p: Prepared, attempt: FanOutAttempt, file: string, op: string): Promise<Resumed | undefined> {
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

  let check;
  try {
    check = await decidePrGate(readOnlyLedger(gitGateLedgerPort()), { op, gate: p.gate, digest: record.digest });
  } catch (err) {
    return skip(`could not read the gate ledger: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!check.satisfied) return skip(`no approval stands for the plan it applied (${record.digest}) any more`);

  const outputs = Object.fromEntries(Object.entries(attempt.outputs).filter(([name]) => attempt.completed.includes(name)));
  const resumed = await resumePrSet({
    components: p.components,
    plan: p.plan,
    registry: p.registry,
    env: p.env,
    seededOutputs: p.seededOutputs,
    record,
    completed: attempt.completed,
  });
  if (!resumed.ok) return skip(`what is left is not what was approved. ${resumed.reasons.join("; ")}`);
  console.error(formatInfo(`resume  : ${attempt.completed.join(", ")} applied in an earlier attempt; applying ${resumed.plan.order.join(", ") || "nothing more"} under the approval of ${record.digest}`));
  return { plan: resumed.plan, set: resumed.set, approval: approvalOf(check), completed: attempt.completed, outputs };
}
