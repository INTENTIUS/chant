/**
 * An Op a steward runs beside its turns (#2861): how a run of it is started,
 * held and asked for.
 *
 * A local steward runs the Ops it lists one turn at a time (#2750). An Op
 * listed under `beside` (`./steward.ts`) is the steward's too, but a run of it
 * is not a turn: the operator (`./operator.ts`) starts it as a `chant run
 * <op>` process of its own and goes on with its rounds, so converge keeps its
 * cadence while a build of half an hour runs.
 *
 * - The run holds the Op's own lease (`refs/chant/lease/<op>`, the lease a
 *   round's tick of any Op takes), renewed every third of its time to live
 *   for as long as the run lasts, and released when it ends. That is what
 *   makes it one run at a time, whoever starts it: the operator, or a person's
 *   `chant run <op>`, which takes this lease and not the steward's turn.
 * - The process the operator starts carries `CHANT_STEWARD`, so its run record
 *   names the steward, a decision point it asks is the steward's, and the
 *   operator resumes it once the question is answered, by starting another
 *   such process. Its work lease holder is `<steward>/<op>@<operator>`, which
 *   is how `workspace status` finds it under the steward.
 */
import { spawn } from "node:child_process";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import { runOpLocally, OpRunFailure } from "./local-executor";
import type { ActivityStep, OpConfig } from "./types";
import { parseDuration } from "./duration";
import { acquireLease, releaseLease, DEFAULT_LEASE_TTL_MS, type LeaseRecord } from "../lifecycle/lease";
import { readinessKeys } from "./steward";

/** Why the operator started a run beside the turns. */
export type BesideWhy = "cron" | "ready" | "resumed" | "approved";

/** What the operator asks a launcher to start. */
export interface BesideStart {
  /** The Op. */
  op: OpConfig;
  /** The steward whose run it is. */
  steward: string;
  /** The operator's own `--env`, passed on so the run reads the steward's form the same way. */
  env?: string;
  /** The holder the run claims the Op's lease and any work lease as: `<steward>/<op>@<operator>`. */
  holder: string;
  /** The project directory. */
  cwd: string;
  /** How long the Op's lease lasts unless renewed. */
  leaseTtlMs?: number;
}

/** How a started run ended: its exit code (0 ok, 3 gated or waiting, 1 failed), or the error that kept it from running. */
export interface BesideExit {
  code: number | null;
  error?: string;
}

/** A run started beside the turns. */
export interface BesideHandle {
  /** Settles when the run ends; never rejects. */
  done: Promise<BesideExit>;
  /** Ask the run to stop, as Ctrl-C does: it stops its steps and releases its leases. */
  stop(): void;
}

/** Starts a run beside the turns. The default is {@link spawnBesideRun}. */
export type BesideLauncher = (start: BesideStart) => BesideHandle;

/** The exit code `chant run` gives a run that stopped at a gate or on an open decision point. */
const WAITING_EXIT = 3;

/**
 * Start `chant run <op>` as a process of its own: the same node, loader and
 * entry script this process runs as, in the project directory, with
 * `CHANT_STEWARD` naming the steward and `--holder` naming the holder.
 */
export function spawnBesideRun(start: BesideStart): BesideHandle {
  const args = [
    ...process.execArgv,
    process.argv[1],
    "run",
    start.op.name,
    "--holder",
    start.holder,
    ...(start.env ? ["--env", start.env] : []),
  ];
  const child = spawn(process.execPath, args, {
    cwd: start.cwd,
    env: { ...process.env, CHANT_STEWARD: start.steward },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const done = new Promise<BesideExit>((resolve) => {
    child.once("error", (err) => resolve({ code: null, error: err.message }));
    child.once("exit", (code, signal) => resolve(signal ? { code: null, error: `stopped by ${signal}` } : { code }));
  });
  return {
    done,
    // `chant run` stops its Op and releases its leases on SIGINT.
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    },
  };
}

/**
 * A launcher that runs the Op in this process, as an async task, under the
 * same lease a `chant run` of it takes. For tests, and for an embedder whose
 * activities are its own: the run does not enter the steward's turn (that is
 * a property of the process, and the operator's own turns share it), so its
 * record names the steward and a decision point it asks does not.
 */
export function inProcessBesideLauncher(
  activities: Map<string, ActivityFn>,
  profiles: Record<string, ActivityProfile>,
): BesideLauncher {
  return (start) => {
    const controller = new AbortController();
    const done = (async (): Promise<BesideExit> => {
      const held = await holdBesideLease(start.op.name, start.holder, { cwd: start.cwd, ttlMs: start.leaseTtlMs });
      if (!held.acquired) return { code: 1, error: `the lease of "${start.op.name}" is held by ${held.heldBy ?? "another holder"}` };
      try {
        const result = await runOpLocally(start.op, activities, profiles, controller.signal, {
          steward: start.steward,
          ledger: { cwd: start.cwd },
          work: { holder: start.holder },
        });
        return { code: result.status === "gated" || result.status === "waiting" ? WAITING_EXIT : 0 };
      } catch (err) {
        return { code: 1, error: err instanceof OpRunFailure ? `Op "${start.op.name}" failed` : err instanceof Error ? err.message : String(err) };
      } finally {
        await held.release();
      }
    })();
    return { done, stop: () => controller.abort() };
  };
}

/** The Op's own lease, held for a run beside the turns. */
export type HeldBesideLease =
  | { acquired: true; lease: LeaseRecord; release: () => Promise<void> }
  | { acquired: false; heldBy?: string };

/**
 * Take the Op's own lease for one run beside the steward's turns, and renew
 * it every third of its time to live until `release` is called. A run of half
 * an hour keeps it; a process that dies stops renewing and the lease expires.
 * Refused when another holder has it: a run of the Op is in flight.
 */
export async function holdBesideLease(
  op: string,
  holder: string,
  opts: { cwd?: string; ttlMs?: number } = {},
): Promise<HeldBesideLease> {
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const first = await acquireLease(op, holder, { cwd: opts.cwd, ttlMs });
  if (!first.acquired) return { acquired: false, ...(first.heldBy?.holder ? { heldBy: first.heldBy.holder } : {}) };
  const lease = first.lease!;
  // A renewal that fails is retried on the next beat; one the lease refuses
  // means another holder took it after it expired, and there is nothing to renew.
  const timer = setInterval(() => {
    void acquireLease(op, holder, { cwd: opts.cwd, ttlMs, mode: "renew", token: lease.token }).catch(() => undefined);
  }, Math.max(1, Math.floor(ttlMs / 3)));
  timer.unref?.();
  let released = false;
  return {
    acquired: true,
    lease,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      await releaseLease(op, holder, lease.token, { cwd: opts.cwd }).catch(() => false);
    },
  };
}

/** How long a ready step may run when it names no `timeout`. */
export const DEFAULT_READY_TIMEOUT_MS = 120_000;

/** What one ready step said: whether there is work and its keys, or why it could not say. */
export type ReadyAnswer = { ready: boolean; keys: string[] } | { error: string };

/**
 * Run a steward's `ready` step for an Op beside its turns (#2861) and read
 * its answer with {@link readinessKeys}. The step is one activity call, with
 * its own `timeout` or {@link DEFAULT_READY_TIMEOUT_MS}; it runs outside any
 * run, so it writes no record, and it is the author's to keep it a read.
 */
export async function askReady(
  step: ActivityStep,
  activities: Map<string, ActivityFn>,
  signal?: AbortSignal,
): Promise<ReadyAnswer> {
  const fn = activities.get(step.fn);
  if (!fn) return { error: `its ready step's activity "${step.fn}" is not loaded` };
  const timeoutMs = step.timeout ? parseDuration(step.timeout) : DEFAULT_READY_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = Promise.resolve(fn({ ...(step.args ?? {}) }, controller.signal));
    call.catch(() => {});
    const result = await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    const answer = readinessKeys(result);
    if (!answer) return { error: "its ready step answered neither true, false, null, a string nor a list" };
    return answer;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
