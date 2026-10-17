/**
 * `--events-json` (#4041): a command's run-event stream on stdout, one
 * `run-event.schema.json` line per event. Shared by `chant run`, the
 * components commands that deploy (promote, rollback, redeploy, fan-out) and
 * the pull-request loop (pr-plan, pr-apply).
 */

import { formatError } from "./format";
import { openRunEventStream, resolveRunEventRun, type RunEventStream } from "../run-event-stream";
import type { RunEventKind } from "../run-event";
import type { ParsedArgs } from "./registry";

/** Refuse `--events-json` beside `--progress-json`: both print to stdout. Returns true after printing why. */
export function refusesBothStreams(args: Pick<ParsedArgs, "eventsJson" | "progressJson">): boolean {
  if (!args.eventsJson || !args.progressJson) return false;
  console.error(formatError({
    message: "--events-json and --progress-json both stream to stdout",
    hint: "Pass one. --events-json prints the run-event stream; --progress-json prints the older progress lines.",
  }));
  return true;
}

/** Writes one line to stdout. */
export const stdoutLine = (line: string): void => void process.stdout.write(line);

/**
 * The run's stream on stdout when `--events-json` was passed, else
 * undefined. The run is named by `runId` when the caller has one (so a
 * release record and the stream name the same run), else by the CI run or a
 * local id.
 */
export async function openCliRunEvents(
  args: Pick<ParsedArgs, "eventsJson">,
  run: { kind: RunEventKind; name: string; runId?: string; cwd?: string },
): Promise<RunEventStream | undefined> {
  if (!args.eventsJson) return undefined;
  return openRunEventStream(await resolveRunEventRun(run), stdoutLine);
}
