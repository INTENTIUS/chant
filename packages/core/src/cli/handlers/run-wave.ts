/**
 * `chant run wave --spec <file> --wave <k>` (#3679): the command each job of
 * a generated Op waves pipeline runs. See `../../op/op-waves-run.ts`.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { notifyOpWave } from "../../op/op-waves-notify";
import { gitShowAtBase, parseOpWavesSpec, recordOpWaveHeadPlans, runOpWave } from "../../op/op-waves-run";
import { activeProductWaveHook } from "../../op/op-waves-after-plan";
import type { OpWavesSpec } from "../../op/op-waves";
import type { OpWaveShowAtBase } from "../../op/op-waves-run";
import { formatError, formatWarning } from "../format";
import { ledgerRecordingOff, NO_RECORD_ENV, noRecordEndNote, noRecordStartNote, resetNoRecordLedger } from "../../lifecycle/no-record";
import type { CommandContext } from "../registry";
import { waveStopLine } from "../../op/wave-stop";
import { OP_WAVE_PHASES, type OpWavePhase } from "../../op/op-waves-split";
import { beforeMergeRunFromEnv } from "../../op/before-merge";
import { CHANT_EXIT } from "../../exit-codes";

/**
 * `chant run wave`, with recording off under `--no-record` or
 * `CHANT_NO_RECORD` (#4551), as `chant run` does (`./run.ts`): the flag sets
 * `CHANT_NO_RECORD` for the length of the job, so the ledger seam and every
 * chant process a hook starts see the same choice, and the job says so
 * before it starts and after it ends. Kept here, not imported from ./run.ts,
 * so the wave-job runtime bundle stays small.
 */
export async function runOpWaveCommand(ctx: CommandContext): Promise<number> {
  const flagged = ctx.args.noRecord === true;
  if (!flagged && !ledgerRecordingOff()) return runOpWaveJobCommand(ctx);
  const source = flagged ? "--no-record" : `${NO_RECORD_ENV}=${process.env[NO_RECORD_ENV]}`;
  const prior = process.env[NO_RECORD_ENV];
  if (flagged) process.env[NO_RECORD_ENV] = "1";
  resetNoRecordLedger();
  console.error(formatWarning({ message: noRecordStartNote(source) }));
  try {
    return await runOpWaveJobCommand(ctx);
  } finally {
    console.error(formatWarning({ message: noRecordEndNote(source) }));
    resetNoRecordLedger();
    if (flagged) {
      if (prior === undefined) delete process.env[NO_RECORD_ENV];
      else process.env[NO_RECORD_ENV] = prior;
    }
  }
}

async function runOpWaveJobCommand(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  // #4984: the job after a before-merge run's last wave merges the pull request, or says it is ready.
  if (args.merge !== undefined) return runBeforeMergeDone(ctx);
  // #4987: the job after a wave posts its apply status, at the default branch's commit.
  if (args.applyStatus !== undefined) return runApplyStatus(ctx);
  const specFile = args.opsSpec;
  if (specFile && args.recordPlans) {
    try {
      const spec = parseOpWavesSpec(readFileSync(resolve(specFile), "utf-8"), `--spec ${specFile}`);
      const plans = await recordOpWaveHeadPlans({ spec });
      if (args.json) console.log(JSON.stringify(plans, null, 2));
      else for (const w of plans.waves) console.error(`wave ${w.wave} (${w.name}) at ${plans.head.slice(0, 12)}: ${w.digest}`);
      return 0;
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
  }
  if (specFile && args.approvalStatus) return runApprovalStatus(ctx, specFile);
  if (specFile && args.wavesOutcome) {
    // #4617: the outcome the control job's dispatch carries, from every wave job's outcome file.
    try {
      const spec = parseOpWavesSpec(readFileSync(resolve(specFile), "utf-8"), `--spec ${specFile}`);
      const { opWaveOutcomeDir } = await import("../../op/op-waves");
      const { earlierWaveOutcomes } = await import("../../wave-blocked");
      const { applyOutcomeOf } = await import("../../control/applied");
      // #4992: a run that started a follow-on is not the last; the follow-on's control job tells the control repo.
      const { readOpWaveRestNote } = await import("../../op/op-waves-follow-on");
      const note = readOpWaveRestNote([resolve(opWaveOutcomeDir(spec))]);
      if (note?.next !== undefined) {
        console.error(`${spec.name}: wave ${note.wave} started a follow-on run for wave ${note.next}, so this run's outcome is not the waves'; that run sends it`);
        return 0;
      }
      const summary = applyOutcomeOf(earlierWaveOutcomes([resolve(opWaveOutcomeDir(spec))], Number.MAX_SAFE_INTEGER).members);
      if (args.json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(summary.outcome);
        const counts = Object.entries(summary.counts).map(([k, n]) => `${n} ${k}`).join(", ");
        console.error(`${spec.name}: ${summary.outcome}${counts ? ` (${counts})` : ", no wave wrote an outcome"}`);
      }
      return 0;
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
  }
  if (!specFile || args.wave === undefined) {
    console.error(formatError({
      message: "`chant run wave` needs --spec <file> and --wave <k>",
      hint: "Run it as a generated Op waves pipeline does: chant run wave --spec <file> --wave <k> [--decide | --share <i> | --group <name> [--share <i>]]",
    }));
    return 1;
  }
  if (args.decide && (args.share !== undefined || args.group !== undefined)) {
    console.error(formatError({ message: `--decide and --${args.share !== undefined ? "share" : "group"} are two different jobs; pass one` }));
    return 1;
  }
  if (args.policyOnly && (args.share !== undefined || args.group !== undefined)) {
    console.error(formatError({ message: `--policy-only runs a wave's policy in its own or its deciding job; a --${args.share !== undefined ? "share" : "group"} job has none of its own` }));
    return 1;
  }
  // #4987: one of a split wave's four jobs before merge.
  const phase = args.phase as OpWavePhase | undefined;
  if (phase !== undefined && !OP_WAVE_PHASES.includes(phase)) {
    console.error(formatError({ message: `--phase is one of ${OP_WAVE_PHASES.join(", ")}: a split wave's plan, gate, apply or record job`, hint: `got ${JSON.stringify(args.phase ?? "")}` }));
    return 1;
  }
  // The gate and record jobs run at the default branch; a before-merge run's applied commit is its decided head.
  const decidedHead = phase === "gate" || phase === "record" ? beforeMergeRunFromEnv().head : undefined;
  let spec: OpWavesSpec | undefined;
  const job = { ...(args.share !== undefined ? { share: args.share } : {}), ...(args.group !== undefined ? { group: args.group } : {}) };
  if (args.eventsJson && args.json) {
    console.error(formatError({ message: "--events-json and --json both print to stdout", hint: "Pass one. --events-json prints the job's run events; --json prints its result." }));
    return 1;
  }
  try {
    const path = resolve(specFile);
    // #4982: --render-spec has the product's command print the spec at base, and reads the rules from it there too.
    let show: OpWaveShowAtBase | undefined;
    if (args.renderSpec) {
      const at = await import("../../op/op-waves-render-spec");
      const file = relative(process.cwd(), path);
      show = at.renderedSpecShow(file, at.commandSpecRender(at.opWavesSpecCommandFromEnv(), file, process.cwd()), gitShowAtBase);
      spec = at.renderOpWavesSpecFile({ specFile: file, base: args.base ?? "HEAD^1", cwd: process.cwd(), show, parse: parseOpWavesSpec }).spec;
      const missing = at.renderedJobMissing(spec, args.wave, job);
      if (missing) {
        console.error(`${missing}, so this job has nothing to apply`);
        return 0;
      }
    } else {
      spec = parseOpWavesSpec(readFileSync(path, "utf-8"), `--spec ${specFile}`);
    }
    // #4979: a comment that ran the apply again through wave n leaves the waves after it waiting, as a gate does.
    // #4987: in a split wave the gate job reads the stop, with the token, at the decided head.
    if (!args.policyOnly && (phase === undefined || phase === "gate")) {
      const stopped = await waveStopLine(spec.name, args.wave, decidedHead ? { sha: decidedHead } : {});
      if (stopped) {
        console.error(stopped);
        return CHANT_EXIT.waiting;
      }
    }
    // #4555: --events-json streams the job's run events, a phase per wave and a step per run target.
    const stream = args.eventsJson
      ? await (await import("../run-events")).openCliRunEvents(args, { kind: "op", name: spec.name, cwd: process.cwd() })
      : undefined;
    // #4614: a product running chant in process hands its after-plan hooks and capabilities.
    const product = activeProductWaveHook();
    const result = await runOpWave({
      ...(stream ? { events: stream.emit } : {}),
      ...(product?.afterPlan ? { afterPlan: product.afterPlan } : {}),
      ...(product?.capabilities ? { capabilities: product.capabilities } : {}),
      ...(product?.hookExec ? { hookExec: product.hookExec } : {}),
      ...(product?.runHooks ? { runHooks: product.runHooks } : {}),
      // #4994: the spec's hooks the product serves in this process, in whichever job of a split wave runs them.
      ...(product?.hooks ? { inProcessHooks: product.hooks } : {}),
      spec,
      specFile: relative(process.cwd(), path),
      wave: args.wave,
      ...(args.decide ? { decide: true } : {}),
      ...(args.policyOnly ? { policyOnly: true } : {}),
      ...(args.share !== undefined ? { share: args.share } : {}),
      ...(args.group !== undefined ? { group: args.group } : {}),
      ...(args.base ? { base: args.base } : {}),
      ...(show ? { show } : {}),
      ...(phase ? { phase } : {}),
      ...(decidedHead ? { head: decidedHead } : {}),
    });
    // #4992: the rest wave's record job starts the follow-on run for the next wave its plan found.
    if (phase === "record") result.exitCode = await (await import("../../op/op-waves-follow-on")).followOnAfterRecord({ spec, wave: args.wave, exitCode: result.exitCode });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    // #4926: the policy step applied nothing; the wave's own step tells people how it went.
    if (args.policyOnly) return result.exitCode;
    // #4987: the plan and apply jobs run the change's code and hold no token; the gate job tells people when the wave stops
    // there, and the record job how it applied.
    if (phase === "plan" || phase === "apply" || (phase === "gate" && result.exitCode === CHANT_EXIT.done)) return result.exitCode;
    // #3761: tell people, when the spec says where. Delivery never changes the exit code.
    await notifyOpWave(spec, args.wave, { result }, job);
    // #4629: a refused wave's diff and a failed apply's triage, on the pull request or a tracking issue.
    await respondWave(spec, args.wave, { result });
    return result.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(formatError({ message }));
    if (spec && phase !== "plan" && phase !== "apply") {
      await notifyOpWave(spec, args.wave, { error: message }, job);
      await respondWave(spec, args.wave, { error: message });
    }
    return 1;
  }
}

/**
 * `chant run wave --op <op> --wave <last> --merge auto|manual --forge <kind>
 * [--gate <name>] [--merge-token-env <VAR>]` (#4984): the job after a
 * before-merge run's last wave (`../../op/before-merge-done.ts`). A push run
 * names no decided head, and the job does nothing.
 */
async function runBeforeMergeDone(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const fail = (message: string): number => {
    console.error(formatError({ message }));
    return 1;
  };
  if (args.merge !== "auto" && args.merge !== "manual") return fail("--merge is auto or manual: auto merges the pull request once every wave applied its decided head, manual says it is ready");
  const op = args.op;
  if (!op || args.wave === undefined) return fail("--merge closes a before-merge run: --op <name> --wave <last wave> --merge auto|manual --forge <kind>");
  const { FORGE_KINDS } = await import("../../pr-forge");
  if (!args.forge || !(FORGE_KINDS as readonly string[]).includes(args.forge)) return fail(`--merge replies on the pull request: --forge ${FORGE_KINDS.join("|")}`);
  const kind = args.forge as (typeof FORGE_KINDS)[number];
  const { beforeMergeRunFromEnv, isBeforeMergeRun } = await import("../../op/before-merge");
  const run = beforeMergeRunFromEnv();
  if (!isBeforeMergeRun(run)) {
    console.error("this run names no decided head: a push applies on its own, so nothing is merged here");
    return 0;
  }
  try {
    const { beforeMergeRecordAt } = await import("../../op/before-merge-store");
    const { beforeMergeDone } = await import("../../op/before-merge-done");
    const { opWaveOutcomeDir } = await import("../../op/op-waves");
    const { earlierWaveOutcomes } = await import("../../wave-blocked");
    const { applyOutcomeOf } = await import("../../control/applied");
    const { forgeFromJobEnv } = await import("../../pr-forge-job");
    const { mergeTokenEnv } = await import("../../pr-merge");
    const { releaseTargetLocks } = await import("../../lifecycle/target-lock");
    const { PR_APPLY_GATE } = await import("../../pr-loop");
    const { activeProductWords } = await import("../../ci-product-words");
    const record = run.head ? await beforeMergeRecordAt(op, run.head) : undefined;
    const outcome = applyOutcomeOf(earlierWaveOutcomes([resolve(opWaveOutcomeDir({ name: op }))], Number.MAX_SAFE_INTEGER).members);
    // #4992: a run whose rest wave started a follow-on leaves the merge to that run.
    const { readOpWaveRestNote } = await import("../../op/op-waves-follow-on");
    const note = readOpWaveRestNote([resolve(opWaveOutcomeDir({ name: op }))]);
    let merger;
    if (args.merge === "auto" && args.mergeTokenEnv) {
      const env = mergeTokenEnv(args.mergeTokenEnv);
      if ("error" in env) return fail(String(env.error));
      merger = forgeFromJobEnv(kind, env);
    }
    const gate = args.gate ?? PR_APPLY_GATE;
    const done = await beforeMergeDone({
      op,
      waves: args.wave,
      run,
      record,
      outcome,
      ...(note?.next !== undefined ? { followOn: { wave: note.wave, next: note.next, found: note.found } } : {}),
      merge: args.merge,
      forge: forgeFromJobEnv(kind),
      ...(merger ? { merger } : {}),
      release: async (pr) => (await releaseTargetLocks(gate, pr)).released,
      words: activeProductWords(),
    });
    console.error(done.text);
    return done.code;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `chant run wave --op <op> --wave <n> --of <count> --apply-status <context>
 * --at <sha> --forge <kind>` (#4987): the job after wave n posts its apply
 * status on the commit the waves applied, from every outcome file the job
 * downloaded (`../../op/apply-status.ts`). It runs at the default branch's
 * commit and none of the change's code. A refused post fails the job.
 */
async function runApplyStatus(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const fail = (message: string): number => {
    console.error(formatError({ message }));
    return 1;
  };
  const op = args.op;
  if (!op || args.wave === undefined || args.of === undefined || !args.at) return fail("--apply-status posts one wave's apply status: --op <name> --wave <n> --of <count> --apply-status <context> --at <sha> --forge <kind>");
  const { FORGE_KINDS } = await import("../../pr-forge");
  if (!args.forge || !(FORGE_KINDS as readonly string[]).includes(args.forge)) return fail(`--apply-status posts on a forge: --forge ${FORGE_KINDS.join("|")}`);
  const kind = args.forge as (typeof FORGE_KINDS)[number];
  try {
    const { postOpWaveApplyStatus } = await import("../../op/apply-status");
    const { opWaveOutcomeDir } = await import("../../op/op-waves");
    const { forgeFromJobEnv } = await import("../../pr-forge-job");
    const pipeline = kind === "gitlab" && args.at === process.env.CI_COMMIT_SHA && /^[0-9]+$/.test(process.env.CI_PIPELINE_ID ?? "") ? Number(process.env.CI_PIPELINE_ID) : undefined;
    const line = await postOpWaveApplyStatus({
      forge: forgeFromJobEnv(kind),
      dirs: [resolve(opWaveOutcomeDir({ name: op }))],
      wave: args.wave,
      of: args.of,
      context: args.applyStatus!,
      at: args.at,
      ...(pipeline !== undefined ? { pipelineId: pipeline } : {}),
    });
    console.error(line);
    return 0;
  } catch (err) {
    return fail(`the apply status was not posted: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The wave job's responses (#4629), through the forge the job's variables
 * name. A job with no forge token posts nothing. Never throws.
 */
async function respondWave(spec: OpWavesSpec, k: number, outcome: import("../../op/op-waves-notify").OpWaveOutcome): Promise<void> {
  try {
    const { respondOpWave, triageOfOpWave } = await import("../../ci-respond-run");
    const { resolveResponses } = await import("../../ci-respond");
    const responses = resolveResponses(spec.respond);
    if (responses["wave-refused"] === "off" && responses["apply-failed"] === "off") return;
    if (outcome.result && outcome.result.exitCode === 0 && !triageOfOpWave(spec, k, outcome)) return;
    const { detectForge, forgeFromEnv } = await import("../../pr-forge");
    const kind = detectForge();
    if (!kind) return;
    let forge;
    try {
      forge = forgeFromEnv(kind);
    } catch {
      return;
    }
    const head = process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA;
    await respondOpWave(spec, k, outcome, { forge, ...(head ? { head } : {}) });
  } catch (err) {
    console.error(formatWarning({ message: `the wave's responses were not posted: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

/**
 * `chant run wave --spec <file> --approval-status` (#4630): post
 * `<product>/approval` on an open pull request's head, from its recorded
 * plans and its reviews, or for a `pull-request` wave the pull request's
 * own approval on the ledger. `--pr`, `--head` and `--base` name one pull
 * request (GitHub and Forgejo); `--open` posts on every open one into
 * `--branch` (GitLab's scheduled pipeline, or any forge by hand). It exits 0 once it posted, and
 * 1 when it could not.
 */
async function runApprovalStatus(ctx: CommandContext, specFile: string): Promise<number> {
  const { args } = ctx;
  const fail = (message: string): number => {
    console.error(formatError({ message }));
    return 1;
  };
  const { FORGE_KINDS, forgeFromEnv } = await import("../../pr-forge");
  if (!args.forge || !(FORGE_KINDS as readonly string[]).includes(args.forge)) return fail(`--approval-status posts on a forge: --forge ${FORGE_KINDS.join("|")}`);
  let spec: OpWavesSpec;
  let forge;
  try {
    spec = parseOpWavesSpec(readFileSync(resolve(specFile), "utf-8"), `--spec ${specFile}`);
    forge = forgeFromEnv(args.forge as (typeof FORGE_KINDS)[number]);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const { postApprovalStatus, postOpenApprovalStatuses } = await import("../../op/approval-status");
  const file = relative(process.cwd(), resolve(specFile));
  try {
    if (args.open) {
      const branch = args.branch ?? process.env.CI_COMMIT_BRANCH;
      if (!branch) return fail("--approval-status --open posts for the pull requests into a branch: run it in a branch pipeline, or pass --branch <branch>");
      const done = await postOpenApprovalStatuses({ spec, specFile: file, forge, branch });
      for (const w of done.warnings) console.error(formatWarning({ message: w }));
      for (const p of done.posted) console.error(`!${p.pr}: ${p.status.state}: ${p.status.description}`);
      return done.warnings.length > 0 && done.posted.length === 0 ? 1 : 0;
    }
    if (args.pr === undefined || !args.head || !args.base) return fail("--approval-status needs the pull request, its head and its base: --pr <n> --head <sha> --base <sha>, or --open");
    const status = await postApprovalStatus({ spec, specFile: file, forge, pr: args.pr, head: args.head, base: args.base });
    console.error(`#${args.pr}: ${status.state}: ${status.description}`);
    return 0;
  } catch (err) {
    return fail(`the approval status was not posted: ${err instanceof Error ? err.message : String(err)}`);
  }
}
