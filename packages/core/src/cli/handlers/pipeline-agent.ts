/**
 * `chant pipeline agent` (#5358): a stage's agent steps. See
 * ../../pipeline/agent-steps.ts.
 *
 *   pipeline agent run --stage <stage> --release <label|digest> [--output <dir>]
 *       run the stage's agent steps for the release, in order, and write each
 *       step's record to <dir>/<step>.json (default .chant/agent-steps/<stage>).
 *       Reads the ledger and writes nothing to it: the job it runs in holds a
 *       read token only. Exits 1 when a step failed, naming why.
 *   pipeline agent record --stage <stage> --release <label|digest> [--from <dir>]
 *       check each record against the pipeline at base, record it on
 *       <stage>/agent-answers.jsonl with a run record per model run, and push.
 *       Exits 1 when a step failed or a record is refused.
 *   pipeline agent answer --stage <stage> --release <label|digest> [--name <step>] [--json]
 *       print the stage's answers for the release, or one step's answer.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandContext } from "../registry";
import { formatError, formatInfo, formatWarning } from "../format";
import type { PipelineSpec } from "../../pipeline/spec";
import type { AgentPolicyVerdict } from "../../pipeline/promote";
import type { PolicyAgentAnswer, StageAgentAnswerRecord } from "../../pipeline/agent-steps";

const USAGE =
  "chant pipeline agent run --stage <stage> --release <label|digest> [--output <dir>] | chant pipeline agent record --stage <stage> --release <label|digest> [--from <dir>] | chant pipeline agent answer --stage <stage> --release <label|digest> [--name <step>] [--json]";

/** Where `run` writes a stage's records and `record` reads them, unless named. */
export const AGENT_STEPS_DIR = ".chant/agent-steps";

/** The pipeline on the default branch, or why there is none to read. */
async function pipelineAtBase(cwd: string): Promise<PipelineSpec | string> {
  const { promoteBase, readPipelineAt, readMemberPipeline } = await import("../../pipeline/read");
  const base = promoteBase(cwd);
  const read = base ? readPipelineAt(base, cwd) : readMemberPipeline(cwd);
  if (read.status === "absent") return "this member has no pipeline";
  if (read.status === "refused") return `the pipeline does not fold: ${read.line}`;
  return read.spec;
}

/** The release named, by label or digest. */
async function releaseNamed(ref: string, cwd: string): Promise<{ digest: string; label: string | null; commit: string } | undefined> {
  const { resolveRelease } = await import("../../lifecycle/release-store");
  const found = await resolveRelease(ref, { cwd });
  return found ? { digest: found.release.releaseDigest, label: found.label, commit: found.release.commit } : undefined;
}

/** The stage, the pipeline at base and the release every verb starts from, or the exit code. */
async function start(ctx: CommandContext): Promise<{ cwd: string; stage: string; spec: PipelineSpec; release: { digest: string; label: string | null; commit: string } } | number> {
  const { args } = ctx;
  const stage = args.lockStage;
  if (!stage || !args.release) {
    console.error(formatError({ message: "--stage <stage> and --release <label|digest> are required: an agent step answers for the release its stage takes", hint: USAGE }));
    return 1;
  }
  const cwd = resolve(".");
  const { fetchLifecycle } = await import("../../lifecycle/git");
  await fetchLifecycle({ cwd }).catch(() => false);
  const spec = await pipelineAtBase(cwd);
  if (typeof spec === "string") {
    console.error(formatError({ message: spec, hint: USAGE }));
    return 1;
  }
  if (!spec.stages.some((s) => s.name === stage)) {
    console.error(formatError({ message: `the pipeline "${spec.name}" has no stage "${stage}"` }));
    return 1;
  }
  const release = await releaseNamed(args.release, cwd);
  if (!release) {
    console.error(formatError({ message: `no release is labelled or digested ${args.release}` }));
    return 1;
  }
  return { cwd, stage, spec, release };
}

export async function runPipelineAgent(ctx: CommandContext): Promise<number> {
  const verb = ctx.args.extraPositional;
  if (verb === "run") return runSteps(ctx);
  if (verb === "record") return recordSteps(ctx);
  if (verb === "answer") return printAnswers(ctx);
  console.error(formatError({ message: "chant pipeline agent takes run, record or answer", hint: USAGE }));
  return 1;
}

async function runSteps(ctx: CommandContext): Promise<number> {
  const at = await start(ctx);
  if (typeof at === "number") return at;
  const { cwd, stage, spec, release } = at;
  const { runStageAgentSteps, stageAgentSteps } = await import("../../pipeline/agent-steps");
  if (stageAgentSteps(spec, stage).length === 0) {
    console.error(formatInfo(`stage "${stage}" has no agent steps`));
    return 0;
  }
  const { gitStageArtifactPort } = await import("../../pipeline/artifacts");
  const { AGENT_OUTPUT_FILE, AGENT_USAGE_FILE, digestOf, overLimit, readAgentUsage } = await import("../../ci-agent");
  const { WAVE_SUMMARY_COMMAND } = await import("../../ci-respond-summary");
  const { quoted, reviewCommandEnv, runReviewCommand } = await import("../../op/activities/review-agent");
  const env = process.env;
  const records = await runStageAgentSteps({
    spec,
    stage,
    release: { digest: release.digest, label: release.label, gitSha: release.commit },
    defaultCommand: WAVE_SUMMARY_COMMAND,
    artifacts: gitStageArtifactPort({ cwd }),
    readRuns: async (s) => {
      const { readRunLedger } = await import("../../lifecycle/run-ledger");
      return (await readRunLedger(s.env, s.name, { cwd })).records;
    },
    hasKey: (k) => Boolean(env[k]),
    quote: quoted,
    overLimit: (s, r, now) => overLimit(s, r, now),
    digestOf,
    // The model's environment is built from scratch: its key and the process basics, never a forge token.
    model: async ({ settings, prompt }) => {
      const dir = mkdtempSync(join(tmpdir(), "chant-agent-step-"));
      const commandEnv = { ...reviewCommandEnv(env, settings.keyEnv), CHANT_AGENT_USAGE: join(dir, AGENT_USAGE_FILE) };
      let got: { stdout: string; exitCode: number | null };
      try {
        got = await runReviewCommand(settings.command, prompt, commandEnv, settings.timeout * 60_000);
      } catch {
        got = { stdout: "", exitCode: null };
      }
      try {
        writeFileSync(join(dir, AGENT_OUTPUT_FILE), got.stdout.slice(0, 8 << 20));
      } catch {
        /* the usage is read from the output when it can be */
      }
      return { ...got, usage: readAgentUsage(dir) };
    },
  });
  const outDir = resolve(ctx.args.output ?? join(AGENT_STEPS_DIR, stage));
  mkdirSync(outDir, { recursive: true });
  let failed = 0;
  for (const r of records) {
    writeFileSync(join(outDir, `${r.step}.json`), JSON.stringify(r, null, 2) + "\n");
    if (r.status === "answered") console.error(formatInfo(`agent step ${r.step}: answered${r.usage?.usd !== undefined ? ` (${r.usage.usd.toFixed(2)} USD)` : ""}`));
    else {
      failed++;
      console.error(formatError({ message: `agent step ${r.step} failed: ${r.reason}` }));
    }
  }
  console.error(formatInfo(`wrote ${records.length} record${records.length === 1 ? "" : "s"} to ${outDir}; \`chant pipeline agent record\` records them`));
  return failed > 0 ? 1 : 0;
}

async function recordSteps(ctx: CommandContext): Promise<number> {
  const at = await start(ctx);
  if (typeof at === "number") return at;
  const { cwd, stage, spec, release } = at;
  const { checkedAgentAnswer, gitStageAgentAnswerPort, stageAgentSteps, agentStepSettings, AGENT_STEP_TRIGGER } = await import("../../pipeline/agent-steps");
  const steps = stageAgentSteps(spec, stage);
  if (steps.length === 0) {
    console.error(formatInfo(`stage "${stage}" has no agent steps`));
    return 0;
  }
  const dir = resolve(ctx.args.migrateFrom ?? join(AGENT_STEPS_DIR, stage));
  const port = gitStageAgentAnswerPort({ cwd });
  const { agentRunRecordInput } = await import("../../ci-agent");
  const { WAVE_SUMMARY_COMMAND } = await import("../../ci-respond-summary");
  const { appendRunRecord } = await import("../../lifecycle/run-ledger");
  const { resolveCiRun } = await import("../../lifecycle/release-ledger");
  const ci = resolveCiRun(process.env);
  let failed = 0;
  for (const [name, declared] of steps) {
    const file = join(dir, `${name}.json`);
    let raw: unknown;
    try {
      raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    } catch {
      raw = undefined;
    }
    if (raw === undefined) {
      failed++;
      console.error(formatError({ message: `agent step ${name} wrote no record to ${file}, so nothing is recorded for it and the stage holds` }));
      continue;
    }
    const checked = checkedAgentAnswer(spec, stage, release.digest, raw);
    if ("refused" in checked) {
      failed++;
      console.error(formatError({ message: `agent step ${name}'s record is refused: ${checked.refused}` }));
      continue;
    }
    await port.append(stage, checked);
    // One run record per model run, which the step's limits count, as every agent's do.
    if (checked.promptDigest && checked.started && checked.ended) {
      const s = agentStepSettings(spec, stage, name, declared, WAVE_SUMMARY_COMMAND);
      await appendRunRecord(
        agentRunRecordInput({
          settings: { name: s.name, env: s.env, on: AGENT_STEP_TRIGGER },
          started: checked.started,
          ended: checked.ended,
          result: checked.status === "answered" ? "answered" : "failed",
          reason: checked.status === "answered" ? `answered for ${release.label ?? release.digest}` : (checked.reason ?? "failed"),
          promptDigest: checked.promptDigest,
          ...(checked.usage ? { usage: checked.usage } : {}),
          gitSha: release.commit,
          ...(ci ? { runOrigin: ci.runOrigin } : {}),
        }),
        { cwd },
      );
    }
    if (checked.status === "answered") console.error(formatInfo(`agent step ${name}: recorded its answer for release ${release.label ?? release.digest}`));
    else {
      failed++;
      console.error(formatError({ message: `agent step ${name} failed for release ${release.label ?? release.digest}: ${checked.reason}` }));
    }
  }
  const { pushLifecycleRebasing } = await import("../../lifecycle/git");
  const pushed = await pushLifecycleRebasing({ cwd }).catch((err: unknown) => ({ pushed: false, pushWarning: err instanceof Error ? err.message : String(err) }));
  if (!pushed.pushed && pushed.pushWarning) console.error(formatWarning({ message: pushed.pushWarning }));
  return failed > 0 ? 1 : 0;
}

async function printAnswers(ctx: CommandContext): Promise<number> {
  const at = await start(ctx);
  if (typeof at === "number") return at;
  const { cwd, stage, release } = at;
  const { gitStageAgentAnswerPort, readStageAgentAnswers } = await import("../../pipeline/agent-steps");
  const answers = await readStageAgentAnswers(gitStageAgentAnswerPort({ cwd }), { stage, release: release.digest });
  if (ctx.args.selectName) {
    const r = answers[ctx.args.selectName];
    if (!r || r.status !== "answered") {
      console.error(formatError({ message: `agent step ${ctx.args.selectName} of stage "${stage}" has no answer for release ${release.label ?? release.digest}${r?.reason ? `: ${r.reason}` : ""}` }));
      return 1;
    }
    console.log(ctx.args.json ? JSON.stringify(r, null, 2) : JSON.stringify(r.answer));
    return 0;
  }
  if (ctx.args.json) console.log(JSON.stringify(answers, null, 2));
  else for (const r of Object.values(answers) as StageAgentAnswerRecord[]) console.log(`${r.step}: ${r.status === "answered" ? JSON.stringify(r.answer) : `failed, ${r.reason}`}`);
  return 0;
}

/**
 * The stage gate's policy over agent answers, for the promote (#5358): the
 * workspace's `ci.policy` at base, with the answers as `input.agent` and no
 * change set, since a promote is gated before it plans. Undefined when no
 * policy is named at base.
 */
export async function stageAgentPolicy(cwd: string, spec: PipelineSpec, stage: string, agent: Record<string, PolicyAgentAnswer>): Promise<AgentPolicyVerdict> {
  const { promoteBase } = await import("../../pipeline/read");
  const { prLoopPolicyAt, preparePrPolicyEngine, runPrPolicy } = await import("../../components/pr-policy");
  const { composeChangeSet } = await import("../../change-set");
  const { getHeadCommit } = await import("../../lifecycle/git");
  const base = promoteBase(cwd);
  if (!base) return { result: "error", reasons: ["the default branch cannot be read, so the stage's policy cannot be read at base"] };
  const head = (await getHeadCommit({ cwd }).catch(() => "")) || base;
  const read = await preparePrPolicyEngine(prLoopPolicyAt(cwd, base));
  const verdict = runPrPolicy(read, { version: 1, stage: "apply", op: spec.name, gate: stage, env: stage, pr: null, base, head, changeSet: composeChangeSet([]), agent });
  if (!verdict) return undefined;
  const reasons = verdict.result === "error" ? [verdict.error ?? "the policy did not run"] : [...verdict.denials, ...verdict.holds].map((f) => f.message).filter(Boolean);
  return { result: verdict.result, reasons };
}
