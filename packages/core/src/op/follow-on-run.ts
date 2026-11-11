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
 *
 * #4998: before it starts a follow-on, the record job records it on
 * `chant/lifecycle`, at {@link followOnPath}: one entry per chain, keyed by
 * the decided head (before merge) or the pushed commit, naming the wave it
 * started, the run that started it, the decision or the commit, and the
 * outcomes of every run of the chain so far. Each follow-on replaces the
 * entry, so it names the wave the newest record job started. The guard
 * admits a follow-on only for that wave ({@link followOnRecordProblems}),
 * so a wave started by hand past it, or an earlier wave run again after
 * the chain went on, is refused.
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

/** The directory of the follow-on records on `chant/lifecycle` (#4998): beside the before-merge decisions, `_waves`. */
export const FOLLOW_ON_DIR = "_waves";

/** How many chains' records the file keeps. */
export const FOLLOW_ON_KEPT = 50;

/** The follow-on records file of op `op`. */
export function followOnFile(op: string): string {
  return `${op}.follow-on.json`;
}

/** Its path from the top of `chant/lifecycle`, as the guard reads it. */
export function followOnPath(op: string): string {
  return `${FOLLOW_ON_DIR}/${followOnFile(op)}`;
}

/** One run's outcome as a chain carries it: a wave outcome file's member, with the wave and the time it was written. */
export interface FollowOnOutcome {
  status: string;
  by?: string;
  wave: number;
  at: string;
}

/** The record of the newest follow-on of one chain (#4998). */
export interface FollowOnRecord {
  /** The decided head a before-merge chain applies, or the commit a push's chain goes on with. */
  key: string;
  /** The wave of the follow-on the record job started. */
  wave: number;
  /** The wave the run that started it ran. */
  from: number;
  /** The id of the run that started it (GitHub and Forgejo `GITHUB_RUN_ID`, GitLab `CI_PIPELINE_ID`). */
  run: string;
  /** That run's page, when the forge names it. */
  url?: string;
  /** When the record job wrote it, ISO 8601. */
  at: string;
  /** Before merge: the decision's pull request and digest. */
  pr?: number;
  digest?: string;
  /** A push's chain: the pushed commit, the same as `key`. */
  commit?: string;
  /** Every run's outcomes so far, by member: the newest of each. */
  outcomes: Record<string, FollowOnOutcome>;
}

/** Where the rest wave's record job reads and writes a chain's record (./follow-on-store.ts: `chant/lifecycle`, or memory). */
export interface FollowOnChainPort {
  /** The record of the chain keyed `key`, as the remote has it; undefined when there is none. */
  read(op: string, key: string): Promise<FollowOnRecord | undefined>;
  /** Replace the chain's record and push it, so the follow-on's guard reads it. */
  write(op: string, record: FollowOnRecord): Promise<void>;
}

/** The follow-on records file: one entry per chain, by its key. */
export interface FollowOnFile {
  version: 1;
  chains: Record<string, FollowOnRecord>;
}

const isWhole = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min;

/**
 * Read a follow-on records file; anything that is not one reads as no
 * records, a malformed entry is dropped, and so is a malformed outcome. The
 * guard's `node -e` program checks an entry the same way.
 */
export function parseFollowOn(text: string | null): FollowOnFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text ?? "null");
  } catch {
    return { version: 1, chains: {} };
  }
  const chains: Record<string, FollowOnRecord> = {};
  const given = doc && typeof doc === "object" && (doc as { version?: unknown }).version === 1 ? (doc as { chains?: unknown }).chains : undefined;
  if (given && typeof given === "object") {
    for (const [key, r] of Object.entries(given as Record<string, unknown>)) {
      const v = r as Partial<FollowOnRecord> | null;
      if (!SHA.test(key) || !v || typeof v !== "object" || v.key !== key || !isWhole(v.wave, 2) || !isWhole(v.from, 1) || typeof v.run !== "string" || typeof v.at !== "string") continue;
      if ((v.digest !== undefined && typeof v.digest !== "string") || (v.pr !== undefined && !isWhole(v.pr, 1)) || (v.commit !== undefined && (typeof v.commit !== "string" || !SHA.test(v.commit)))) continue;
      if (!v.outcomes || typeof v.outcomes !== "object") continue;
      const outcomes: Record<string, FollowOnOutcome> = {};
      for (const [member, o] of Object.entries(v.outcomes as Record<string, Partial<FollowOnOutcome> | null>)) {
        if (!o || typeof o.status !== "string" || !isWhole(o.wave, 1) || typeof o.at !== "string" || (o.by !== undefined && typeof o.by !== "string")) continue;
        outcomes[member] = { status: o.status, ...(o.by !== undefined ? { by: o.by } : {}), wave: o.wave, at: o.at };
      }
      chains[key] = {
        key,
        wave: v.wave,
        from: v.from,
        run: v.run,
        ...(typeof v.url === "string" ? { url: v.url } : {}),
        at: v.at,
        ...(v.pr !== undefined ? { pr: v.pr } : {}),
        ...(v.digest !== undefined ? { digest: v.digest } : {}),
        ...(v.commit !== undefined ? { commit: v.commit } : {}),
        outcomes,
      };
    }
  }
  return { version: 1, chains };
}

/** The file's text: the newest {@link FOLLOW_ON_KEPT} chains, by key. */
export function renderFollowOn(file: FollowOnFile): string {
  const newest = Object.entries(file.chains).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, FOLLOW_ON_KEPT);
  return `${JSON.stringify({ version: 1, chains: Object.fromEntries(newest.sort((a, b) => a[0].localeCompare(b[0]))) }, null, 2)}\n`;
}

/**
 * What stops a follow-on run (#4998) that {@link followOnProblems} let
 * through, one line each: no record for its chain, a record that started
 * another wave, or, before merge, one started for another decision. `key`
 * is the run's decided head, or a push's commit; `digest` the run's
 * decision digest before merge. Empty: the newest record job of the chain
 * started this wave. The guard's `node -e` program gives the same lines.
 */
export function followOnRecordProblems(op: string, wave: string, key: string, digest: string | undefined, record: FollowOnRecord | null | undefined): string[] {
  const what = digest !== undefined ? "head" : "commit";
  const short = key.slice(0, 12);
  if (!record) return [`follow-on: no record job of ${op} started a follow-on for ${what} ${short}, so this run applies nothing`];
  const p: string[] = [];
  if (String(record.wave) !== wave) p.push(`follow-on: the newest record job of ${op} for ${what} ${short} started wave ${record.wave}, and this run names wave ${wave}`);
  if (digest !== undefined && record.digest !== digest) p.push(`follow-on: wave ${record.wave} of ${what} ${short} was started for the decision with digest ${record.digest ?? "none"}, and the run carries ${digest}`);
  return p;
}
