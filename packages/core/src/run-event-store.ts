/**
 * Where a run's events are kept on this host, and how to read them back
 * (#4042). `chant run events <run>` replays a run from here and `--follow`
 * tails it.
 *
 * Each run gets one file, `<git-common-dir>/chant/run-events/<run id>.jsonl`,
 * holding the lines the one writer (`./run-event.ts`) produced, byte for byte
 * as `--events-json` prints them. It sits beside the in-flight records
 * (`./op/run-live.ts`), outside the working tree and off `chant/lifecycle`:
 * the run ledger's growth is #4036's concern and these files add none to it.
 * Unlike the in-flight record they are kept after the run settles. They are
 * never pruned here; retention is #4036's.
 *
 * Every write is best-effort. A run whose events cannot be kept still runs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitCommonDir } from "./op/run-live";
import type { RunEvent } from "./run-event";

/** The directory name under `<git-common-dir>/chant/` that holds the files. */
export const RUN_EVENTS_DIR = "run-events";

/** The file name a run id is kept under: anything that is not a plain file-name character becomes `_`. */
export function runEventFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._@-]/g, "_")}.jsonl`;
}

/** The directory the checkout at `cwd` keeps run events in, or null outside a checkout. */
export async function runEventsDir(cwd: string): Promise<string | null> {
  const common = await gitCommonDir(cwd);
  return common ? join(common, "chant", RUN_EVENTS_DIR) : null;
}

/** An open file a run's lines are appended to. */
export interface RunEventStore {
  readonly path: string;
  /** Append one line (it already ends with a newline). Never throws. */
  write(line: string): void;
}

/** Open the file for `runId`, or undefined outside a checkout or where it cannot be created. */
export async function openRunEventStore(cwd: string, runId: string): Promise<RunEventStore | undefined> {
  let dir: string | null;
  try {
    dir = await runEventsDir(cwd);
  } catch {
    return undefined;
  }
  if (!dir) return undefined;
  const path = join(dir, runEventFileName(runId));
  try {
    mkdirSync(dir, { recursive: true });
    // A run id used again (a re-run of the same CI run) replaces the earlier stream.
    writeFileSync(path, "");
  } catch {
    return undefined;
  }
  return {
    path,
    write(line) {
      try {
        appendFileSync(path, line);
      } catch {
        // The directory is gone or unwritable: the line is dropped.
      }
    },
  };
}

/** A write function that hands each line to every function given, or undefined when none is. */
export function teeLines(...writes: Array<((line: string) => void) | undefined>): ((line: string) => void) | undefined {
  const live = writes.filter((w): w is (line: string) => void => w !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return (line) => {
    for (const w of live) w(line);
  };
}

/** The events in `text`, one per whole line. Returns what is left of an unfinished last line. */
export function parseRunEventLines(text: string): { events: RunEvent[]; rest: string } {
  const events: RunEvent[] = [];
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    if (part.trim() === "") continue;
    try {
      events.push(JSON.parse(part) as RunEvent);
    } catch {
      // A line that is not JSON is not an event: skipped.
    }
  }
  return { events, rest };
}

/** A stored run, as far as its first line says. */
export interface StoredRun {
  runId: string;
  name: string;
  file: string;
  /** The file's last write, in ms. */
  mtimeMs: number;
}

/** The runs stored for the checkout at `cwd`, newest first. */
export async function listStoredRuns(cwd: string): Promise<StoredRun[]> {
  const dir = await runEventsDir(cwd);
  if (!dir || !existsSync(dir)) return [];
  const runs: StoredRun[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const file = join(dir, entry);
    try {
      const first = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
      if (first === "") continue;
      const head = JSON.parse(first) as Partial<RunEvent>;
      if (typeof head.runId !== "string") continue;
      runs.push({ runId: head.runId, name: String(head.name ?? ""), file, mtimeMs: statSync(file).mtimeMs });
    } catch {
      // Unreadable or not an event file: not listed.
    }
  }
  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * The file for `ref`: a run id, else the name of an Op or a component
 * selection, for which the newest stored run of that name stands. Null when
 * nothing matches (a run that has not written its first line yet included).
 */
export async function findStoredRun(cwd: string, ref: string): Promise<StoredRun | null> {
  const dir = await runEventsDir(cwd);
  if (!dir) return null;
  const direct = join(dir, runEventFileName(ref));
  if (existsSync(direct)) {
    const byId = (await listStoredRuns(cwd)).find((r) => r.file === direct);
    return byId ?? { runId: ref, name: "", file: direct, mtimeMs: statSync(direct).mtimeMs };
  }
  return (await listStoredRuns(cwd)).find((r) => r.name === ref) ?? null;
}

/** Whether `event` ends a stream. */
export const isRunSettle = (event: RunEvent): boolean => event.type === "run-settle";

/**
 * Read `file` from the start and hand each event to `onEvent` (with its raw
 * line). Without `follow` it stops at the end of the file. With it, it keeps
 * reading what is appended, by polling every `pollMs`, until `run-settle` is
 * read, `signal` aborts, or `idleMs` passes with nothing new (when given).
 * Resolves with the `run-settle` event, or undefined when the stream had
 * none (a replay of a run still going, or a follow that was cut short).
 */
export async function readRunEvents(
  file: string,
  onEvent: (event: RunEvent, line: string) => void,
  opts: { follow?: boolean; pollMs?: number; idleMs?: number; signal?: AbortSignal } = {},
): Promise<RunEvent | undefined> {
  const pollMs = opts.pollMs ?? 100;
  let offset = 0;
  let rest = "";
  let lastGrowth = Date.now();
  for (;;) {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // Not there yet (a follow started before the run opened its file).
    }
    if (size > offset) {
      const buf = readFileSync(file);
      const chunk = buf.subarray(offset, size).toString("utf8");
      offset = size;
      lastGrowth = Date.now();
      const text = rest + chunk;
      const parts = text.split("\n");
      rest = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim() === "") continue;
        let event: RunEvent;
        try {
          event = JSON.parse(part) as RunEvent;
        } catch {
          continue;
        }
        onEvent(event, `${part}\n`);
        if (isRunSettle(event)) return event;
      }
    } else if (!opts.follow) {
      return undefined;
    } else if (opts.signal?.aborted) {
      return undefined;
    } else if (opts.idleMs !== undefined && Date.now() - lastGrowth > opts.idleMs) {
      return undefined;
    } else {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        opts.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
}
