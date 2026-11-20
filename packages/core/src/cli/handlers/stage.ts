/**
 * `chant stage pause <stage>` and `chant stage resume <stage>` (#5355).
 *
 * The stage is one of the member's pipeline, read at the default branch's
 * tip as `components promote` reads it. Each writes a line on the stage's
 * ledger (`../../pipeline/stage-ledger.ts`) naming who (`--actor`, else the
 * CI or shell user) and why (`--reason`), and pushes it. While a stage is
 * paused, `components promote` into it exits 3 and records the release that
 * waited. A resume names the newest of those, which is the one that enters;
 * the older ones are refused from then on.
 */

import { actorFromEnv } from "../../actor";
import { promoteBase, readPipelineAt } from "../../pipeline/read";
import type { PipelineSpec } from "../../pipeline/spec";
import { gitStageLedgerPort, pauseLine, resumeLine, type StageLedgerPort } from "../../pipeline/stage-ledger";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant stage pause <stage> [--reason <text>] [--actor <name>] | chant stage resume <stage> [--reason <text>] [--actor <name>]";

/** What a pause or resume did: the exit code and the lines it prints. */
export interface StageCommandResult {
  exitCode: number;
  lines: { level: "info" | "success" | "warning" | "error"; text: string }[];
}

/** Pause or resume `stage` of `spec` on `port`. The handler's work, without the reads of git and the environment. */
export async function stageCommand(input: {
  verb: "pause" | "resume";
  spec: PipelineSpec;
  stage: string;
  by: string;
  reason?: string;
  port: StageLedgerPort;
  now: Date;
}): Promise<StageCommandResult> {
  const { spec, stage, verb } = input;
  if (!spec.stages.some((s) => s.name === stage)) {
    return { exitCode: 1, lines: [{ level: "error", text: `the pipeline "${spec.name}" has no stage "${stage}"; its stages are ${spec.stages.map((s) => s.name).join(", ")}` }] };
  }
  const lines = await input.port.read(spec.name, stage);
  const args = { pipeline: spec.name, stage, by: input.by, ...(input.reason ? { reason: input.reason } : {}), lines, now: input.now };
  const line = verb === "pause" ? pauseLine(args) : resumeLine(args);
  if ("refused" in line) return { exitCode: 1, lines: [{ level: "error", text: line.refused }] };
  const pushed = await input.port.append(line);
  const out: StageCommandResult["lines"] = [];
  if (verb === "pause") {
    out.push({ level: "success", text: `paused stage ${stage} of ${spec.name}${input.reason ? ` (${input.reason})` : ""}: a promote into it exits 3 until \`chant stage resume ${stage}\`; one applying now finishes` });
  } else {
    out.push({ level: "success", text: `resumed stage ${stage} of ${spec.name}${input.reason ? ` (${input.reason})` : ""}` });
    if (line.admits) {
      const name = line.admits.label ?? line.admits.digest;
      out.push({ level: "info", text: `release ${name} is the newest that waited, and it enters: chant components promote --to ${stage} --release ${name}` });
      if (line.superseded?.length) out.push({ level: "info", text: `the older releases that waited are refused from now on: ${line.superseded.join(", ")}` });
    } else out.push({ level: "info", text: "no release waited while it was paused" });
  }
  if (!pushed.pushed) out.push({ level: "warning", text: `the ${verb} is recorded locally and did not reach the remote${pushed.pushWarning ? `: ${pushed.pushWarning}` : ""}` });
  return { exitCode: 0, lines: out };
}

async function runStage(ctx: CommandContext, verb: "pause" | "resume"): Promise<number> {
  const stage = ctx.args.extraPositional;
  if (!stage) {
    console.error(formatError({ message: `chant stage ${verb} needs a stage`, hint: USAGE }));
    return 1;
  }
  const by = ctx.args.actor ?? (actorFromEnv(process.env, "") || undefined);
  if (!by) {
    console.error(formatError({ message: "Could not resolve --actor from the environment", hint: "Pass --actor explicitly, or set GITHUB_ACTOR / GITLAB_USER_LOGIN / USER." }));
    return 1;
  }
  const cwd = process.cwd();
  const base = promoteBase(cwd);
  const read = base ? readPipelineAt(base, cwd) : undefined;
  if (!read || read.status === "absent") {
    console.error(formatError({ message: "this member has no .chant/pipeline.ts on its default branch, so it has no stages to pause or resume", hint: USAGE }));
    return 1;
  }
  if (read.status === "refused") {
    console.error(formatError({ message: `the pipeline at ${base!.slice(0, 12)} does not fold: ${read.line}` }));
    return 1;
  }
  const { fetchLifecycle } = await import("../../lifecycle/git");
  await fetchLifecycle().catch(() => false);
  const result = await stageCommand({ verb, spec: read.spec, stage, by, ...(ctx.args.reason ? { reason: ctx.args.reason } : {}), port: gitStageLedgerPort(), now: new Date() });
  for (const l of result.lines) {
    if (l.level === "error") console.error(formatError({ message: l.text, hint: USAGE }));
    else if (l.level === "warning") console.error(formatWarning({ message: l.text }));
    else if (l.level === "success") console.error(formatSuccess(l.text));
    else console.error(formatInfo(l.text));
  }
  return result.exitCode;
}

export const runStagePause = (ctx: CommandContext): Promise<number> => runStage(ctx, "pause");
export const runStageResume = (ctx: CommandContext): Promise<number> => runStage(ctx, "resume");

export async function runStageUnknown(): Promise<number> {
  console.error(formatError({ message: "chant stage takes pause or resume", hint: USAGE }));
  return 1;
}
