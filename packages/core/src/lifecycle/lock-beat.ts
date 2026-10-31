/**
 * The heartbeat of a row hold (#4660). A job that is cancelled or killed
 * never runs its cleanup, so the hold it took stays on `chant/lifecycle`
 * and later waves on the stack wait on it. The hold carries a liveness
 * token, `beat`, that a side process of the apply refreshes every
 * `CHANT_LOCK_BEAT` seconds. The next waiter reads a hold whose beat is
 * older than `CHANT_LOCK_BEAT_STALE` seconds as gone and takes it over
 * (./resource-lock.ts `forgeLockLiveness`).
 *
 * The beat runs in its own process because an apply waits on its tool with
 * `spawnSync`, which stops every timer of the job's process. The side
 * process is `chant lock --beat <run> --parent <pid>`: it touches the hold,
 * and ends when the hold is gone or when the job's process is. A job that is
 * killed takes it along, and one that is not leaves a beat that goes stale.
 *
 * Only the chant CLI starts one ({@link setOwnChantCommand}); library
 * callers and tests start none, and a hold without a beat keeps the forge
 * and lease rules.
 */
import { spawn } from "node:child_process";
import type { LockBeatStarter } from "./resource-lock";

let own: string[] | undefined;

/** Record how to run this chant again; called by the CLI entry point. */
export function setOwnChantCommand(command: readonly string[] | undefined): void {
  own = command && command.length > 0 && command.every((c) => typeof c === "string" && c !== "") ? [...command] : undefined;
}

/** The starter of the heartbeat side process, or undefined outside the chant CLI or when `CHANT_LOCK_BEAT=off`. */
export function ownBeatStarter(env: Record<string, string | undefined> = process.env): LockBeatStarter | undefined {
  if (!own || env.CHANT_LOCK_BEAT === "off") return undefined;
  const command = own;
  return ({ gate, holder, cwd }) => {
    const [bin, ...lead] = command;
    const child = spawn(bin!, [...lead, "lock", "--beat", holder.run, "--gate", gate, "--parent", String(process.pid)], {
      ...(cwd ? { cwd } : {}),
      detached: true,
      stdio: "ignore",
      env,
    });
    child.on("error", () => {
      // No side process: the hold keeps the forge and lease rules.
    });
    child.unref();
    return () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    };
  };
}

export interface BeatLoop {
  gate: string;
  run: string;
  /** The process whose end ends the loop. */
  parent: number;
  intervalMs: number;
  /** Touch the hold: `gone` ends the loop. */
  beat(at: string): Promise<"held" | "gone">;
  parentAlive?(pid: number): boolean;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** Where a failed touch is said. */
  log?(line: string): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Touch the hold now and every interval until it is released or taken over
 * (`released`) or the parent process ends (`parent-gone`). A touch that fails
 * is tried again at the next interval; the hold goes stale only after
 * `CHANT_LOCK_BEAT_STALE` seconds of failures.
 */
export async function runBeatLoop(loop: BeatLoop): Promise<"released" | "parent-gone"> {
  const alive = loop.parentAlive ?? processAlive;
  const sleep = loop.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = loop.now ?? Date.now;
  for (;;) {
    if (!alive(loop.parent)) return "parent-gone";
    try {
      if ((await loop.beat(new Date(now()).toISOString())) === "gone") return "released";
    } catch (err) {
      loop.log?.(`could not touch the hold of run ${loop.run} on ${loop.gate}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(loop.intervalMs);
  }
}
