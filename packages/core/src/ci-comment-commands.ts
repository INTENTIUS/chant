/**
 * The comment job on GitHub and Forgejo (#4946): one job that reads every
 * `/<product>` comment and answers the ones no other job of the pipeline
 * takes, the GitHub and Forgejo half of what the GitLab note poll does
 * (./ci-note-commands.ts). Moved from terragucci's `decideComment` and
 * `decideApplyComment` (comment.ts, comment-apply.ts).
 *
 * GitHub and Forgejo start a workflow on the comment itself, so each job
 * that answers a command (the re-plan, the comment lock and unlock, the
 * action job, the agent, the commit jobs, the apply before merge) starts on
 * its own comment, and this job leaves those comments alone. It answers the
 * rest:
 *
 * - a comment the grammar refuses (`parseProductComment` with
 *   `leaveCommit`, so a commit word stays the commit job's), with the
 *   grammar's reason, an alias's product reason among them
 *   (`CiProductAlias.refuse`);
 * - a command no job runs (`plan`, `apply`, `lock`, `unlock`, `action`,
 *   `agent`), with the words' reply for it (`words.replies`) or chant's;
 * - with `applyOnMerge`, `/<product> apply` on a merged pull request: the
 *   newest push run at its merge commit that has an apply job is started
 *   again, unless a later commit of the default branch already carries the
 *   product's apply status. On GitHub the run's failed jobs run again
 *   (`rerun-failed-jobs`), each wave behind its own gate. Forgejo has no
 *   call that runs a run again, so the waves workflow is dispatched on the
 *   default branch, and only while the merge commit is still the branch's
 *   newest push. A forge re-run cannot stop the waves after one, so with
 *   the waves' op (`jobs.waves`, #4979) a `wave-<n>` writes a stop for the
 *   merge commit on `chant/lifecycle` before the run starts, and the waves
 *   after n wait (./op/wave-stop.ts); without it a wave-n is refused. On a
 *   fork, a pull request merged elsewhere, or one closed without merging,
 *   the reply says so.
 * - with `noPlanFlags` (#4979), a plan comment with flags the product
 *   plan's re-plan cannot take, with the reason.
 * - with `wavesBeforeMerge` (#4984), `/<product> apply [wave-<n>]` on an
 *   open pull request: the decision before merge
 *   (./op/before-merge-decide.ts) records the head on `chant/lifecycle`
 *   and dispatches the waves workflow on the default branch for it.
 *
 * Who asked comes first. On GitHub the commenter's permission is read from
 * the forge; Forgejo answers 403 when a job's token asks for another user's
 * permission, so there the event's `repository.permissions`, computed for
 * the comment's author when the comment was created, is read, and the
 * event must be for this repository and from the comment's author. Someone
 * without write access gets no reply and nothing runs, as on GitLab.
 *
 * The comment is untrusted input: it is read from the event file, never
 * from an expression in a script, and nothing of it reaches a shell. The
 * job runs at the target branch's commit, so none of the change's code
 * runs here.
 */

import { commentTerms, forkReply, memberReply, notRunReply } from "./ci-comment-replies";
import { retryApply, type ApplyRerun, type ApplyRetried, type ChantNoteJobs, type StartedRun } from "./ci-note-commands";
import { parseProductComment, type CiProductWords, type ParsedProductComment } from "./ci-product-words";
import { ForgeApiError, type ForgeFetch, type PrForge } from "./pr-forge";
import type { ForgeReads, PullRequestDetail } from "./pr-forge-reads";
import type { DecideBeforeMergeInput, WavesBeforeMergeJobs } from "./op/before-merge-decide";

/** The comment job's name in a generated workflow (#4946). */
export const PR_COMMENT_JOB = "comment";

/** The variable the comment job reads the pipeline's jobs from, as JSON ({@link CommentJobs}), written by the generator (#4946). */
export const COMMENT_JOBS_ENV = "CHANT_COMMENT_JOBS";

/**
 * The jobs the pipeline has that answer a comment (#4946), so the comment
 * job leaves their comments to them. `preview` is any job that plans on the
 * plan comment (the product plan's re-plan, or the comment preview).
 */
export interface CommentJobs extends Omit<ChantNoteJobs, "members"> {
  /** The action command is answered by a workflow: the product's own, or the pipeline's action job. */
  actions?: boolean;
  /**
   * The product plan's targets, with its re-plan: a plan comment naming
   * another is skipped by every re-plan job without a word, so the comment
   * job replies with the words' `member` sentence.
   */
  targets?: readonly string[];
  /** The product plan's re-plan skips a fork's pull request (`forks: "skip"`) without a word, so the comment job replies with the words' `fork` sentence. */
  skipForks?: boolean;
  /**
   * The plan comment's job is the product plan's re-plan (#4979), which
   * takes at most one word after the command and no flags: a plan comment
   * with `--target`, `--refresh` or `--target-dependents` gets a reply that
   * says so, where the re-plan would skip it without a word.
   */
  noPlanFlags?: boolean;
  /**
   * The waves on merge (#4979): the op they run as and how many there are.
   * With them a merged pull request's `/<product> apply wave-<n>` runs the
   * apply again and stops after wave n: the job writes the stop on
   * `chant/lifecycle` for the merge commit (./op/wave-stop.ts) before it
   * starts the run, and each later wave waits. An apply without a wave
   * clears it.
   */
  waves?: { op: string; count: number };
  /**
   * The waves before merge (#4984), with `waves`: `/<product> apply
   * [wave-<n>]` on an open pull request is this job's. It decides
   * (./op/before-merge-decide.ts), records the decided head on
   * `chant/lifecycle`, and dispatches the waves workflow for it.
   */
  wavesBeforeMerge?: WavesBeforeMergeJobs;
}

/** What the decision before merge reads and writes with (#4984), the comment job's handler's. */
export type CommentBeforeMerge = Pick<DecideBeforeMergeInput, "requires" | "statuses" | "git" | "cwd" | "lock" | "record" | "stop" | "now">;

/** Writes a wave stop for op `op` at `sha` on `chant/lifecycle`, or clears it (#4979). */
export type CommentWaveStops = (op: string, sha: string, stop: { through: number; at: string; by?: string; pr?: number } | null) => Promise<void>;

/**
 * The apply jobs a re-run looks for at a merge commit: chant's op waves
 * (`wave-<k>-<name>`, its decide and share jobs) and chant's and
 * terragucci's pull request loop jobs (`apply`, `apply-wave-<k>`).
 */
export const RERUN_APPLY_JOBS = /^(?:wave-([1-9][0-9]*)-[a-z0-9][a-z0-9_-]*|(?:[a-z0-9][a-z0-9-]*-)?apply(?:-wave-([1-9][0-9]*)(?:-share-[1-9][0-9]*)?)?)$/;

/** The writes a re-run makes, with the job's token. */
export interface CommentRuns {
  /** GitHub: `POST /repos/{repo}/actions/runs/{run}/rerun-failed-jobs`. */
  rerunFailed(run: number): Promise<StartedRun>;
  /** Forgejo (and before merge, #4984, both): `POST /repos/{repo}/actions/workflows/{workflow}/dispatches` on `ref`, with `inputs`. */
  dispatch(workflow: string, ref: string, inputs?: Record<string, string>): Promise<StartedRun>;
}

/** The writes for a GitHub or Forgejo API root, repository and token. */
export function commentRuns(opts: { apiBase: string; repo: string; token: string; fetch?: ForgeFetch }): CommentRuns {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch);
  const root = `${opts.apiBase.replace(/\/+$/, "")}/repos/${opts.repo}`;
  const post = async (path: string, body: unknown): Promise<StartedRun> => {
    const url = `${root}${path}`;
    const res = await fetchImpl(url, { method: "POST", headers: { Authorization: `token ${opts.token}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new ForgeApiError("POST", url, res.status, text);
    return {};
  };
  return {
    rerunFailed: (run) => post(`/actions/runs/${run}/rerun-failed-jobs`, {}),
    dispatch: (workflow, ref, inputs) => post(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, ...(inputs ? { inputs } : {}) }),
  };
}

/** What {@link answerProductComment} takes. */
export interface AnswerCommentOptions {
  forge: "github" | "forgejo";
  /** The `issue_comment` event, as the event file has it. */
  event: unknown;
  /** `owner/name`. */
  repo: string;
  reads: ForgeReads;
  /** chant's client, holding the job's token: it posts the reply and reads the statuses. */
  poster: Pick<PrForge, "addComment" | "commitStatuses">;
  runs: CommentRuns;
  words: CiProductWords;
  /** The default branch. */
  base: string;
  jobs: CommentJobs;
  /** The job's environment, for the words' aliases. */
  env?: Record<string, string | undefined>;
  /** The commit words that take an argument, as `parseProductComment` takes them. */
  commitArgs?: Readonly<Record<string, RegExp>>;
  /** With `jobs.waves` (#4979): writes the wave stop before a re-run starts. Absent: a `wave-<n>` is refused, as before. */
  stops?: CommentWaveStops;
  /** The time a stop is written at. Default now. */
  now?: () => string;
  /** With `jobs.wavesBeforeMerge` (#4984): what the decision reads and writes with. Absent: an open pull request's apply is refused, as before. */
  beforeMerge?: CommentBeforeMerge;
}

/** What the comment job did. */
export interface CommentOutcome {
  /** The command's kind, when the comment parsed as one. */
  command?: string;
  /** True when a run was started again. */
  ran: boolean;
  /** True when the job posted a reply. */
  replied: boolean;
  /** True when something broke (a forge answer), not because the comment asked for nothing. The command exits non-zero on it. */
  fail?: boolean;
  reason: string;
  url?: string;
}

/** Permissions on GitHub that may ask for a command: the same as may push. */
const MAY_ASK = new Set(["admin", "maintain", "write"]);
const LOGIN = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,99}$/;

const short = (sha: string): string => sha.slice(0, 8);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The command a comment asks for, for a job that only needs to know: the grammar's reading, leaving a commit word to the commit job. */
export function readProductComment(words: CiProductWords, body: unknown, env: Record<string, string | undefined> = {}, commitArgs: Readonly<Record<string, RegExp>> = {}): ParsedProductComment | undefined {
  return parseProductComment(words, body, env, commitArgs, { leaveCommit: true });
}

/**
 * Whether another job of the pipeline answers `parsed` on an open or a
 * merged pull request, so the comment job says nothing (#4946).
 */
export function answeredElsewhere(parsed: Exclude<ParsedProductComment, { kind: "refused" }>, jobs: CommentJobs, open: boolean | undefined): boolean {
  switch (parsed.kind) {
    case "plan":
      return Boolean(jobs.preview);
    case "lock":
    case "unlock":
      return Boolean(jobs.locks);
    case "action":
      return Boolean(jobs.actions);
    case "agent":
      return Boolean(jobs.agent);
    case "commit":
      return true;
    case "apply":
      // The apply before merge answers an open pull request's apply comment; a merged one's is this job's.
      return Boolean(jobs.applyBeforeMerge) && open !== false;
  }
}

/** Read the comment, and answer it when no other job does (#4946). */
export async function answerProductComment(o: AnswerCommentOptions): Promise<CommentOutcome> {
  const e = o.event;
  const t = commentTerms(o.forge);
  const silent = (reason: string, command?: string): CommentOutcome => ({ ...(command ? { command } : {}), ran: false, replied: false, reason });
  const broke = (reason: string, command?: string): CommentOutcome => ({ ...(command ? { command } : {}), ran: false, replied: false, fail: true, reason });
  if (!isObject(e)) return broke("the event is not a JSON object");
  if (e.action !== "created") return silent("not a new comment");
  const comment = isObject(e.comment) ? e.comment : {};
  const parsed = readProductComment(o.words, comment.body, o.env ?? {}, o.commitArgs ?? {});
  if (parsed === undefined) return silent(`the comment is not addressed to ${o.words.product}, or another job answers it`);
  const command = parsed.kind === "refused" ? undefined : parsed.kind;
  const issue = isObject(e.issue) ? e.issue : {};
  const n = issue.number;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return silent("the comment has no issue number", command);
  if (!issue.pull_request && issue.is_pull !== true && (e as { is_pull?: unknown }).is_pull !== true) return silent(`the comment is not on a ${t.request}`, command);
  const user = isObject(comment.user) ? comment.user.login : undefined;
  if (typeof user !== "string" || !LOGIN.test(user)) return silent("the comment has no usable author", command);

  // Who asked comes first: someone without write access gets no reply and nothing runs.
  if (o.forge === "forgejo") {
    const repository = isObject(e.repository) ? e.repository : {};
    if (repository.full_name !== o.repo) return silent("the event is not for this repository", command);
    const sender = isObject(e.sender) ? e.sender.login : undefined;
    if (sender !== user) return silent("the comment's author is not the event's sender", command);
    const p = isObject(repository.permissions) ? repository.permissions : {};
    if (p.push !== true && p.admin !== true) return silent(`${user} has no write access, so the comment is ignored`, command);
  } else {
    let permission: string | undefined;
    try {
      permission = await o.reads.permission(user);
    } catch (err) {
      return broke(`could not read ${user}'s permission, so nothing runs (${message(err)})`, command);
    }
    if (permission === undefined || !MAY_ASK.has(permission)) return silent(`${user} has no write access, so the comment is ignored`, command);
  }

  const reply = async (text: string, ran = false, url?: string): Promise<CommentOutcome> => {
    const done = { ...(command ? { command } : {}), ran, ...(url ? { url } : {}) };
    try {
      await o.poster.addComment(n, `${o.words.product}: ${text}`);
    } catch (err) {
      return { ...done, replied: false, fail: true, reason: `${text}; and the reply failed (${message(err)})` };
    }
    return { ...done, replied: true, reason: text };
  };

  if (parsed.kind === "refused") return reply(parsed.reason);
  // The product plan's re-plan skips these without a word: a target that is none of its own, and a fork with forks: "skip".
  if (parsed.kind === "plan" && o.jobs.preview) {
    // #4979: the product plan's re-plan plans what its verb plans, and takes no flag the grammar reads.
    if (o.jobs.noPlanFlags && (parsed.targets?.length || parsed.refresh || parsed.targetDependents)) return reply(planFlagsReply(o.words));
    if (parsed.member !== undefined && o.jobs.targets?.length && !o.jobs.targets.includes(parsed.member)) return reply(memberReply(o.words, parsed.member, o.jobs.targets, o.forge));
    if (o.jobs.skipForks) {
      let pr: PullRequestDetail | undefined;
      try {
        pr = await o.reads.pullRequest(n);
      } catch (err) {
        return broke(`could not read ${t.at(n)} (${message(err)})`, command);
      }
      if (pr && !pr.sameRepo) return reply(forkReply(o.words, o.forge));
    }
  }
  // A command another job answers starts that job on this same comment.
  if (parsed.kind !== "apply" && answeredElsewhere(parsed, o.jobs, true)) return silent("another job answers this comment", command);
  switch (parsed.kind) {
    case "plan":
    case "lock":
    case "unlock":
    case "action":
    case "agent":
      return reply(notRunReply(o.words, parsed.kind, o.forge));
    case "commit":
      return silent("the commit job answers this comment", command);
    case "apply":
      break;
  }

  // An apply: the apply before merge answers an open pull request; this job a merged one, with applyOnMerge.
  if (!o.jobs.applyBeforeMerge && !o.jobs.applyOnMerge && !o.jobs.wavesBeforeMerge) return reply(notRunReply(o.words, "apply", o.forge));
  let pr: PullRequestDetail | undefined;
  try {
    pr = await o.reads.pullRequest(n);
  } catch (err) {
    return broke(`could not read ${t.at(n)} (${message(err)})`, command);
  }
  if (!pr) return broke(`the forge has no ${t.at(n)}`, command);
  const at = t.at(n);
  const verb = o.words.verbs.apply;
  if (pr.state === "open") {
    if (o.jobs.applyBeforeMerge) return silent("the apply before merge answers this comment", command);
    // #4984: the waves before merge: decide, record the head and dispatch the waves workflow for it.
    const bm = o.jobs.wavesBeforeMerge;
    if (bm && o.jobs.waves && o.beforeMerge) {
      const workflow = bm.workflow;
      if (!workflow) return broke("the waves before merge name no workflow to dispatch", command);
      const { decideWavesBeforeMerge } = await import("./op/before-merge-decide");
      const done = await decideWavesBeforeMerge({
        ...o.beforeMerge,
        forge: o.forge,
        pr,
        user,
        base: o.base,
        ...(parsed.wave !== undefined ? { wave: parsed.wave } : {}),
        op: o.jobs.waves.op,
        count: o.jobs.waves.count,
        jobs: bm,
        words: o.words,
        start: (r) => o.runs.dispatch(workflow, o.base, { pr: String(r.pr), head: r.head, digest: r.digest }),
      });
      if (done.kind === "fail") return broke(done.reason, command);
      return reply(done.text, done.kind === "ran", done.kind === "ran" ? done.url : undefined);
    }
    return reply(`${at} is not merged: \`/${o.words.product} ${typedApply(o.words)}\` runs the ${verb[0]} of a merged ${t.request} again, from the default branch, and never ${verb[0]}s a ${t.request}'s branch`);
  }
  if (pr.state === "closed") return reply(`${at} was closed without merging, so there is nothing of it to ${verb[0]}`);
  if (!o.jobs.applyOnMerge) return reply(`${at} is merged, and this ${t.place} ${verb[0]}s a ${t.request} before it merges, so there is nothing of it left to ${verb[0]}`);
  if (!pr.sameRepo) return reply(forkReply(o.words, o.forge));
  // #4979: with the waves' op the stop is written for the run; without it a re-run cannot stop.
  const waves = o.stops ? o.jobs.waves : undefined;
  const wave = parsed.wave;
  if (wave !== undefined && !waves) {
    return reply(`a run started again runs the waves after the one that stopped by itself, so \`wave-${wave}\` cannot stop them; write \`/${o.words.product} ${typedApply(o.words)}\`, and each wave still waits behind its own gate`);
  }
  if (wave !== undefined && waves && wave > waves.count) return reply(`the ${verb[0]} of this ${t.place} runs in ${waves.count} wave${waves.count === 1 ? "" : "s"}, so there is no \`wave-${wave}\``);
  if (pr.base !== undefined && pr.base !== o.base) return reply(`${at} was merged into ${pr.base}, not the default branch ${o.base}, so nothing ${verb[1]} from it`);
  if (!pr.mergeCommit) return broke(`${at} has no merge commit`, command);
  const mergeCommit = pr.mergeCommit;
  const start = o.forge === "github" ? githubRerun(o.runs) : forgejoRerun(o.runs, o.reads);
  // The stop goes on chant/lifecycle just before the run starts, so every wave job of the run reads it; an apply without a wave clears it.
  const rerun: ApplyRerun = waves
    ? async (run, jobs, ctx) => {
        try {
          await o.stops!(waves.op, mergeCommit, wave !== undefined ? { through: wave, at: (o.now ?? (() => new Date().toISOString()))(), by: user, pr: n } : null);
        } catch (err) {
          return { kind: "fail", reason: `could not write the wave stop for ${short(mergeCommit)}, so nothing was started (${message(err)})` };
        }
        return start(run, jobs, ctx);
      }
    : start;
  const done = await retryApply({ reads: o.reads, forge: o.poster, words: o.words, base: o.base }, o.forge, pr, user, { kind: "retry", sha: mergeCommit, jobs: RERUN_APPLY_JOBS }, rerun);
  if (done.kind === "fail") return broke(done.reason, command);
  const stopped = done.kind === "ran" && wave !== undefined && waves && wave < waves.count ? `; it stops after \`wave-${wave}\`, and the waves after it wait until \`/${o.words.product} ${typedApply(o.words)}\` runs it again` : "";
  return reply(`${done.text}${stopped}`, done.kind === "ran", done.kind === "ran" ? done.url : undefined);
}

/** The reply to a plan comment with flags the product plan's re-plan cannot take (#4979). */
export function planFlagsReply(words: CiProductWords): string {
  const line = Object.entries(words.commands).find(([, c]) => c === "plan")?.[0] ?? "plan";
  const typed = `/${words.product} ${line}`;
  return `\`${typed}\` plans whole ${words.noun[1]} again, every one or the one named after it, so it takes no \`--target\`, \`--refresh\` or \`--target-dependents\`; write \`${typed}\` or \`${typed} <${words.noun[0]}>\``;
}

/** The typed apply word. */
function typedApply(words: CiProductWords): string {
  return Object.entries(words.commands).find(([, c]) => c === "apply")?.[0] ?? "apply";
}

/** Whether every apply job of a run succeeded, and the reply that says the run is still going. */
function finished(run: { done: boolean; status: string; id: number }, jobs: { status: string; conclusion?: string }[], sha: string, at: string): ApplyRetried | undefined {
  if (!run.done) return { kind: "reply", text: `workflow run ${run.id} at ${short(sha)} is ${run.status} already, so it is not started again` };
  if (jobs.every((j) => j.conclusion === "success" || j.status === "success")) return { kind: "reply", text: `every apply job of ${at}'s merge commit ${short(sha)} already succeeded` };
  return undefined;
}

/** GitHub's start: run the run's failed jobs again, and the jobs that need them. */
export function githubRerun(runs: Pick<CommentRuns, "rerunFailed">): ApplyRerun {
  return async (run, jobs, { sha, at, user }) => {
    const stop = finished(run, jobs, sha, at);
    if (stop) return stop;
    try {
      await runs.rerunFailed(run.id);
    } catch (e) {
      return { kind: "fail", reason: `could not run the failed jobs of workflow run ${run.id} again (${message(e)})` };
    }
    const link = run.url ? ` (${run.url})` : "";
    return { kind: "ran", text: `started the failed jobs of workflow run ${run.id}${link} at ${at}'s merge commit ${short(sha)} again for ${user}; each wave's gate decides again, and the waves after it follow, each behind its own gate`, ...(run.url ? { url: run.url } : {}) };
  };
}

/**
 * Forgejo's start: Forgejo has no call that runs a run again, so the run's
 * workflow is dispatched on the default branch, which runs its head. That
 * is the merge commit only while no push came after it.
 */
export function forgejoRerun(runs: Pick<CommentRuns, "dispatch">, reads: Pick<ForgeReads, "branchRuns">): ApplyRerun {
  return async (run, jobs, { sha, at, user, base }) => {
    const stop = finished(run, jobs, sha, at);
    if (stop) return stop;
    if (!run.workflow) return { kind: "fail", reason: `Forgejo did not name the workflow of run ${run.id}, so it cannot be dispatched` };
    let newest;
    try {
      newest = (await reads.branchRuns(base, { event: "push", limit: 1 }))[0];
    } catch (e) {
      return { kind: "fail", reason: `could not read the newest push on ${base} (${message(e)})` };
    }
    if (newest && newest.headSha !== sha) {
      return { kind: "reply", text: `Forgejo starts a workflow again only at the head of ${base}, which is now ${short(newest.headSha)}, so the merge commit ${short(sha)} of ${at} is not applied again: push to ${base} again` };
    }
    try {
      await runs.dispatch(run.workflow, base);
    } catch (e) {
      return { kind: "fail", reason: `could not dispatch ${run.workflow} on ${base} (${message(e)})` };
    }
    return { kind: "ran", text: `dispatched ${run.workflow} on ${base} at ${at}'s merge commit ${short(sha)} for ${user}; each wave's gate decides again, and a wave that already applied plans nothing new` };
  };
}
