/**
 * git for the driver, with one guard: every git command runs in a directory
 * whose own `.git` is the repository, outside the chant checkout. A clone that
 * failed would otherwise leave git to find the checkout's repository above
 * it, and the driver would push or approve there. The demo only ever writes
 * to its own forge repo. The guard is the e2e harness's (chant#4587), bound
 * to this checkout.
 */
import { resolve } from "node:path";
import {
  assertOwnRepo as harnessAssertOwnRepo,
  freshDir as harnessFreshDir,
  guardedGit,
  insideCheckout as harnessInsideCheckout,
} from "../../../../packages/core/src/e2e-harness/git.js";

export { remoteWith, run, type RunResult } from "../../../../packages/core/src/e2e-harness/git.js";

/** The chant checkout this file is in. */
export const CHECKOUT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** Whether `dir` is the checkout or below it. */
export function insideCheckout(dir: string, checkout: string = CHECKOUT): boolean {
  return harnessInsideCheckout(dir, checkout);
}

/** Refuse a directory that is in the checkout or has no `.git` of its own. */
export function assertOwnRepo(dir: string): void {
  harnessAssertOwnRepo(dir, CHECKOUT);
}

/** A new empty directory for a clone, under the system temp dir. */
export function freshDir(name: string): string {
  return harnessFreshDir(name, "chant-fan-out-demo");
}

const guarded = guardedGit(CHECKOUT, "chant-fan-out-demo");

/** git in `dir`, which must be its own repository outside the checkout. */
export const git = (dir: string, args: string[], redact: string[] = []): Promise<string> => guarded.git(dir, args, redact);

/** Clone `remote` into a fresh directory outside the checkout. */
export const clone = (remote: string, name: string, redact: string[] = []): Promise<string> => guarded.clone(remote, name, redact);
