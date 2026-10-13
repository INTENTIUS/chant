/**
 * The in-flight run record: what an Op run is doing while it runs.
 *
 * The run ledger (`../lifecycle/run-ledger.ts`) gets one record when a run
 * settles, so until then a reader sees the previous run. A run that writes to
 * the ledger (the executor's `ledger` option) also keeps two files beside the
 * checkout's git directory, outside the working tree and the lifecycle branch:
 *
 * - `<git-common-dir>/chant/runs/<key>.json`, the run's id, steward, work
 *   item, current phase and step, and the phases it has finished with their
 *   durations, rewritten whole as the run moves;
 * - `<git-common-dir>/chant/runs/<key>.activity.jsonl`, lines a step's
 *   process appends while it works, one per line.
 *
 * `<key>` folds the member's ledger prefix, the env and the Op's name into one
 * file name. Both files are removed once the run's ledger record is written.
 * A run that died without removing them is recognised by its process: a record
 * whose host is this one and whose pid is gone is not in flight.
 *
 * A step's process finds the activity file in `CHANT_RUN_ACTIVITY`, which the
 * `shellCmd` activity sets for a run that keeps one, and appends a line to it:
 * a JSON object `{"at": "<ISO-8601>", "text": "..."}`, or plain text. An
 * in-process activity calls {@link reportRunActivity}.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveMemberLedger } from "../lifecycle/member-ledger";

const execFileAsync = promisify(execFile);

/** The environment variable naming the activity file, for a step's process. */
export const RUN_ACTIVITY_ENV = "CHANT_RUN_ACTIVITY";
/** The environment variable naming the run, for a step's process. */
export const RUN_ID_ENV = "CHANT_RUN_ID";

/** How many activity lines a reader gets by default: the newest ones. */
export const IN_FLIGHT_ACTIVITY_LINES = 20;

/** A phase the run has finished. */
export interface InFlightPhase {
  name: string;
  status: "ok" | "fail" | "skipped";
  durationMs: number;
}

/** The in-flight record as the run writes it. */
export interface InFlightRecord {
  version: 1;
  id: string;
  op: string;
  env: string;
  steward: string | null;
  /** The work item the run's lease holds, once it is claimed. */
  item: string | null;
  started: string;
  /** When the record was last rewritten. */
  updated: string;
  host: string;
  pid: number;
  phase: { name: string; started: string } | null;
  /** The newest step still running: its id when it has one, else its activity. */
  step: { name: string; fn: string; started: string } | null;
  phases: InFlightPhase[];
}

/** One activity line as a reader gets it. `seq` counts from 1 over the run. */
export interface InFlightActivityLine {
  seq: number;
  at: string | null;
  text: string;
}

/** The in-flight record with its newest activity lines. */
export interface InFlightRun extends InFlightRecord {
  activity: { total: number; lines: InFlightActivityLine[] };
}

/** The file name a run's record is kept under, the prefix and env folded in. */
function keyOf(prefix: string, env: string, op: string): string {
  return `${prefix}${env}/${op}`.replace(/[\/\\]/g, "__").replace(/[^A-Za-z0-9._@-]/g, "_");
}

/** The checkout's shared git directory (the same for every worktree), or null outside a checkout. */
async function gitCommonDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd });
    const dir = stdout.trim();
    return dir === "" ? null : isAbsolute(dir) ? dir : resolve(cwd, dir);
  } catch {
    return null;
  }
}

/** Where the run of `op` in `env` for the project at `cwd` keeps its files, or null outside a checkout. */
export async function inFlightPaths(cwd: string, env: string, op: string): Promise<{ record: string; activity: string } | null> {
  const common = await gitCommonDir(cwd);
  if (!common) return null;
  const { prefix } = await resolveMemberLedger(cwd);
  const base = join(common, "chant", "runs", keyOf(prefix, env, op));
  return { record: `${base}.json`, activity: `${base}.activity.jsonl` };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One activity line appended to `file`. Never throws: a report is not worth failing a step for. */
function appendActivity(file: string, text: string): void {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return;
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), text: line })}\n`);
  } catch {
    // The run's files are gone or unwritable: the line is dropped.
  }
}

/**
 * A running Op's in-flight record. The executor opens one per run that
 * writes to the ledger and calls it as the run moves. Every write is
 * best-effort: a record that can't be written leaves the run as it was.
 */
export class LiveRun {
  private readonly rec: InFlightRecord;
  private readonly running: InFlightRecord["step"][] = [];

  private constructor(private readonly paths: { record: string; activity: string }, rec: InFlightRecord) {
    this.rec = rec;
  }

  /** Open the record for a run starting now, or undefined when the project is not a checkout. */
  static async open(opts: { cwd: string; env: string; op: string; id: string; started: string; steward?: string }): Promise<LiveRun | undefined> {
    let paths: Awaited<ReturnType<typeof inFlightPaths>>;
    try {
      paths = await inFlightPaths(opts.cwd, opts.env, opts.op);
    } catch {
      return undefined;
    }
    if (!paths) return undefined;
    const run = new LiveRun(paths, {
      version: 1,
      id: opts.id,
      op: opts.op,
      env: opts.env,
      steward: opts.steward ?? null,
      item: null,
      started: opts.started,
      updated: opts.started,
      host: hostname(),
      pid: process.pid,
      phase: null,
      step: null,
      phases: [],
    });
    try {
      mkdirSync(join(paths.record, ".."), { recursive: true });
      writeFileSync(paths.activity, "");
    } catch {
      return undefined;
    }
    run.write();
    return run;
  }

  /** The file a step's process appends activity lines to. */
  get activityFile(): string {
    return this.paths.activity;
  }

  get id(): string {
    return this.rec.id;
  }

  phaseStarted(name: string): void {
    this.rec.phase = { name, started: new Date().toISOString() };
    this.write();
  }

  phaseEnded(name: string, status: InFlightPhase["status"], durationMs: number): void {
    this.rec.phases.push({ name, status, durationMs });
    if (this.rec.phase?.name === name) this.rec.phase = null;
    this.write();
  }

  /** A step started; the returned function says it ended. */
  stepStarted(fn: string, id?: string): () => void {
    const step = { name: id ?? fn, fn, started: new Date().toISOString() };
    this.running.push(step);
    this.rec.step = step;
    this.write();
    return () => {
      const at = this.running.indexOf(step);
      if (at >= 0) this.running.splice(at, 1);
      this.rec.step = this.running.at(-1) ?? null;
      this.write();
    };
  }

  item(item: string): void {
    this.rec.item = item;
    this.write();
  }

  report(text: string): void {
    appendActivity(this.paths.activity, text);
  }

  /** The run has settled and its ledger record is written: remove its files. */
  close(): void {
    for (const file of [this.paths.record, this.paths.activity]) {
      try {
        rmSync(file, { force: true });
      } catch {
        // Left behind; a reader drops it once this process is gone.
      }
    }
  }

  private write(): void {
    this.rec.updated = new Date().toISOString();
    const tmp = `${this.paths.record}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.rec));
      renameSync(tmp, this.paths.record);
    } catch {
      // Best-effort, as the module doc says.
    }
  }
}

const context = new AsyncLocalStorage<LiveRun>();

/** Run `fn` as part of `live`'s run, so the steps under it find it. */
export function withLiveRun<T>(live: LiveRun | undefined, fn: () => Promise<T>): Promise<T> {
  return live ? context.run(live, fn) : fn();
}

/** The run the calling step is part of, when it keeps an in-flight record. */
export function currentLiveRun(): LiveRun | undefined {
  return context.getStore();
}

/** The variables a step's child process gets so it can report activity. Empty outside such a run. */
export function liveRunEnv(): Record<string, string> {
  const live = context.getStore();
  return live ? { [RUN_ACTIVITY_ENV]: live.activityFile, [RUN_ID_ENV]: live.id } : {};
}

/** Append an activity line to the run the calling activity is part of. A no-op outside one. */
export function reportRunActivity(text: string): void {
  context.getStore()?.report(text);
}

function parseActivity(content: string, limit: number): InFlightRun["activity"] {
  const raw = content.split("\n").filter((l) => l.trim() !== "");
  const from = Math.max(0, raw.length - limit);
  const lines = raw.slice(from).map((line, i): InFlightActivityLine => {
    const seq = from + i + 1;
    try {
      const parsed = JSON.parse(line) as { at?: unknown; text?: unknown };
      if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
        return { seq, at: typeof parsed.at === "string" ? parsed.at : null, text: parsed.text };
      }
    } catch {
      // Plain text.
    }
    return { seq, at: null, text: line.trim() };
  });
  return { total: raw.length, lines };
}

/**
 * The run of `op` in `env` in flight for the project at `cwd`, with its
 * newest `limit` activity lines, or null when none is. A record left by a
 * process on this host that is gone is not in flight.
 */
export async function readInFlightRun(cwd: string, env: string, op: string, limit = IN_FLIGHT_ACTIVITY_LINES): Promise<InFlightRun | null> {
  const paths = await inFlightPaths(cwd, env, op);
  if (!paths || !existsSync(paths.record)) return null;
  let rec: InFlightRecord;
  try {
    rec = JSON.parse(readFileSync(paths.record, "utf8")) as InFlightRecord;
  } catch {
    return null;
  }
  if (rec.version !== 1 || typeof rec.id !== "string" || typeof rec.started !== "string") return null;
  if (rec.host === hostname() && typeof rec.pid === "number" && !processAlive(rec.pid)) return null;
  let content = "";
  try {
    content = readFileSync(paths.activity, "utf8");
  } catch {
    // No activity yet.
  }
  return { ...rec, phases: Array.isArray(rec.phases) ? rec.phases : [], activity: parseActivity(content, limit) };
}
