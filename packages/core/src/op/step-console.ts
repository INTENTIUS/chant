/**
 * A running step's console (#3956): its output as it arrives, and a
 * "still running" line while it is quiet.
 *
 * The run's own render (`./local-output.ts`) is printed once the run
 * settles, so before this a 15-minute step printed nothing for 15 minutes and
 * a watchdog reading the output killed a healthy run. When the caller hands
 * the executor a writer (`RunOpOptions.stepOutput`, which the local runtime
 * passes, writing to stderr), each activity step runs with a console:
 *
 * - an activity that runs a process (`shellCmd`) passes each line the process
 *   writes, stdout and stderr alike, through {@link stepOutputLine}, and it is
 *   printed at once as `[<phase>] <step> | <line>`;
 * - a step that prints nothing for `heartbeatMs` (an activity that only
 *   returns a value, or a command that is quiet) gets
 *   `[<phase>] <step>: still running after <n>s` each time that much passes.
 *
 * `<step>` is the step's id when it has one, else its call as the run's
 * render names it, `fn(arg=value, ...)`, cut to a readable length. Without a
 * writer there is no console, and `shellCmd` prints a command's stderr when it
 * ends, as it did before.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { parseDuration } from "./duration";

/** How long a step may be quiet before the runner says it is still running. */
export const DEFAULT_STEP_HEARTBEAT_MS = 60_000;

/** The environment variable that sets the interval: a duration ("30s", "5m"), or `0` / `off`. */
export const STEP_HEARTBEAT_ENV = "CHANT_STEP_HEARTBEAT";

/** The longest step label a line carries before it is cut. */
const MAX_LABEL = 60;

interface StepConsole {
  line(text: string): void;
}

/** Where a run's step lines go, and how often a quiet step says it is still running. */
export interface RunConsole {
  write: (line: string) => void;
  heartbeatMs?: number;
  /** Applied to each line before it is written, and to a step's call before it is cut to a label (#4096). */
  redact?: (text: string) => string;
}

const store = new AsyncLocalStorage<StepConsole>();
const runStore = new AsyncLocalStorage<RunConsole>();

/** Run `fn` as a run whose steps print through `run`. Without one, steps get no console. */
export function withRunConsole<T>(run: RunConsole | undefined, fn: () => Promise<T>): Promise<T> {
  return run ? runStore.run(run, fn) : fn();
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

/** The name a step's lines carry: its id, else `fn(args)` on one line, cut to {@link MAX_LABEL}. */
export function stepLabel(fn: string, args: Record<string, unknown>, id?: string): string {
  if (id) return id;
  // A secret in the call is redacted before the label is cut, so a cut never leaves part of one.
  const redact = runStore.getStore()?.redact;
  const raw = `${fn}(${formatArgs(args)})`;
  const call = (redact ? redact(raw) : raw).replace(/\s+/g, " ");
  return call.length > MAX_LABEL ? `${call.slice(0, MAX_LABEL - 4)}...)` : call;
}

/**
 * Run `fn` with a console for one step, when the run has one
 * ({@link withRunConsole}). The heartbeat timer is stopped when `fn`
 * settles; it never holds the process open on its own.
 */
export async function withStepConsole<T>(opts: { phase: string; label: string }, fn: () => Promise<T>): Promise<T> {
  const run = runStore.getStore();
  if (!run) return fn();
  const write = run.redact ? (line: string) => run.write(run.redact!(line)) : run.write;
  const prefix = `[${opts.phase}] ${opts.label}`;
  const started = Date.now();
  let spoke = false;
  const sink: StepConsole = {
    line(text) {
      spoke = true;
      write(`${prefix} | ${text}`);
    },
  };
  const every = run.heartbeatMs ?? DEFAULT_STEP_HEARTBEAT_MS;
  const timer = every > 0
    ? setInterval(() => {
        if (spoke) {
          spoke = false;
          return;
        }
        write(`${prefix}: still running after ${Math.round((Date.now() - started) / 1000)}s`);
      }, every)
    : undefined;
  timer?.unref();
  try {
    return await store.run(sink, fn);
  } finally {
    if (timer) clearInterval(timer);
  }
}

/** Whether the calling activity runs under a step console, so its output is printed as it arrives. */
export function hasStepConsole(): boolean {
  return store.getStore() !== undefined;
}

/** Print one line of the calling step's output. A no-op outside a step console. */
export function stepOutputLine(text: string): void {
  store.getStore()?.line(text);
}

/**
 * A sink for a stream's chunks that prints whole lines to the calling step's
 * console as they complete; `end()` prints what is left. The console is the
 * one current when the splitter is made, since a stream's `data` events need
 * not run in the step's async context.
 */
export function stepLineSplitter(): { push(chunk: string | Buffer): void; end(): void } {
  const sink = store.getStore();
  let pending = "";
  const emit = (line: string) => sink?.line(line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    push(chunk) {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let at = pending.indexOf("\n");
      while (at >= 0) {
        emit(pending.slice(0, at));
        pending = pending.slice(at + 1);
        at = pending.indexOf("\n");
      }
    },
    end() {
      if (pending !== "") emit(pending);
      pending = "";
    },
  };
}

/**
 * The heartbeat interval `CHANT_STEP_HEARTBEAT` sets, or the default. `0` and
 * `off` turn it off. A value that is not a duration falls back to the default
 * and says so through `warn`.
 */
export function stepHeartbeatMs(env: NodeJS.ProcessEnv = process.env, warn?: (message: string) => void): number {
  const raw = env[STEP_HEARTBEAT_ENV]?.trim();
  if (!raw) return DEFAULT_STEP_HEARTBEAT_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return 0;
  try {
    return parseDuration(raw);
  } catch {
    warn?.(`${STEP_HEARTBEAT_ENV}="${raw}" is not a duration (such as 30s or 5m) or off; using ${DEFAULT_STEP_HEARTBEAT_MS / 1000}s`);
    return DEFAULT_STEP_HEARTBEAT_MS;
  }
}
