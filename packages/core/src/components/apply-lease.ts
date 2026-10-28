/**
 * The grain and the row lease a CLI apply path runs under (#4594):
 * `chant run --components`, `chant components fan-out`, `promote`,
 * `rollback` and `redeploy`. pr-apply, pr-env and op waves read the grain at
 * base themselves and lease the rows their plan knows.
 *
 * The grain is `ci.lockGrain` of the member holding `cwd`, read the way
 * ../workspace/ci-lock-grain.ts reads it: at base when the job has one,
 * else from the working tree. The lease writes the pull-request loop's rows file,
 * `_locks/rows/pr-apply.json`, so a run of these commands and a pull
 * request's apply meet on the same rows (ruling B of #4552).
 */
import { spawnSync } from "node:child_process";
import type { LockGrain } from "../lifecycle/lock-rows";
import { ledgerRowLease, type LedgerRowLeaseOptions, type RowLeasePort } from "./row-lease";

/** What a CLI apply path passes its runner: the declared grain and the lease port, each absent when it has none. */
export interface ApplyLeaseOptions {
  lockGrain?: LockGrain;
  rowLease?: RowLeasePort;
}

/** Whether `cwd` is inside a git work tree, where `chant/lifecycle` can hold rows. */
function inWorkTree(cwd: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

/**
 * The grain and lease for an apply run from `cwd` (#4594). Outside a git
 * work tree there is no ledger to hold rows in, so no lease is taken, as
 * before; the grain is still passed so a lexicon's refusal of it stands.
 * `gate` names the rows file; default `pr-apply`.
 */
export async function applyLeaseOptions(cwd: string, opts: LedgerRowLeaseOptions & { gate?: string; at?: string; member?: string } = {}): Promise<ApplyLeaseOptions> {
  let lockGrain: LockGrain | null = null;
  try {
    const { ciLockGrainAt } = await import("../workspace/ci-lock-grain");
    lockGrain = ciLockGrainAt(cwd, opts.at, opts.member);
  } catch {
    // No declaration to read: each member takes its lexicon's default.
  }
  const { PR_APPLY_GATE } = await import("../pr-loop");
  const { gate = PR_APPLY_GATE, at: _at, member: _member, ...lease } = opts;
  return {
    ...(lockGrain ? { lockGrain } : {}),
    ...(inWorkTree(cwd) ? { rowLease: ledgerRowLease(gate, { cwd, ...lease }) } : {}),
  };
}
