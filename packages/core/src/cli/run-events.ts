/**
 * `--events-json` (#4041): a command's run-event stream on stdout, one
 * `run-event.schema.json` line per event, also kept on this host for replay
 * (#4042, `../run-event-store.ts`). Shared by `chant run`, the
 * components commands that deploy (promote, rollback, redeploy, fan-out) and
 * the pull-request loop (pr-plan, pr-apply).
 */

import { formatError } from "./format";
import { openRunEventStore, teeLines } from "../run-event-store";
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

/** Refuse `--events-json` beside `--json` where `--json` prints a report to stdout (pr-plan, pr-apply). Returns true after printing why. */
export function refusesEventsWithJson(args: Pick<ParsedArgs, "eventsJson" | "json">, report: string): boolean {
  if (!args.eventsJson || !args.json) return false;
  console.error(formatError({
    message: "--events-json and --json both stream to stdout",
    hint: `Pass one. --events-json prints the run-event stream; --json prints ${report}.`,
  }));
  return true;
}

/** Writes one line to stdout. */
export const stdoutLine = (line: string): void => void process.stdout.write(line);

/**
 * The run's stream on stdout when `--events-json` was passed, else
 * undefined. Each line goes to stdout, to this host's store and to `also`
 * when given. The run is named by `runId` when the caller has one (so a
 * release record and the stream name the same run), else by the CI run or a
 * local id.
 */
export async function openCliRunEvents(
  args: Pick<ParsedArgs, "eventsJson">,
  run: { kind: RunEventKind; name: string; runId?: string; cwd?: string },
  also?: (line: string) => void,
): Promise<RunEventStream | undefined> {
  if (!args.eventsJson) return undefined;
  const resolved = await resolveRunEventRun(run);
  // #4042: the stream is also kept on this host, so `chant run events <run>`
  // replays it. Only a command that was asked for a stream keeps one.
  const store = await openRunEventStore(run.cwd ?? process.cwd(), resolved.runId);
  // `also`: a third copy of each line, such as `--report-url`'s upload (#4007).
  return openRunEventStream(resolved, teeLines(stdoutLine, store?.write.bind(store), also)!);
}
