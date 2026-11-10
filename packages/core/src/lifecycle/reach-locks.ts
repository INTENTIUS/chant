/**
 * Locks on what a change reaches (#4979): `chant lock --reach`.
 *
 * A pull request's plan locks (`ci.locks: plan`, #4293) come from what its
 * plan selected, which the plan job, running the change's code, wrote. A
 * product that knows from the change's files alone which of its targets a
 * change reaches, such as terragucci's roots, units and instances, gives a
 * reach line instead: one shell line, written in the pipeline at the target
 * branch's commit, that prints the targets the change from `$BASE_SHA` to
 * `$HEAD_SHA` reaches, one a line. It reads the change as data from git
 * (`git diff`, `git show <sha>:<path>`) and runs none of its code.
 *
 * The lock job runs it in a checkout of the target branch's commit. chant
 * first fetches the pull request's head from the forge (`refs/pull/<n>/head`,
 * GitLab's `refs/merge-requests/<n>/head`) and checks it is still the commit
 * the job was started for: a head that moved is left to the run of the push
 * that moved it. The line's variables are `BASE_SHA`, `HEAD_SHA` and
 * `PR_NUMBER`; it holds the job's environment, and the line is the
 * pipeline's, so none of the change's code runs with the job's token.
 *
 * On GitLab a merge request's pipeline is built from the merge request's own
 * files, so its lock job runs in the target branch's plan notes pipeline and
 * locks every open merge request from the project (`--open`), and releases
 * the locks of a merge request that is no longer open.
 */

import { spawnSync } from "node:child_process";
import type { ForgeKind } from "../pr-forge";

/** The variable the reach line is in: the pipeline's, set as the step's variable so no shell quoting carries it (#4979). */
export const LOCK_REACH_ENV = "CHANT_LOCK_REACH";

/** Where chant fetches the pull request's head to before the reach line runs (#4979). */
export const REACH_HEAD_REF = "refs/remotes/chant/pull-request-head";

/** A target name a reach line may print: no control characters, at most 512 characters. */
const TARGET_LINE = /^[^\u0000-\u001f\u007f]{1,512}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The forge's ref for pull request `pr`'s head. */
export function pullRequestHeadRef(forge: ForgeKind, pr: number): string {
  return forge === "gitlab" ? `refs/merge-requests/${pr}/head` : `refs/pull/${pr}/head`;
}

/** A process run, as `spawnSync` answers it. */
export type ReachRun = (argv: string[], o: { cwd?: string; env?: Record<string, string | undefined> }) => { status: number | null; stdout: string; stderr: string };

const defaultRun: ReachRun = (argv, o) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.env ? { env: o.env as NodeJS.ProcessEnv } : {}) });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : (r.stderr ?? "") };
};

/** What {@link reachedTargets} takes. */
export interface ReachInput {
  forge: ForgeKind;
  pr: number;
  /** The head the job was started for. */
  head: string;
  /** The target branch's commit the change is measured from. */
  base: string;
  /** The reach line. */
  line: string;
  cwd?: string;
  /** The line's environment, to which `BASE_SHA`, `HEAD_SHA` and `PR_NUMBER` are added. Default the process's. */
  env?: Record<string, string | undefined>;
  run?: ReachRun;
}

/** The targets a change reaches, sorted; or that its head moved; or why the line could not say. */
export type Reached = { targets: string[] } | { moved: string } | { error: string };

/**
 * The targets the change of pull request `pr` reaches (#4979): fetch its
 * head, check it is `head`, and run the reach line. Blank lines are left
 * out; a line holding a control character fails the read, so a target name
 * never carries one into the lock file.
 */
export function reachedTargets(i: ReachInput): Reached {
  const run = i.run ?? defaultRun;
  const name = i.forge === "gitlab" ? `merge request !${i.pr}` : `pull request ${i.pr}`;
  if (!SHA.test(i.head)) return { error: `--head ${JSON.stringify(i.head)} is not a commit sha` };
  if (!SHA.test(i.base)) return { error: `--base ${JSON.stringify(i.base)} is not a commit sha` };
  if (!i.line.trim()) return { error: `the reach line in ${LOCK_REACH_ENV} is empty` };
  const fetched = run(["git", "fetch", "-q", "--no-tags", "origin", `+${pullRequestHeadRef(i.forge, i.pr)}:${REACH_HEAD_REF}`], { ...(i.cwd ? { cwd: i.cwd } : {}) });
  if (fetched.status !== 0) return { error: `could not fetch ${name}'s head (${fetched.stderr.trim() || `git exited ${fetched.status}`})` };
  const now = run(["git", "rev-parse", REACH_HEAD_REF], { ...(i.cwd ? { cwd: i.cwd } : {}) }).stdout.trim();
  if (now !== i.head) return { moved: `${name} moved to ${now.slice(0, 12) || "another commit"} after ${i.head.slice(0, 12)}, so the run of that push locks it` };
  const env = { ...(i.env ?? process.env), BASE_SHA: i.base, HEAD_SHA: i.head, PR_NUMBER: String(i.pr) };
  const out = run(["sh", "-c", i.line], { ...(i.cwd ? { cwd: i.cwd } : {}), env });
  if (out.status !== 0) return { error: `the reach line exited ${out.status ?? "on a signal"}${out.stderr.trim() ? `: ${out.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}` };
  const targets = new Set<string>();
  for (const raw of out.stdout.split("\n")) {
    const t = raw.trim();
    if (t === "") continue;
    if (!TARGET_LINE.test(t)) return { error: `the reach line printed ${JSON.stringify(t.slice(0, 80))}, which is not a target name: one a line, no control characters, at most 512 characters` };
    targets.add(t);
  }
  return { targets: [...targets].sort() };
}

/** One open pull request as {@link reachOpen} locks it. */
export interface ReachOpenPull {
  number: number;
  headSha: string;
  base: string;
  fork: boolean;
}

/** What one open pull request's lock came to. */
export type ReachOpenOutcome =
  | { pr: number; kind: "locked"; targets: string[]; released: string[] }
  | { pr: number; kind: "held"; text: string }
  | { pr: number; kind: "skipped"; text: string }
  | { pr: number; kind: "failed"; text: string };

/** What {@link reachOpen} takes besides the reach input of each pull request. */
export interface ReachOpenInput extends Omit<ReachInput, "pr" | "head"> {
  /** The branch the pull requests merge into. */
  branch: string;
  open: readonly ReachOpenPull[];
  /** Take the locks of one pull request; `held` names what another holds. */
  take(pr: number, head: string, targets: string[]): Promise<{ ok: true; released: string[] } | { ok: false; held: string }>;
  /** The pull requests that hold a lock now. */
  holders(): Promise<number[]>;
  /** Whether a holder outside the open list is open still (one that merges into another branch). */
  isOpen(pr: number): Promise<boolean>;
  /** Release every lock of a pull request that is no longer open. */
  release(pr: number): Promise<string[]>;
}

/**
 * `chant lock --reach --open` (#4979), GitLab's lock job in the target
 * branch's plan notes pipeline: lock what each open merge request from the
 * project that merges into `branch` reaches, then release the locks of every
 * holder that is not open any more. A fork's merge request takes no lock.
 */
export async function reachOpen(i: ReachOpenInput): Promise<{ outcomes: ReachOpenOutcome[]; released: Array<{ pr: number; targets: string[] }> }> {
  const outcomes: ReachOpenOutcome[] = [];
  const open = new Set<number>();
  for (const p of i.open) {
    open.add(p.number);
    if (p.fork) {
      outcomes.push({ pr: p.number, kind: "skipped", text: `!${p.number} comes from a fork, so it takes no lock` });
      continue;
    }
    if (p.base !== i.branch) {
      outcomes.push({ pr: p.number, kind: "skipped", text: `!${p.number} merges into ${p.base}, not ${i.branch}` });
      continue;
    }
    const r = reachedTargets({ ...i, pr: p.number, head: p.headSha });
    if ("error" in r) {
      outcomes.push({ pr: p.number, kind: "failed", text: r.error });
      continue;
    }
    if ("moved" in r) {
      outcomes.push({ pr: p.number, kind: "skipped", text: r.moved });
      continue;
    }
    const took = await i.take(p.number, p.headSha, r.targets);
    outcomes.push(took.ok ? { pr: p.number, kind: "locked", targets: r.targets, released: took.released } : { pr: p.number, kind: "held", text: took.held });
  }
  const released: Array<{ pr: number; targets: string[] }> = [];
  for (const pr of await i.holders()) {
    if (open.has(pr) || (await i.isOpen(pr))) continue;
    const targets = await i.release(pr);
    if (targets.length > 0) released.push({ pr, targets });
  }
  return { outcomes, released };
}
