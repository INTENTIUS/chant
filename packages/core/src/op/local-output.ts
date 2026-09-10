/**
 * Renderers for local Op execution. Both consume the same `OpRunResult`:
 * `renderHuman` is the default (logs to stderr), `renderJson` prints the
 * machine-readable record array to stdout and nothing else.
 */

import type { OpRunResult, StepRecord } from "./local-executor";
import { approveCommand } from "./gate";

type Writer = (line: string) => void;

const stderr: Writer = (line) => process.stderr.write(line + "\n");
const stdout: Writer = (line) => process.stdout.write(line + "\n");

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Render a run result as human-readable progress. Defaults to stderr so stdout
 * stays clean for piping (the `--json` renderer owns stdout).
 */
export function renderHuman(result: OpRunResult, write: Writer = stderr): void {
  let currentPhase: string | undefined;
  for (const record of result.records) {
    if (record.phase !== currentPhase) {
      currentPhase = record.phase;
      write(`[phase] ${currentPhase}`);
    }
    const mark = record.status === "ok" ? "✓" : record.status === "fail" ? "✗" : "•";
    const call = `${record.fn}(${formatArgs(record.args ?? {})})`;
    if (record.status === "skipped") {
      write(`  ${mark} ${call}   skipped`);
    } else {
      write(`  ${mark} ${call}   ${formatDuration(record.durationMs)}`);
    }
    if (record.outcome) {
      write(`    [outcome] ${record.outcome.name}=${String(record.outcome.value)}`);
    }
    if (record.approval) {
      write(`    [approved] ${record.approval.resolvedBy} at ${record.approval.timestamp}` +
        (record.approval.url ? ` (${record.approval.url})` : ""));
    }
    if (record.refusal) {
      write(`    [refused] ${record.refusal}`);
    }
    if (record.error) {
      write(`    ${record.error}`);
    }
  }

  const total = `${(result.totalMs / 1000).toFixed(1)}s`;
  if (result.status === "ok") {
    write(`Op "${result.op}" completed in ${total}`);
    return;
  }
  if (result.status === "fail" || !result.gate) {
    write(`Op "${result.op}" failed after ${total}`);
    return;
  }

  // Gated (#2119): a standing fact and the one command that clears it. No
  // hint at another runtime — the run ended here on purpose, and the next one
  // re-reads the ledger.
  const { gate } = result;
  write(`Op "${result.op}" is gated on "${gate.gate}" after ${total}`);
  if (gate.description) write(`  ${gate.description}`);
  // #2300: the plan the approval will be bound to. Printed before the
  // command, because it is what the command approves.
  if (gate.planDigest) write(`  plan    : ${gate.planDigest}`);
  write(`  approve : ${approveCommand(gate.op, gate.gate)}`);
  if (gate.url) write(`  approve at: ${gate.url}`);
  write(`  expires : ${gate.expiresAt}`);
  // #2310: this run's own append reached only the local chant/lifecycle
  // branch, not the remote. The pending fact is still correct — the gate is
  // still right to stand — but an operator working from a clone of the
  // remote cannot see it to approve it, and nothing else here says so.
  if (result.gatePushed === false) {
    write(
      `  warning : the pending fact was not pushed to the remote — ` +
        (result.gatePushWarning ?? "it exists only in this checkout") +
        `. An operator elsewhere cannot approve it until it does.`,
    );
  }
}

/**
 * Render the run's ledger record as JSON on stdout (and nothing else on
 * stdout).
 *
 * The record, not the whole `OpRunResult` (#2118): what `chant run <op> --json`
 * emits is byte-for-byte what the run appended to `<env>/runs__<op>.jsonl`, so
 * a consumer reading stdout and one reading the ledger back later agree on
 * every field, the run id included. A gated run's record names the gate it
 * stopped on; the `approve` command line rides alongside so a CI job reporting
 * the gate doesn't have to reassemble it from the op and gate names.
 */
export function renderJson(result: OpRunResult, write: Writer = stdout): void {
  const approve = result.gate ? { approve: approveCommand(result.gate.op, result.gate.gate) } : {};
  // #2310: whether this run's own append reached the remote — not part of
  // the persisted ledger record (a replay has nothing new to report), but a
  // live run's JSON consumer needs it exactly where the human render shows it.
  const push = result.gatePushed === false
    ? { pushed: false, pushWarning: result.gatePushWarning ?? "the pending fact was recorded locally only" }
    : {};
  write(JSON.stringify({ ...result.record, ...approve, ...push }));
}

export type { OpRunResult, StepRecord };
