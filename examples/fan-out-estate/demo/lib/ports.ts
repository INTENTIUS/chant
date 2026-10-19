/**
 * The three things the fan-out demo's cycle talks to, as small interfaces:
 * the forge (Forgejo's REST API and git), the bucket (floci's S3, where the
 * step, the cycles and chant's reports live) and chant (`chant approve` from
 * the reviewer's clone, and the base applied again with `chant run`). The
 * real ones are in forgejo.ts, bucket.ts and chant.ts; the tests pass fakes.
 */

/** Forgejo, as the author, the reviewer and the admin. */
export interface Forge {
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
  /** The branches of the demo repo, by name. */
  branches(): Promise<string[]>;
  /** Delete a branch of the demo repo. A branch that is gone already is not an error. */
  deleteBranch(name: string): Promise<void>;
}

/** The demo's bucket, keys below the bucket's root. */
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
  /** The base's templates built and applied with `chant run --components all --env demo`. */
  applyBase(): Promise<void>;
}

/** Time, so a test runs a cycle without waiting. */
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
