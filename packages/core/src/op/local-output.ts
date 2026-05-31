/**
 * Renderers for local Op execution. Both consume the same `OpRunResult`:
 * `renderHuman` is the default (logs to stderr), `renderJson` prints the
 * machine-readable record array to stdout and nothing else.
 */

import type { OpRunResult, StepRecord } from "./local-executor";

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
    const call = `${record.fn}(${formatArgs(record.args)})`;
    if (record.status === "skipped") {
      write(`  ${mark} ${call}   skipped`);
    } else {
      write(`  ${mark} ${call}   ${formatDuration(record.durationMs)}`);
    }
    if (record.outcome) {
      write(`    [outcome] ${record.outcome.name}=${String(record.outcome.value)}`);
    }
    if (record.error) {
      write(`    ${record.error}`);
    }
  }

  const total = `${(result.totalMs / 1000).toFixed(1)}s`;
  if (result.ok) {
    write(`Op "${result.op}" completed in ${total}`);
  } else {
    write(`Op "${result.op}" failed after ${total}`);
  }
}

/** Render a run result as JSON on stdout (and nothing else on stdout). */
export function renderJson(result: OpRunResult, write: Writer = stdout): void {
  write(JSON.stringify(result));
}

export type { OpRunResult, StepRecord };
