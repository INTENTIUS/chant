/**
 * Renderers for `chant run --components` (#585) — the interpret driver's CLI
 * output. Mirrors `../op/local-output.ts`'s `renderHuman`/`renderJson` pair
 * for Ops: both consume the same `DriverRunResult` (`./driver.ts`);
 * `renderDriverHuman` is the default (logs to stderr), `renderDriverJson`
 * prints the machine-readable result as JSON on stdout and nothing else.
 */

import type { DriverRunResult, DriverStepRecord } from "./driver";

type Writer = (line: string) => void;

const stderr: Writer = (line) => process.stderr.write(line + "\n");
const stdout: Writer = (line) => process.stdout.write(line + "\n");

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusMark(status: DriverStepRecord["status"]): string {
  switch (status) {
    case "ok":
      return "✓";
    case "fail":
      return "✗";
    case "rolled-back":
      return "↺";
    default:
      return "•";
  }
}

/**
 * Render an interpret-driver run result as human-readable progress. Defaults
 * to stderr so stdout stays clean for piping (the `--json` renderer owns
 * stdout). Groups records by component, then by phase, matching the driver's
 * own wave/phase/step nesting.
 */
export function renderDriverHuman(result: DriverRunResult, write: Writer = stderr): void {
  for (const componentResult of result.results) {
    write(`[component] ${componentResult.component}`);
    let currentPhase: string | undefined;
    for (const record of componentResult.records) {
      if (record.phase !== currentPhase) {
        currentPhase = record.phase;
        write(`  [phase] ${currentPhase}`);
      }
      const mark = statusMark(record.status);
      if (record.status === "skipped") {
        write(`    ${mark} ${record.kind}   skipped`);
      } else {
        write(`    ${mark} ${record.kind}   ${formatDuration(record.durationMs)}`);
      }
      if (record.approval) {
        write(`      [approved] ${record.approval.resolvedBy} at ${record.approval.timestamp}` +
          (record.approval.url ? ` (${record.approval.url})` : ""));
      }
      if (record.error) {
        write(`      ${record.error}`);
      }
    }
    write(
      componentResult.status === "ok"
        ? `  component "${componentResult.component}" completed`
        : componentResult.status === "gated"
          ? `  component "${componentResult.component}" gated on "${componentResult.gate?.gate ?? "?"}"`
          : `  component "${componentResult.component}" failed`,
    );
  }

  if (result.status === "ok") {
    write(`interpret run completed (${result.order.length} component(s))`);
  } else if (result.status === "gated") {
    write(`interpret run is gated at component "${result.gatedComponent}"`);
    // #2310: this run's own append reached only the local chant/lifecycle
    // branch. The gate still stands correctly — but an operator elsewhere
    // cannot see the pending fact to approve it.
    if (result.gatePushed === false) {
      write(
        `  warning : the pending fact was not pushed to the remote — ` +
          (result.gatePushWarning ?? "it exists only in this checkout") +
          `. An operator elsewhere cannot approve it until it does.`,
      );
    }
  } else {
    write(`interpret run failed at component "${result.failedComponent}"`);
  }
}

/** Render an interpret-driver run result as JSON on stdout (and nothing else on stdout). */
export function renderDriverJson(result: DriverRunResult, write: Writer = stdout): void {
  write(JSON.stringify(result));
}
