/**
 * What the e2e harness's driver talks to, as small interfaces (chant#4587),
 * factored from the fan-out demo's lib/ports.ts: the forge, the bucket where
 * chant's reports land, chant run outside the pipeline, the ledger, and time.
 * The real ones are ./forgejo.ts and ./bucket.ts; tests pass fakes.
 */
import type { OpRunRecord } from "../op/runtime";

/** A forge repository as the author, the reviewer and the admin: the pull request loop. */
export interface PullForge {
  /**
   * As the author: clone main, write `files` over it (paths relative to the
   * repo root), commit and push to `branch`. Returns the pushed head sha.
   */
  pushBranch(branch: string, files: Record<string, string>, message: string): Promise<string>;
  /** As the author: open a pull request from `branch` into main. Returns its number. */
  openPull(branch: string, title: string, body: string): Promise<number>;
  /** As the reviewer: an APPROVED review of the pull request. */
  approvePull(pull: number, body: string): Promise<void>;
  /** As the author: merge the pull request. Returns the merge commit's sha. */
  mergePull(pull: number): Promise<string>;
  /** The numbers of the repo's open pull requests. */
  openPulls(): Promise<number[]>;
  closePull(pull: number): Promise<void>;
  /** As the admin: force main to `sha`. */
  forceMain(sha: string): Promise<void>;
  /** The repo's branches, by name. */
  branches(): Promise<string[]>;
  /** Delete a branch. A branch that is gone already is not an error. */
  deleteBranch(name: string): Promise<void>;
}

/** A finished workflow run on the forge. */
export interface ForgeRun {
  ok: boolean;
  /** The forge's word for how it ended (success, failure, cancelled, ...). */
  status: string;
  /** The forge's id of the run. */
  id?: number;
  /** The names of the jobs that did not succeed, where the forge says. */
  failed?: string[];
}

export interface ForgeIssue {
  number: number;
  title: string;
  body: string;
  open: boolean;
}

/**
 * sql-yodeler's Forge verbs (scenarios/forges/forge.ts:26-61) that the pull
 * request loop lacks. `openPr` and `merge` there are `openPull` and
 * `mergePull` here. A run's outcome is read from chant's reports and ledger,
 * so a run carries its status and no log.
 */
export interface ForgeReads {
  /** The bodies of a pull request's comments, oldest first. */
  comments(pull: number): Promise<string[]>;
  /** The repository's issues, open and closed, without pull requests. */
  issues(): Promise<ForgeIssue[]>;
}

export interface ForgeRuns {
  /** The apply again, started by hand on main at `sha` (workflow dispatch of `workflow`). */
  applyAgain(sha: string, workflow: string): Promise<ForgeRun>;
  /** A scheduled workflow (the drift watch) run by hand on main at `sha`, waited for. */
  watch(sha: string, workflow: string): Promise<ForgeRun>;
}

/** The jobs the forge's runner is running, for the kill-job step. */
export interface Jobs {
  /** Kill the newest running job whose name holds `match` (any job when absent). Resolves with whether one was running. */
  kill(match?: string): Promise<boolean>;
}

/** Everything the harness asks of a forge. */
export type HarnessForge = PullForge & ForgeReads & ForgeRuns;

/** A bucket, keys below its root. */
export interface Bucket {
  /** The object's text, or null when there is none. */
  get(key: string): Promise<string | null>;
  put(key: string, body: string, contentType: string): Promise<void>;
  /** Every key that starts with `prefix`. */
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** The plan a reviewer approves, as pr-plan.json names it. */
export interface ApproveInput {
  pull: number;
  op: string;
  gate: string;
  digest: string;
  approver: string;
}

/** chant, run by the driver outside the pipeline. */
export interface Chant {
  /** `chant approve <op> <gate> --plan <digest> --approver <approver> --sign <key>` from the reviewer's clone. */
  approve(input: ApproveInput): Promise<void>;
  /** The base's templates built and applied outside the pipeline. */
  applyBase(): Promise<void>;
}

/** The run ledger of the scenario's repo (`chant/lifecycle`), read. */
export interface Ledger {
  runs(env: string, op: string): Promise<OpRunRecord[]>;
}

/** Work outside the forge and chant: a change made out of band. */
export interface OutOfBand {
  /** Run `command` with the no-real-cloud environment. Resolves with its exit code. */
  run(command: string[]): Promise<number>;
}

/** Time, so a test runs a scenario without waiting. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A log line for the person running the driver. */
export type Log = (line: string) => void;
