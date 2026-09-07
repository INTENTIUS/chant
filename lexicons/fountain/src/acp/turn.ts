/**
 * One ACP turn: a chant command line in, `session/update` notifications out,
 * a stop reason back (#2125).
 *
 * The interesting half is the mapping from an Op to tool calls. An Op's
 * *declaration* is the plan — every phase's steps, in order, known before the
 * first one runs — so the turn emits one `tool_call` per declared step up
 * front, `pending`, and then a `tool_call_update` as each record settles. A
 * client renders the plan immediately and fills it in, instead of watching
 * calls appear one at a time with no idea how many are coming.
 *
 * The executor reports a settled step by phase name and function name, not by
 * position, so records are matched back to declarations through a queue per
 * `<phase>/<fn>` pair — two steps calling the same activity in one phase
 * settle onto the first and second declaration in order. A record with no
 * declaration left to match (an `onFailure` phase, which is not part of the
 * plan because it only runs when the plan fails) opens its own tool call and
 * closes it in the same breath.
 */

import type { OpConfig, StepDefinition } from "@intentius/chant/op/types";
import type { StepRecord } from "@intentius/chant/op/local-executor";
import type { OpRunStatus } from "@intentius/chant/op/runtime";
import type { PendingGateRecord } from "@intentius/chant/lifecycle/gate-ledger";
import { approveCommand } from "@intentius/chant/op/gate";
import { gateName } from "@intentius/chant/op/gate-name";
import type { ChantCommand } from "./command-line";
import type { ChantHost } from "./host";
import type { PermissionOption, StopReason, ToolCallStatus } from "./protocol";
import { withCapturedOutput } from "./output";

/** Where a turn puts everything a client sees. */
export interface TurnSink {
  message(text: string): void;
  toolCall(id: string, title: string, rawInput: Record<string, unknown>): void;
  toolCallUpdate(
    id: string,
    status: ToolCallStatus,
    detail?: { text?: string; rawOutput?: Record<string, unknown> },
  ): void;
  /** Ask the client to decide a gate. Only reached under `--durable-requests`. */
  requestPermission(
    toolCallId: string,
    title: string,
    options: PermissionOption[],
    meta: Record<string, unknown>,
  ): Promise<void>;
}

/** A gate this turn stopped on and asked the client about, kept for the resume prompt. */
export interface PendingPermission {
  requestId: string;
  op: string;
  gate: string;
  /** The command line to re-run once the gate is resolved. */
  prompt: string;
}

/** What a turn hands back to the server. */
export interface TurnOutcome {
  stopReason: StopReason;
  /** Set when the turn ended on a gate it asked the client about. */
  permission?: PendingPermission;
}

/** The permission options a gate offers, and the ids the resume prompt names. */
export const ALLOW_OPTION = "allow";
export const REJECT_OPTION = "reject";

function gateOptions(gate: string): PermissionOption[] {
  return [
    { optionId: ALLOW_OPTION, name: `Approve "${gate}"`, kind: "allow_once" },
    { optionId: REJECT_OPTION, name: `Reject "${gate}"`, kind: "reject_once" },
  ];
}

/** Every step an Op declares, flattened in execution order with the phase it belongs to. */
function declaredSteps(config: OpConfig): Array<{ phase: string; fn: string; args: Record<string, unknown> }> {
  const out: Array<{ phase: string; fn: string; args: Record<string, unknown> }> = [];
  const push = (phase: string, step: StepDefinition): void => {
    if (step.kind === "activity") out.push({ phase, fn: step.fn, args: step.args ?? {} });
    else if (step.kind === "gate") out.push({ phase, fn: `gate:${gateName(step)}`, args: {} });
    else {
      out.push({ phase, fn: `effect:${step.receipt.name}`, args: {} });
      for (const nested of step.steps) push(phase, nested);
    }
  };
  for (const phase of config.phases) for (const step of phase.steps) push(phase.name, step);
  return out;
}

const RECORD_STATUS: Record<StepRecord["status"], ToolCallStatus> = {
  ok: "completed",
  fail: "failed",
  skipped: "completed",
};

/** Everything one turn needs. */
export interface TurnOptions {
  host: ChantHost;
  command: ChantCommand;
  /** The prompt verbatim, kept so a durable-request resume can re-run it. */
  promptText: string;
  sink: TurnSink;
  signal: AbortSignal;
  durableRequests: boolean;
  /** Mints the id a resume prompt names. Injected so a test can pin it. */
  newRequestId: () => string;
}

/**
 * Run one prompt.
 *
 * `signal` is the session's cancel channel: `session/cancel` aborts it, the
 * executor's own abort path stops the in-flight activity and runs the Op's
 * `onFailure` phases, and this reports `cancelled` rather than `end_turn` for
 * the failure that abort produced.
 */
export async function runTurn(opts: TurnOptions): Promise<TurnOutcome> {
  const { host, command, sink } = opts;

  // Core reads a project from `process.cwd()`, and a session names its own
  // working directory — so the turn moves there and moves back. Process-wide,
  // which is the other half of why turns are serialized (../acp/server.ts).
  const previousCwd = process.cwd();
  try {
    if (host.cwd && host.cwd !== previousCwd) process.chdir(host.cwd);
  } catch {
    sink.message(`the session's cwd "${host.cwd}" is not a directory this agent can enter\n`);
    return { stopReason: "refusal" };
  }

  try {
    return await withCapturedOutput(
      (text) => sink.message(text),
      async () =>
        command.kind === "op-run" ? runOpTurn(opts, command) : runVerbTurn(opts, command),
    );
  } catch (err) {
    // Anything a command throws is this turn's outcome, never the JSON-RPC
    // call's. A client that gets an error response for `session/prompt` has
    // been told the *protocol* failed; what actually happened — "Not in a git
    // repository", say — belongs in the reply, where a person reads it.
    sink.message(`${err instanceof Error ? err.message : String(err)}\n`);
    return { stopReason: opts.signal.aborted ? "cancelled" : "refusal" };
  } finally {
    try {
      process.chdir(previousCwd);
    } catch {
      // The directory the process started in is gone. Nothing useful to say
      // on a channel that carries the protocol.
    }
  }
}

async function runOpTurn(
  opts: TurnOptions,
  command: Extract<ChantCommand, { kind: "op-run" }>,
): Promise<TurnOutcome> {
  const { host, sink, signal } = opts;

  const { config, names, errors } = await host.findOp(command.op);
  // An Op file that would not import reads as "no such Op" unless the scan's
  // own complaint is carried through — the same warning `chant run` prints.
  for (const err of errors) sink.message(`warning: ${err}\n`);
  if (!config) {
    sink.message(
      `Op "${command.op}" is not declared in this project.\n` +
        (names.length > 0 ? `Declared: ${names.join(", ")}\n` : "No *.op.ts files were found.\n"),
    );
    return { stopReason: "refusal" };
  }

  // The plan, before anything runs.
  const declared = declaredSteps(config);
  const queues = new Map<string, string[]>();
  let n = 0;
  for (const step of declared) {
    const id = `step-${++n}`;
    sink.toolCall(id, `${step.phase} / ${step.fn}`, step.args);
    const key = `${step.phase}\0${step.fn}`;
    const queue = queues.get(key);
    if (queue) queue.push(id);
    else queues.set(key, [id]);
  }

  const settle = (record: StepRecord): void => {
    const key = `${record.phase}\0${record.fn}`;
    let id = queues.get(key)?.shift();
    if (!id) {
      // An `onFailure` step, or anything else outside the declared plan.
      id = `step-${++n}`;
      sink.toolCall(id, `${record.phase} / ${record.fn}`, record.args ?? {});
    }
    // ACP has four tool-call statuses and none of them is "skipped", so a
    // step the run never reached settles `completed` with the word in its
    // content — a client that renders a green tick and nothing else would be
    // claiming the step ran.
    const detail = record.error ?? (record.status === "skipped" ? "skipped" : undefined);
    sink.toolCallUpdate(id, RECORD_STATUS[record.status], {
      ...(detail ? { text: detail } : {}),
      rawOutput: {
        status: record.status,
        durationMs: record.durationMs,
        ...(record.outcome ? { outcome: record.outcome } : {}),
        ...(record.approval ? { approval: record.approval } : {}),
      },
    });
  };

  let status: OpRunStatus;
  try {
    const handle = await host.startOp(config, {
      ...(command.args.env ? { env: command.args.env } : {}),
      progress: settle,
      signal,
    });
    status = await handle.result();
  } catch (err) {
    sink.message(`${err instanceof Error ? err.message : String(err)}\n`);
    return { stopReason: signal.aborted ? "cancelled" : "end_turn" };
  }

  // Anything the plan declared that never settled — the run stopped before
  // reaching it. Left `pending` a client renders a spinner forever.
  for (const [, queue] of queues) {
    for (const id of queue) sink.toolCallUpdate(id, "completed", { text: "not reached" });
  }

  if (signal.aborted) {
    sink.message(JSON.stringify(status.result?.record ?? status, null, 2) + "\n");
    return { stopReason: "cancelled" };
  }

  if (status.state === "gated" && status.gate) {
    return gatedReply(opts, command, status);
  }

  sink.message(JSON.stringify(status.result?.record ?? status, null, 2) + "\n");
  return { stopReason: "end_turn" };
}

/**
 * A gated run's reply.
 *
 * By default the turn ends and says how to clear the gate — the fact is on
 * chant's ledger, `chant approve` writes the resolution, and the next run
 * observes it (#2119). There is nothing to wait for and nothing to resume.
 *
 * With `--durable-requests` the same gate is also carried to the client as a
 * `session/request_permission`, and the turn reports `waiting` rather than
 * pretending it finished. That request outlives the turn, which no client can
 * do until BinaryBourbon/fountain#1635 ships — hence the flag, and hence its
 * default.
 */
async function gatedReply(
  opts: TurnOptions,
  command: Extract<ChantCommand, { kind: "op-run" }>,
  status: OpRunStatus,
): Promise<TurnOutcome> {
  const { sink, durableRequests } = opts;
  const gate = status.gate as { name: string; since: string };
  const pending: PendingGateRecord | undefined = status.result?.gate;

  sink.message(
    `Op "${command.op}" is waiting on gate "${gate.name}", pending since ${gate.since}` +
      (pending?.expiresAt ? ` and expiring ${pending.expiresAt}` : "") +
      `.\nApprove with: ${approveCommand(command.op, gate.name)}\n`,
  );
  sink.message(JSON.stringify(status.result?.record ?? status, null, 2) + "\n");

  if (!durableRequests) return { stopReason: "end_turn" };

  const requestId = opts.newRequestId();
  await sink.requestPermission(
    requestId,
    `Gate "${gate.name}" on Op "${command.op}"`,
    gateOptions(gate.name),
    { chant: { requestId, op: command.op, gate: gate.name } },
  );
  return {
    stopReason: "waiting",
    permission: { requestId, op: command.op, gate: gate.name, prompt: opts.promptText },
  };
}

async function runVerbTurn(
  opts: TurnOptions,
  command: Extract<ChantCommand, { kind: "verb" }>,
): Promise<TurnOutcome> {
  const { host, sink, signal } = opts;

  const id = "cmd-1";
  sink.toolCall(id, `chant ${command.argv.join(" ")}`, { argv: command.argv });

  // The reply is the verb's `--json` output, so ask for it when the prompt
  // did not. A verb with no JSON mode prints what it always prints.
  if (command.args.json === undefined) command.args.json = true;

  let exitCode: number;
  try {
    exitCode = await host.runVerb(command, signal);
  } catch (err) {
    sink.toolCallUpdate(id, "failed", { text: err instanceof Error ? err.message : String(err) });
    sink.message(`${err instanceof Error ? err.message : String(err)}\n`);
    return { stopReason: signal.aborted ? "cancelled" : "end_turn" };
  }

  sink.toolCallUpdate(id, exitCode === 0 ? "completed" : "failed", { rawOutput: { exitCode } });
  if (exitCode !== 0) sink.message(`\nchant ${command.argv.join(" ")} exited ${exitCode}\n`);
  return { stopReason: signal.aborted ? "cancelled" : "end_turn" };
}
