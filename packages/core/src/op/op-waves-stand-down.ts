/**
 * Stand-down for op waves (#4581): an apply that a newer commit on the
 * branch will make anyway steps aside, exit 6 (`CHANT_EXIT.superseded`),
 * instead of applying a commit the branch has already moved past.
 *
 * sql-yodeler (`src/versioned/stand-down.ts`, `YODEL_STAND_DOWN`) and
 * terragucci (`packages/terragucci/src/apply.ts`, `newerPush`) each carry a
 * copy of this; core does it once, for every wave whose spec sets
 * `standDown: true`, so both can drop theirs behind a feature-detect.
 *
 * The branch is the one the run is for: `GITHUB_REF_NAME` (GitHub and
 * Forgejo Actions), `CI_COMMIT_BRANCH` (GitLab CI), else the checked-out
 * branch. Its tip is fetched from `origin`. When that tip is a different
 * commit that contains this one, a newer commit is on the branch. Anything
 * that cannot be told (no branch, no origin, a fetch that fails, a tip that
 * does not contain this commit, as after a force-push) is no newer commit,
 * and the apply goes ahead.
 *
 * A newer commit makes the apply stand down only when its own pipeline will
 * apply every target this job applies: the spec file at the tip still runs
 * on the branch and has a wave of this one's name listing each of them (a
 * `discover` wave finds its runs itself, so it covers any target). A tip
 * whose spec is gone, cannot be read, or drops a target leaves the apply
 * to go ahead.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpWavesSpec } from "./op-waves";

const exec = promisify(execFile);

/**
 * The first chant whose op waves stand down themselves (#4581). A product
 * that keeps its own stand-down for an older chant checks this, or the
 * export of {@link newerCommitOnBranch} from `@intentius/chant/op`, before
 * it drops its copy.
 */
export const OP_WAVE_STAND_DOWN_FLOOR = "0.124.55";

/** A newer commit on the run's branch. */
export interface OpWaveNewerCommit {
  branch: string;
  /** This run's commit. */
  head: string;
  /** The branch's tip on origin, which contains `head`. */
  tip: string;
}

/** How a wave job finds a newer commit on its branch. Tests pass their own. */
export type OpWaveNewerCommitPort = (cwd: string, head?: string) => Promise<OpWaveNewerCommit | undefined>;

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 60_000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** The branch a run is for; see the module comment. */
export async function opWaveRunBranch(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const named = env.GITHUB_REF_NAME || env.CI_COMMIT_BRANCH;
  if (named) return named;
  return (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || undefined;
}

/**
 * The newer commit on the run's branch, or undefined when there is none or
 * it cannot be told. `head` is this run's commit; default `git rev-parse HEAD`.
 */
export async function newerCommitOnBranch(cwd: string, env: NodeJS.ProcessEnv = process.env, head?: string): Promise<OpWaveNewerCommit | undefined> {
  const branch = await opWaveRunBranch(cwd, env);
  if (!branch) return undefined;
  const at = head ?? (await git(cwd, ["rev-parse", "HEAD"]));
  if (!at) return undefined;
  if ((await git(cwd, ["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${branch}`])) === undefined) return undefined;
  const tip = await git(cwd, ["rev-parse", "FETCH_HEAD"]);
  if (!tip || tip === at) return undefined;
  // A tip that contains this commit is newer; one that does not (a force-push, another line) is not.
  if ((await git(cwd, ["merge-base", "--is-ancestor", at, tip])) === undefined) return undefined;
  return { branch, head: at, tip };
}

/** The default port: {@link newerCommitOnBranch} with the job's environment. */
export const gitOpWaveNewerCommit: OpWaveNewerCommitPort = (cwd, head) => newerCommitOnBranch(cwd, process.env, head);

/**
 * Whether the spec at the newer commit (`atTip`, null when the file is gone
 * there) applies every one of `targets` in wave `waveName` on `branch`.
 */
export function tipAppliesTargets(atTip: OpWavesSpec | null, branch: string, waveName: string, targets: readonly string[]): boolean {
  if (!atTip || !Array.isArray(atTip.waves)) return false;
  if (!(atTip.branches ?? ["main"]).includes(branch)) return false;
  const wave = atTip.waves.find((w) => w?.name === waveName);
  if (!wave) return false;
  if (wave.discover === true) return true;
  const listed = new Set((wave.runs ?? []).map((r) => r?.target));
  return targets.every((t) => listed.has(t));
}

/** What a wave that stands down logs and records as its reason. */
export function opWaveStandDownReason(n: OpWaveNewerCommit, targets: readonly string[]): string {
  const what = targets.length === 1 ? targets[0]! : `${targets.length} targets (${targets.join(", ")})`;
  return `${n.branch} on origin is at ${n.tip.slice(0, 12)}, newer than this run's ${n.head.slice(0, 12)}, and its own wave applies ${what}`;
}
