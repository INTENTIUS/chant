/**
 * What a follow-on run of a `rest` wave carries (#4992), kept free of
 * imports so the job guard (../ci-job-guard.ts) reads it without the waves
 * runner.
 *
 * Maintainer decision (2026-11-10): before merge a `rest` wave's waves run
 * one per run. The record job of the last rendered wave, when the plan found
 * another wave, starts the waves workflow again for it (./op-waves-follow-on.ts).
 * The new run carries the wave in {@link OP_WAVES_WAVE_ENV}, beside the
 * before-merge decision's three variables (./before-merge.ts), or, for a
 * push's run, the pushed commit in {@link OP_WAVES_COMMIT_ENV}. The rest
 * wave's jobs default the wave to their own number, so a run that is no
 * follow-on reads the same; the jobs of the waves before it do not run.
 */

/** The wave the rest wave's jobs run: their own number, or a later one in a follow-on run. */
export const OP_WAVES_WAVE_ENV = "CHANT_WAVES_WAVE";

/** The commit a push's follow-on run goes on with: the pushed commit the first run applied. */
export const OP_WAVES_COMMIT_ENV = "CHANT_WAVES_COMMIT";

/** The `workflow_dispatch` inputs a follow-on adds (GitHub, Forgejo), and the variables they map to. */
export const FOLLOW_ON_INPUTS: Readonly<Record<"wave" | "commit", string>> = { wave: OP_WAVES_WAVE_ENV, commit: OP_WAVES_COMMIT_ENV };

/** What a run says about a follow-on, from its variables. Unset or empty: none. */
export interface FollowOnRun {
  wave?: string;
  commit?: string;
}

/** The run's follow-on variables from the environment. */
export function followOnRunFromEnv(env: Record<string, string | undefined> = process.env): FollowOnRun {
  const wave = env[OP_WAVES_WAVE_ENV]?.trim();
  const commit = env[OP_WAVES_COMMIT_ENV]?.trim();
  return { ...(wave ? { wave } : {}), ...(commit ? { commit } : {}) };
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const WAVE = /^[1-9][0-9]{0,5}$/;

/**
 * What stops a job that sees follow-on variables, one line each, and what
 * it checked. `rest` is the rest wave's number when the job is one of its
 * jobs. A job of the rest wave reads its own number when the run is no
 * follow-on. A follow-on's wave comes after the rest wave's; a follow-on of
 * a decided head carries no commit (the head is what it checks out), and a
 * push's names the commit. The job guard's `node -e` program gives the same
 * lines.
 */
export function followOnProblems(rest: number | undefined, run: FollowOnRun, beforeMerge: boolean): { problems: string[]; checked?: string } {
  const { wave, commit } = run;
  if (rest === undefined) {
    if (wave === undefined && commit === undefined) return { problems: [] };
    return { problems: [`follow-on: the run names wave ${wave ?? "none"} and commit ${commit ?? "none"}, and this job is none of the rest wave's, which alone runs in a follow-on`] };
  }
  if (wave === undefined || wave === String(rest)) {
    if (commit === undefined) return { problems: [] };
    return { problems: [`follow-on: the run names the commit ${commit} and no wave after wave ${rest}, so it is no follow-on`] };
  }
  if (!WAVE.test(wave) || Number(wave) <= rest) return { problems: [`follow-on: the run's wave ${JSON.stringify(wave)} is no wave after wave ${rest}`] };
  if (beforeMerge) {
    if (commit !== undefined) return { problems: [`follow-on: a follow-on of a decided head checks out that head, and the run names the commit ${commit} too`] };
    return { problems: [], checked: `follow-on wave ${wave}` };
  }
  if (commit === undefined || !SHA.test(commit)) return { problems: [`follow-on: a push's follow-on names the commit it goes on with, and the run's ${commit === undefined ? "none" : JSON.stringify(commit)} is not a commit sha`] };
  return { problems: [], checked: `follow-on wave ${wave} at ${commit.slice(0, 12)}` };
}
