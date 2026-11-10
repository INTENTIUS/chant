/**
 * Op waves before merge (#4984): the record that lets an open pull
 * request's head run the waves.
 *
 * Maintainer decision (2026-11-10): waves before merge. The Op waves
 * workflow gets a before-merge mode. The comment job (GitHub, Forgejo) or
 * the note poll (GitLab) decides `/<product> apply` on an open pull
 * request (./before-merge-decide.ts), writes the decided head here, and
 * starts the waves workflow on the default branch for that head. Each wave
 * job's guard (../ci-job-guard.ts) admits the run only when the head, the
 * pull request and the digest it was started with are the ones recorded
 * here. Per-wave runners, cloud identities and evidence stay as they are.
 *
 * The record is `_waves/<op>.before-merge.json` on `chant/lifecycle`, at the
 * top of the branch whatever the member, so the guard reads it at one path.
 * It keeps one decision per head, the newest {@link BEFORE_MERGE_KEPT}.
 * Each decision's digest is sha256 over its fields in a fixed order
 * ({@link beforeMergeDigest}); the run carries it, and the guard computes
 * it again, so a decision edited by hand after it was made reads as no
 * decision.
 *
 * A run carries the decision in three variables: GitHub and Forgejo map
 * them from the `workflow_dispatch` inputs `pr`, `head` and `digest`; on
 * GitLab they are the variables of the pipeline the poll starts.
 */

import { createHash } from "node:crypto";
import { CHANT_EXIT } from "../exit-codes";

/** The variable a before-merge run carries the pull request in. */
export const BEFORE_MERGE_PR_ENV = "CHANT_BEFORE_MERGE_PR";
/** The variable a before-merge run carries the decided head in. */
export const BEFORE_MERGE_HEAD_ENV = "CHANT_BEFORE_MERGE_HEAD";
/** The variable a before-merge run carries the decision's digest in. */
export const BEFORE_MERGE_DIGEST_ENV = "CHANT_BEFORE_MERGE_DIGEST";

/**
 * The variable a wave job's command reads its base from (#4984): set by the
 * step that checks out the decided head, to the default branch's commit the
 * run started at, so the gate policy, holds and spec render come from the
 * default branch and never from the pull request.
 */
export const WAVES_BASE_ENV = "CHANT_WAVES_BASE";

/** The `workflow_dispatch` inputs of a waves workflow with a before-merge mode, and the variables they map to. */
export const BEFORE_MERGE_INPUTS: Readonly<Record<"pr" | "head" | "digest", string>> = { pr: BEFORE_MERGE_PR_ENV, head: BEFORE_MERGE_HEAD_ENV, digest: BEFORE_MERGE_DIGEST_ENV };

/** The directory of the decisions on `chant/lifecycle`, beside the wave stops. */
export const BEFORE_MERGE_DIR = "_waves";

/** How many heads' decisions the file keeps. */
export const BEFORE_MERGE_KEPT = 50;

/** The decisions file of op `op`. */
export function beforeMergeFile(op: string): string {
  return `${op}.before-merge.json`;
}

/** Its path from the top of `chant/lifecycle`, as the guard reads it. */
export function beforeMergePath(op: string): string {
  return `${BEFORE_MERGE_DIR}/${beforeMergeFile(op)}`;
}

/** One decision: the pull request, the head it decided, the default branch's commit it was measured from, the last wave, who asked and when. */
export interface BeforeMergeDecision {
  pr: number;
  head: string;
  base: string;
  /** The last wave that runs, when the comment named one (`wave-<n>`). */
  through?: number;
  at: string;
  by: string;
}

/** A decision with its digest, as the file keeps it. */
export interface BeforeMergeRecord extends BeforeMergeDecision {
  digest: string;
}

/** The decisions file. */
export interface BeforeMergeFile {
  version: 1;
  heads: Record<string, BeforeMergeRecord>;
}

/** What a run says it was started for. Unset or empty: a push run. */
export interface BeforeMergeRun {
  pr?: string;
  head?: string;
  digest?: string;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OP = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PR = /^[1-9][0-9]{0,9}$/;

/** The words the digest is taken over, in order. The guard's `node -e` program builds the same array. */
export function beforeMergeDigestInput(op: string, d: BeforeMergeDecision): string {
  return JSON.stringify(["chant-before-merge/1", op, d.pr, d.head, d.base, d.through ?? 0, d.at, d.by]);
}

/** sha256 over {@link beforeMergeDigestInput}, as `sha256:<hex>`. */
export function beforeMergeDigest(op: string, d: BeforeMergeDecision): string {
  return `sha256:${createHash("sha256").update(beforeMergeDigestInput(op, d)).digest("hex")}`;
}

/** Read a decisions file; anything that is not one reads as no decisions, and a malformed entry is dropped. */
export function parseBeforeMerge(text: string | null): BeforeMergeFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text ?? "null");
  } catch {
    return { version: 1, heads: {} };
  }
  const heads: Record<string, BeforeMergeRecord> = {};
  const given = doc && typeof doc === "object" && (doc as { version?: unknown }).version === 1 ? (doc as { heads?: unknown }).heads : undefined;
  if (given && typeof given === "object") {
    for (const [head, r] of Object.entries(given as Record<string, unknown>)) {
      const v = r as Partial<BeforeMergeRecord> | null;
      if (!SHA.test(head) || !v || v.head !== head || !Number.isInteger(v.pr) || (v.pr as number) < 1) continue;
      if (typeof v.base !== "string" || !SHA.test(v.base) || typeof v.at !== "string" || typeof v.by !== "string" || typeof v.digest !== "string") continue;
      if (v.through !== undefined && (!Number.isInteger(v.through) || v.through < 1)) continue;
      heads[head] = { pr: v.pr as number, head, base: v.base, ...(v.through !== undefined ? { through: v.through } : {}), at: v.at, by: v.by, digest: v.digest };
    }
  }
  return { version: 1, heads };
}

/** The file's text: the newest {@link BEFORE_MERGE_KEPT} decisions, by head. */
export function renderBeforeMerge(file: BeforeMergeFile): string {
  const newest = Object.entries(file.heads).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, BEFORE_MERGE_KEPT);
  return `${JSON.stringify({ version: 1, heads: Object.fromEntries(newest.sort((a, b) => a[0].localeCompare(b[0]))) }, null, 2)}\n`;
}

/** The run's decision variables from the environment. */
export function beforeMergeRunFromEnv(env: Record<string, string | undefined> = process.env): BeforeMergeRun {
  const v = (k: string): string | undefined => {
    const s = env[k]?.trim();
    return s ? s : undefined;
  };
  const pr = v(BEFORE_MERGE_PR_ENV);
  const head = v(BEFORE_MERGE_HEAD_ENV);
  const digest = v(BEFORE_MERGE_DIGEST_ENV);
  return { ...(pr ? { pr } : {}), ...(head ? { head } : {}), ...(digest ? { digest } : {}) };
}

/** Whether a run names a decision at all: any of the three variables set. */
export function isBeforeMergeRun(run: BeforeMergeRun): boolean {
  return run.pr !== undefined || run.head !== undefined || run.digest !== undefined;
}

const shown = (v: string | undefined): string => (v === undefined || v === "" ? "none" : JSON.stringify(v));

/**
 * What stops a run that names a decision, one line each: a variable that is
 * not what it should be, no decision for the head, a decision for another
 * pull request, another digest, or a decision whose fields no longer give
 * its digest. Empty: the run is the one decided. The guard's `node -e`
 * program gives the same lines.
 */
export function beforeMergeProblems(op: string, run: BeforeMergeRun, record: BeforeMergeRecord | undefined): string[] {
  const p: string[] = [];
  if (!run.pr || !PR.test(run.pr)) p.push(`before merge: the run's pull request ${shown(run.pr)} is not a number`);
  if (!run.head || !SHA.test(run.head)) p.push(`before merge: the run's head ${shown(run.head)} is not a commit sha`);
  if (!run.digest || !DIGEST.test(run.digest)) p.push(`before merge: the run's digest ${shown(run.digest)} is not a sha256 digest`);
  if (p.length > 0) return p;
  const head = run.head!.slice(0, 12);
  if (!record) return [`before merge: no decision on chant/lifecycle names head ${head} of ${op}, so this run applies nothing`];
  if (record.pr !== Number(run.pr)) p.push(`before merge: the decision for head ${head} is pull request ${record.pr}'s, not ${run.pr}'s`);
  if (record.digest !== run.digest) p.push(`before merge: the run carries digest ${run.digest}, and the decision for head ${head} has ${record.digest}`);
  if (beforeMergeDigest(op, record) !== record.digest) p.push(`before merge: the decision for head ${head} was changed after it was made: its fields give another digest`);
  return p;
}

/**
 * The before-merge mode of an Op waves pipeline (#4984),
 * `OpWavesPipelineOptions.beforeMerge`.
 */
export interface OpWavesBeforeMerge {
  /**
   * What the job after the last wave does once every wave applied the
   * decided head. `auto`: it merges the pull request at that head (only
   * while it is still the head, open and approved) and releases the locks
   * the change holds. `manual` (the default): it replies that the head
   * applied, and the locks hold until the pull request merges or closes.
   */
  merge?: "auto" | "manual";
  /**
   * The secret (GitHub, Forgejo) or CI/CD variable (GitLab) the merge takes
   * its token from, with `merge: "auto"`. GitHub merges with the job's own
   * token when it is absent. Forgejo refuses a merge made with the job's
   * own token, and GitLab's job token cannot merge, so both need it.
   */
  mergeTokenSecret?: string;
  /** The lock file the change's locks are in, `_locks/<gate>.json`, which `merge: "auto"` releases. Default the pull request loop's. */
  gate?: string;
}

/** The job after the last wave of a before-merge run (#4984). */
export const BEFORE_MERGE_DONE_JOB = "before-merge-done";

/** The variable the done job hands the merge token to `--merge-token-env` in. */
export const BEFORE_MERGE_TOKEN_ENV = "CHANT_MERGE_TOKEN";

/** Check the mode's options for `forge`; throws with the reason. */
export function assertOpWavesBeforeMerge(forge: "github" | "forgejo" | "gitlab", bm: OpWavesBeforeMerge): void {
  if (bm.merge !== undefined && bm.merge !== "auto" && bm.merge !== "manual") throw new Error(`beforeMerge.merge is auto or manual, not ${JSON.stringify(bm.merge)}`);
  if (bm.mergeTokenSecret !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bm.mergeTokenSecret)) throw new Error(`beforeMerge.mergeTokenSecret ${JSON.stringify(bm.mergeTokenSecret)} is not a variable name`);
  if (bm.gate !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(bm.gate)) throw new Error(`beforeMerge.gate ${JSON.stringify(bm.gate)} is not a lock file name`);
  if (bm.merge === "auto" && forge !== "github" && !bm.mergeTokenSecret) {
    throw new Error(`beforeMerge.merge auto on ${forge} needs mergeTokenSecret: ${forge === "forgejo" ? "Forgejo refuses a merge made with the job's own token" : "GitLab's job token cannot merge"}`);
  }
}

/**
 * The done job's command, through the product's bin: `chant run wave --op
 * <op> --wave <last wave> --merge auto|manual --forge <forge>`. It names the
 * op and the wave count rather than the spec file, which a spec rendered at
 * run time (#4982) leaves uncommitted.
 */
export function beforeMergeDoneCommand(spec: { name: string; waves: readonly unknown[] }, forge: "github" | "forgejo" | "gitlab", bm: OpWavesBeforeMerge, bin?: string): string {
  const words = (bin ?? "").split(/\s+/).filter(Boolean);
  return [
    ...(words.length > 0 ? words : ["chant"]),
    "run", "wave", "--op", spec.name, "--wave", String(spec.waves.length),
    "--merge", bm.merge ?? "manual",
    "--forge", forge,
    ...(bm.gate ? ["--gate", bm.gate] : []),
    ...(bm.merge === "auto" && bm.mergeTokenSecret ? ["--merge-token-env", BEFORE_MERGE_TOKEN_ENV] : []),
  ].join(" ");
}

/**
 * The lines that check out the decided head (#4984), right after the
 * default branch's checkout and before any of the change's code: nothing
 * on a push run; else fetch the pull request's head ref, stop (exit 9,
 * chant's `misplaced`) unless it is still the decided head, keep the
 * default branch's commit as {@link WAVES_BASE_ENV} for the command, and
 * check the head out. One shell block, so on GitLab it sits among the
 * script's lines.
 */
export function beforeMergeCheckoutScript(forge: "github" | "forgejo" | "gitlab", product: string): string {
  const ref = forge === "gitlab" ? `refs/merge-requests/\${${BEFORE_MERGE_PR_ENV}}/head` : `refs/pull/\${${BEFORE_MERGE_PR_ENV}}/head`;
  const what = forge === "gitlab" ? `!$${BEFORE_MERGE_PR_ENV}` : `pull request $${BEFORE_MERGE_PR_ENV}`;
  const keep = forge === "gitlab" ? `${WAVES_BASE_ENV}="$(git rev-parse HEAD)"; export ${WAVES_BASE_ENV}` : `echo "${WAVES_BASE_ENV}=$(git rev-parse HEAD)" >> "$GITHUB_ENV"`;
  return [
    `if [ -n "\${${BEFORE_MERGE_HEAD_ENV}:-}" ]; then`,
    `  git fetch -q --no-tags origin "+${ref}:refs/remotes/chant/before-merge-head" || { echo "${product}: could not fetch the head of ${what}" >&2; exit 1; }`,
    '  now="$(git rev-parse refs/remotes/chant/before-merge-head)"',
    `  if [ "$now" != "$${BEFORE_MERGE_HEAD_ENV}" ]; then echo "${product}: ${what} moved to $(printf %.12s "$now") after its head $(printf %.12s "$${BEFORE_MERGE_HEAD_ENV}") was decided, so nothing is applied; comment the apply again" >&2; exit ${CHANT_EXIT.misplaced}; fi`,
    `  ${keep}`,
    `  git checkout -q --detach "$${BEFORE_MERGE_HEAD_ENV}" || exit 1`,
    "fi",
  ].join("\n");
}

/** Whether `op` names a decisions file and `sha` a commit. */
export function beforeMergeKeyProblem(op: string, sha: string): string | undefined {
  if (!OP.test(op)) return `the op name ${JSON.stringify(op)} is not a decisions file name`;
  if (!SHA.test(sha)) return `${JSON.stringify(sha)} is not a commit sha`;
  return undefined;
}
