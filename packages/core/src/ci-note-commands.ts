/**
 * Comment commands on GitLab by polling merge request notes (#4785, moved
 * from terragucci's comment-gitlab.ts).
 *
 * GitLab starts no pipeline for a merge request note. So a scheduled
 * pipeline of the default branch runs {@link pollNoteCommands}: it lists the
 * merge requests updated in the last day, reads their notes through chant's
 * forge reads, and answers each note addressed to the product once.
 *
 * - A note is read against the product's words (`parseProductComment`): the
 *   product supplies its command words, and chant's grammar refuses the rest.
 * - Its author must hold `minRole` or more on the project (Developer by
 *   default). Anyone else gets no reply and nothing runs, as on GitHub.
 * - Each note is answered once: the note's id is recorded on the ledger
 *   ({@link NoteLog}, `_notes/<mr>-<note>.json` on `chant/lifecycle` in
 *   {@link ledgerNoteLog}), and the reply carries the note's marker, so a
 *   poll that runs twice answers once.
 * - What a command runs is the product's ({@link NoteCommandRuns}): a
 *   pipeline of a branch started with the command's variables, a new merge
 *   request pipeline, the retry of the first apply job that did not succeed
 *   at a merged merge request's merge commit, or a reply alone.
 *   {@link chantNoteRuns} answers for the jobs chant's own GitLab pipeline
 *   writes (`CHANT_PREVIEW_PR`, `CHANT_APPLY_PR`, `CHANT_LOCK_PR`,
 *   `CHANT_UNLOCK_PR`, `CHANT_AGENT_PR`, `CHANT_COMMIT_PR`).
 *
 * The job runs nothing it reads: it calls GitLab's API with the project's
 * token and holds no cloud credentials.
 */

import { GITLAB_AGENT_ASK_VAR, GITLAB_AGENT_PR_VAR } from "./ci-agent";
import { GITLAB_COMMIT_ARG_VAR, GITLAB_COMMIT_PR_VAR, GITLAB_COMMIT_WORD_VAR } from "./ci-commit";
import { parseProductComment, productStatusContext, type CiProductCommand, type CiProductWords, type ParsedProductComment } from "./ci-product-words";
import { commandLine, commentTerms, forkReply, memberReply, notRunReply } from "./ci-comment-replies";
import { GITLAB_APPLY_PR_VAR, GITLAB_LOCK_PR_VAR, GITLAB_PREVIEW_PR_VAR, GITLAB_UNLOCK_PR_VAR, PREVIEW_COMMENT_ENV } from "./components/pr-pipeline";
import { ForgeApiError, type ForgeFetch, type ForgeKind, type GitlabForgeOptions, type PrForge } from "./pr-forge";
import type { ForgeReads, PullRequestDetail, PullRequestNote, RunJob, WorkflowRun } from "./pr-forge-reads";

export { GITLAB_NOTE_COMMANDS_VAR } from "./components/pr-pipeline";

/** How far back the poll reads: merge requests updated, and notes written, in this many minutes. */
export const NOTE_COMMANDS_WINDOW_MINUTES = 24 * 60;

/** How many pipelines of the default branch after the merge commit's are read for a later apply. */
export const NOTE_COMMANDS_NEWER_PIPELINES = 50;

/** GitLab's roles, least first, as `ForgeReads.permission` names them. */
export const GITLAB_ROLES = ["minimal", "guest", "planner", "reporter", "developer", "maintainer", "owner"] as const;

/** The marker a reply carries, naming the note it answers: `<!-- <product>:note=<id> -->`, terragucci's own. */
export function noteCommandMarker(product: string, id: number): string {
  return `<!-- ${product}:note=${id} -->`;
}

/** A pipeline the poll started, or the job it retried. */
export interface StartedRun {
  id?: number;
  url?: string;
}

/** The GitLab writes the poll makes, with the token that may make them. */
export interface GitlabPipelines {
  /** `POST /projects/:id/pipeline`: a pipeline of `ref` with `variables`. */
  start(ref: string, variables: Readonly<Record<string, string>>): Promise<StartedRun>;
  /** `POST /projects/:id/merge_requests/:iid/pipelines`: a new merge request pipeline, which takes no variables. */
  startMergeRequest(iid: number): Promise<StartedRun>;
  /** `POST /projects/:id/jobs/:job/retry`. */
  retryJob(job: number): Promise<StartedRun>;
}

/** The writes for a GitLab client's options. */
export function gitlabPipelines(opts: GitlabForgeOptions): GitlabPipelines {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch);
  const root = opts.apiBase.replace(/\/+$/, "");
  const project = `/projects/${encodeURIComponent(decodeURIComponent(opts.project))}`;
  const headers = { "Content-Type": "application/json", ...(opts.token ? { [opts.tokenHeader ?? "PRIVATE-TOKEN"]: opts.token } : {}) };
  const post = async (path: string, body?: unknown): Promise<StartedRun> => {
    const url = `${root}${project}${path}`;
    const res = await fetchImpl(url, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    if (!res.ok) throw new ForgeApiError("POST", url, res.status, text);
    let v: unknown;
    try {
      v = text ? JSON.parse(text) : null;
    } catch {
      v = null;
    }
    const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    return { ...(typeof o.id === "number" ? { id: o.id } : {}), ...(typeof o.web_url === "string" && /^https?:\/\//.test(o.web_url) ? { url: o.web_url } : {}) };
  };
  return {
    start: (ref, variables) => post("/pipeline", { ref, variables: Object.entries(variables).map(([key, value]) => ({ key, value, variable_type: "env_var" })) }),
    startMergeRequest: (iid) => post(`/merge_requests/${iid}/pipelines`),
    retryJob: (job) => post(`/jobs/${job}/retry`),
  };
}

/** A command the poll read, from an author with the role it needs. */
export interface NoteCommand {
  mr: PullRequestDetail;
  note: PullRequestNote;
  /** The command, never `refused`: a refusal is answered with its reason first. */
  parsed: Exclude<ParsedProductComment, { kind: "refused" }>;
  /** The author's role on the project. */
  role: string;
  /** The default branch. */
  base: string;
  words: CiProductWords;
}

/** What a command runs. */
export type NoteRun =
  /** A pipeline of `ref` started with `variables`; `doing` finishes the reply's "started pipeline <url> to ...". */
  | { kind: "pipeline"; ref: string; variables: Record<string, string>; doing: string; with?: GitlabPipelines }
  /** A new merge request pipeline of the note's merge request. */
  | { kind: "merge-request-pipeline"; doing: string }
  /**
   * The retry of the first job `jobs` matches that did not succeed, in the
   * newest push pipeline at `sha` (a merged merge request's merge commit)
   * that has such a job. Refused when a later commit of the default branch
   * already carries the product's apply status.
   */
  | { kind: "retry"; sha: string; jobs?: RegExp }
  /** A reply, and nothing runs. */
  | { kind: "reply"; text: string }
  /** Something broke: the note gets no reply and is read again next poll. */
  | { kind: "fail"; reason: string };

/** The product's answer to a command. */
export type NoteCommandRuns = (c: NoteCommand) => NoteRun | Promise<NoteRun>;

/** What the poll did with one note. */
export interface NoteOutcome {
  mr: number;
  note: number;
  author?: string;
  /** The command's kind, when the note parsed as one. */
  command?: string;
  /** True when a pipeline was started or a job retried. */
  ran: boolean;
  /** False when the note got no reply (an author without the role, or a failure). */
  replied: boolean;
  /** True when something broke (a forge answer), not because the note asked for nothing. */
  fail?: boolean;
  reason: string;
  /** The pipeline or job started. */
  url?: string;
  /** When the poll answered it (ISO 8601). */
  at: string;
}

/** Where the poll keeps the notes it answered. */
export interface NoteLog {
  answered(mr: number, note: number): Promise<boolean>;
  /** Called once a note is answered: replied to, ignored for its author, or run. A failure that ran nothing is not recorded, so the next poll reads it again. */
  record(outcome: NoteOutcome): Promise<void>;
}

/** A log in memory, for tests and a dry run. */
export function memoryNoteLog(seen: NoteOutcome[] = []): NoteLog & { outcomes: NoteOutcome[] } {
  return {
    outcomes: seen,
    answered: async (mr, note) => seen.some((o) => o.mr === mr && o.note === note),
    record: async (o) => void seen.push(o),
  };
}

export interface NoteCommandsOptions {
  reads: ForgeReads;
  /** chant's client, holding the job's token: it posts the replies and reads the statuses. */
  forge: PrForge;
  /** The writes, with the token that may start pipelines on the default branch. */
  pipelines: GitlabPipelines;
  words: CiProductWords;
  /** The default branch. */
  base: string;
  runs: NoteCommandRuns;
  log: NoteLog;
  /** The least role that may ask. Default `developer`. */
  minRole?: (typeof GITLAB_ROLES)[number];
  /** The poll's clock. Default: now. */
  now?: Date;
  windowMinutes?: number;
  /** The job's environment, for the words' aliases. */
  env?: Record<string, string | undefined>;
  /** The commit words that take an argument, as `parseProductComment` takes them. */
  commitArgs?: Readonly<Record<string, RegExp>>;
}

export interface NotePoll {
  outcomes: NoteOutcome[];
  /** Set when the poll could not list the merge requests or a merge request's notes. */
  fail?: string;
}

const short = (sha: string): string => sha.slice(0, 8);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;

/** Read, answer and record every new command note of the merge requests updated in the window. */
export async function pollNoteCommands(o: NoteCommandsOptions): Promise<NotePoll> {
  const now = o.now ?? new Date();
  const since = new Date(now.getTime() - (o.windowMinutes ?? NOTE_COMMANDS_WINDOW_MINUTES) * 60_000).toISOString();
  const at = now.toISOString();
  const least = GITLAB_ROLES.indexOf(o.minRole ?? "developer");
  let me: { login: string; id?: number } | undefined;
  let mrs: PullRequestDetail[];
  try {
    me = await o.reads.tokenUser();
    mrs = await o.reads.pullRequestsUpdated(since);
  } catch (e) {
    return { outcomes: [], fail: `could not list the merge requests (${message(e)})` };
  }
  if (!me) return { outcomes: [], fail: "GitLab did not say which user the job's token acts as, so no reply can be told apart" };
  const mine = (n: PullRequestNote): boolean => (me!.id !== undefined && n.authorId === me!.id) || n.author === me!.login;
  const marker = new RegExp(`<!-- ${o.words.product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:note=(\\d+) -->`, "g");
  const outcomes: NoteOutcome[] = [];
  let unrecorded: string | undefined;
  for (const mr of mrs) {
    let notes: PullRequestNote[];
    try {
      notes = await o.reads.pullRequestNotes(mr.number);
    } catch (e) {
      return { outcomes, fail: `could not read the notes of !${mr.number} (${message(e)})${unrecorded ? `; and ${unrecorded}` : ""}` };
    }
    // Only the job's own replies mark a note answered: anyone else writing the marker answers nothing.
    const replied = new Set<number>();
    for (const n of notes) if (mine(n)) for (const m of n.body.matchAll(marker)) replied.add(Number(m[1]));
    const asks = notes
      .filter((n) => !n.system && !mine(n) && !replied.has(n.id) && n.created !== undefined && Date.parse(n.created) >= Date.parse(since))
      .filter((n) => parseProductComment(o.words, n.body, o.env ?? {}, o.commitArgs ?? {}) !== undefined)
      .sort((a, b) => Date.parse(a.created!) - Date.parse(b.created!) || a.id - b.id);
    for (const note of asks) {
      if (await o.log.answered(mr.number, note.id)) continue;
      const out = await answer(o, mr, note, least, at, me.login);
      if (out.ran || out.replied || !out.fail) {
        try {
          await o.log.record(out);
        } catch (e) {
          // The reply's marker still answers the note once.
          unrecorded = `could not record note ${note.id} of !${mr.number} on the ledger (${message(e)})`;
        }
      }
      outcomes.push(out);
    }
  }
  return { outcomes, ...(unrecorded ? { fail: unrecorded } : {}) };
}

async function answer(o: NoteCommandsOptions, mr: PullRequestDetail, note: PullRequestNote, least: number, at: string, me: string): Promise<NoteOutcome> {
  const parsed = parseProductComment(o.words, note.body, o.env ?? {}, o.commitArgs ?? {})!;
  const base = { mr: mr.number, note: note.id, ...(note.author ? { author: note.author } : {}), ...(parsed.kind !== "refused" ? { command: parsed.kind } : {}), at };
  const marker = noteCommandMarker(o.words.product, note.id);
  const reply = async (text: string, ran = false, url?: string): Promise<NoteOutcome> => {
    const done = { ...base, ran, ...(url ? { url } : {}) };
    try {
      // One reply per note, found again by its marker.
      await o.forge.upsertComment(mr.number, marker, `${o.words.product}: ${text}\n\n${marker}`, { match: "anywhere", author: me });
    } catch (e) {
      return { ...done, replied: false, fail: true, reason: `${text}; and the reply failed (${message(e)})` };
    }
    return { ...done, replied: true, reason: text };
  };
  const broke = (reason: string): NoteOutcome => ({ ...base, ran: false, replied: false, fail: true, reason });
  const silent = (reason: string): NoteOutcome => ({ ...base, ran: false, replied: false, reason });

  // Who asked comes first: someone below the role gets no reply and nothing runs.
  if (!note.author) return silent("the note has no usable author");
  let role: string | undefined;
  try {
    role = await o.reads.permission(note.author);
  } catch (e) {
    return broke(`could not read ${note.author}'s access, so nothing runs (${message(e)})`);
  }
  if (role === undefined) return silent(`${note.author} is not a member of the project, so the note is ignored`);
  const level = GITLAB_ROLES.indexOf(role as (typeof GITLAB_ROLES)[number]);
  if (level < least) return silent(`${note.author} is ${role} on the project, below ${GITLAB_ROLES[least]}, so the note is ignored`);
  if (parsed.kind === "refused") return reply(parsed.reason);

  let run: NoteRun;
  try {
    run = await o.runs({ mr, note, parsed, role, base: o.base, words: o.words });
  } catch (e) {
    return broke(`could not decide what ${note.author}'s command runs (${message(e)})`);
  }
  const link = (r: StartedRun): string => (r.url ? ` ${r.url}` : "");
  switch (run.kind) {
    case "reply":
      return reply(run.text);
    case "fail":
      return broke(run.reason);
    case "pipeline": {
      let started: StartedRun;
      try {
        started = await (run.with ?? o.pipelines).start(run.ref, run.variables);
      } catch (e) {
        return broke(`could not start a pipeline on ${run.ref} for !${mr.number} (${message(e)})`);
      }
      return reply(`started pipeline${link(started)} on ${run.ref} to ${run.doing} for ${note.author}`, true, started.url);
    }
    case "merge-request-pipeline": {
      let started: StartedRun;
      try {
        started = await o.pipelines.startMergeRequest(mr.number);
      } catch (e) {
        return broke(`could not start a pipeline for !${mr.number} (${message(e)})`);
      }
      return reply(`started pipeline${link(started)} to ${run.doing} for ${note.author}`, true, started.url);
    }
    case "retry": {
      const done = await retryApply(o, "gitlab", mr, note.author, run, gitlabRetry(o.pipelines));
      if (done.kind === "fail") return broke(done.reason);
      return reply(done.text, done.kind === "ran", done.kind === "ran" ? done.url : undefined);
    }
  }
}

/** chant's apply jobs and terragucci's: `apply`, `apply-wave-<n>` and `apply-wave-<n>-share-<m>`, a member's prefixed with its name. */
export const APPLY_JOBS = /^(?:[a-z0-9][a-z0-9-]*-)?apply(?:-wave-([1-9][0-9]*)(?:-share-([1-9][0-9]*))?)?$/;

const NOT_DONE = new Set(["created", "pending", "running", "waiting_for_resource", "preparing", "scheduled"]);

/** What starting a merge commit's apply again came to: a reply alone, a run started (`ran`), or a forge answer that broke it. */
export type ApplyRetried = { kind: "reply"; text: string } | { kind: "ran"; text: string; url?: string } | { kind: "fail"; reason: string };

/** What {@link ApplyRerun} is told: the merge commit, the pull request's name in a reply, who asked, and the default branch. */
export interface ApplyRerunContext {
  sha: string;
  /** `!12`, or `pull request 12`. */
  at: string;
  user: string;
  base: string;
  /** The pattern the apply jobs matched, whose groups are the wave and the share. */
  pattern: RegExp;
}

/**
 * How a forge starts a merge commit's apply again (#4946), once
 * {@link retryApply} found the push run at the commit with apply jobs and no
 * later apply. GitLab retries the first apply job that did not succeed
 * ({@link gitlabRetry}); GitHub and Forgejo answer in ./ci-comment-commands.ts.
 */
export type ApplyRerun = (run: WorkflowRun, jobs: RunJob[], c: ApplyRerunContext) => Promise<ApplyRetried>;

/** What {@link retryApply} reads with. */
export interface ApplyRetryReads {
  reads: ForgeReads;
  /** chant's client: it reads the later commits' statuses. */
  forge: Pick<PrForge, "commitStatuses">;
  words: CiProductWords;
  /** The default branch. */
  base: string;
}

/**
 * Start a merged pull request's apply again (#4785; shared with GitHub and
 * Forgejo in #4946): the newest push run at the merge commit that has an
 * apply job, refused when a later commit of the default branch already
 * carries the product's apply status, since going back to this one would
 * undo it. `rerun` is the forge's own start.
 */
export async function retryApply(o: ApplyRetryReads, forgeKind: ForgeKind, mr: PullRequestDetail, user: string, run: Extract<NoteRun, { kind: "retry" }>, rerun: ApplyRerun): Promise<ApplyRetried> {
  const { sha } = run;
  const pattern = run.jobs ?? APPLY_JOBS;
  const t = commentTerms(forgeKind);
  const at = t.at(mr.number);
  const gitlab = forgeKind === "gitlab";
  const runWord = gitlab ? "pipeline" : "workflow run";
  const reply = (text: string): ApplyRetried => ({ kind: "reply", text });
  // The newest push pipeline at the merge commit with an apply job: a branch pipeline, or a ci/green tag's.
  let pipeline: WorkflowRun | undefined;
  let jobs: RunJob[] = [];
  let newer: WorkflowRun[];
  try {
    for (const p of await o.reads.headRuns(sha, { event: "push" })) {
      const js = (await o.reads.runJobs(p.id)).filter((j) => pattern.test(j.name));
      if (js.length > 0) {
        pipeline = p;
        jobs = js;
        break;
      }
    }
    if (!pipeline) return reply(`no ${runWord} at the merge commit ${short(sha)} of ${at} has an apply job, so there is nothing to ${gitlab ? "retry" : "run again"}; push to ${o.base} again`);
    newer = await o.reads.branchRuns(o.base, { event: "push", limit: NOTE_COMMANDS_NEWER_PIPELINES });
  } catch (e) {
    return { kind: "fail", reason: `could not read the ${runWord}s at ${short(sha)} (${message(e)})` };
  }
  // A later commit whose apply started applied a newer tree: going back to this one would undo it.
  const applyContext = productStatusContext(o.words, "apply");
  const later = [...new Set(newer.filter((p) => p.id > pipeline!.id && p.headSha !== sha).map((p) => p.headSha))];
  for (const c of later) {
    let applied: { targetUrl?: string } | undefined;
    try {
      applied = (await o.forge.commitStatuses?.(c))?.find((s) => s.context === applyContext);
    } catch (e) {
      return { kind: "fail", reason: `could not read the statuses of ${short(c)} (${message(e)})` };
    }
    if (applied) {
      const link = applied.targetUrl && /^https?:\/\//.test(applied.targetUrl) ? ` (${applied.targetUrl})` : "";
      return reply(`a later apply already ran on ${o.base} at ${short(c)}${link}, so the merge commit ${short(sha)} of ${at} is not applied: comment on the ${t.request} that commit came from, or push again`);
    }
  }
  return rerun(pipeline, jobs, { sha, at, user, base: o.base, pattern });
}

/** GitLab's start: retry the first apply job, by wave and share, that did not succeed; the jobs after it follow by themselves. */
export function gitlabRetry(pipelines: Pick<GitlabPipelines, "retryJob">): ApplyRerun {
  return async (pipeline, jobs, { sha, at, user, base, pattern }) => {
    const reply = (text: string): ApplyRetried => ({ kind: "reply", text });
    const order = (j: RunJob): [number, number] => {
      const m = pattern.exec(j.name);
      return [m?.[1] ? Number(m[1]) : 0, m?.[2] ? Number(m[2]) : 0];
    };
    const sorted = [...jobs].sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
    const next = sorted.find((j) => j.status !== "success");
    if (!next) return reply(`every apply job of ${at}'s merge commit ${short(sha)} already succeeded`);
    if (NOT_DONE.has(next.status)) return reply(`${next.name} at ${short(sha)} is ${next.status} already, so it is not retried`);
    if (next.status !== "failed" && next.status !== "canceled") {
      return reply(`${next.name} at ${short(sha)} was ${next.status}, and GitLab retries only a failed or canceled job; push to ${base} again`);
    }
    let retried: StartedRun;
    try {
      retried = await pipelines.retryJob(next.id);
    } catch (e) {
      return { kind: "fail", reason: `could not retry ${next.name} of pipeline ${pipeline.id} (${message(e)})` };
    }
    const link = retried.url ? ` (${retried.url})` : "";
    return { kind: "ran", text: `retried ${next.name} of ${at}'s merge commit ${short(sha)}${link} for ${user}; its gate decides again, and the jobs after it follow, each behind its own gate`, ...(retried.url ? { url: retried.url } : {}) };
  };
}

/** The jobs chant's GitLab pipeline has, which {@link chantNoteRuns} starts. */
export interface ChantNoteJobs {
  /** The comment preview (`--preview-comment`): a plan starts it with `CHANT_PREVIEW_PR`. Without it a plan starts a merge request pipeline. */
  preview?: boolean;
  /** The apply before merge (`--apply-before-merge`), started with `CHANT_APPLY_PR`. */
  applyBeforeMerge?: boolean;
  /** The apply on merge (`--apply-on-merge`, waves): an apply on a merged merge request retries its first apply job that did not succeed. */
  applyOnMerge?: boolean;
  /** The lock and unlock jobs (`ci.locks: plan`), started with `CHANT_LOCK_PR` and `CHANT_UNLOCK_PR`. */
  locks?: boolean;
  /** The agent's jobs, started with `CHANT_AGENT_PR` and `CHANT_AGENT_ASK`. */
  agent?: boolean;
  /** The commit jobs, started with `CHANT_COMMIT_PR`, `CHANT_COMMIT` and `CHANT_COMMIT_ARG`. */
  commits?: boolean;
  /**
   * The members the pipeline was written with (#4946), such as terragucci's
   * roots: a plan or an action naming any other gets the words' `member`
   * reply, and nothing starts. Absent: any member a comment may name.
   */
  members?: readonly string[];
}

/**
 * What a command runs in chant's own GitLab pipeline, for the jobs it has.
 * A command no job runs gets the words' reply for it (`words.replies`,
 * #4946), else chant's.
 */
export function chantNoteRuns(jobs: ChantNoteJobs): NoteCommandRuns {
  return ({ mr, note, parsed, base, words }): NoteRun => {
    const iid = String(mr.number);
    const at = `!${mr.number}`;
    const line = (kind: CiProductCommand): string => commandLine(words, kind);
    // #4946: a member outside the pipeline's is refused before anything starts, a fork's included.
    const member = parsed.kind === "plan" || parsed.kind === "action" ? parsed.member : undefined;
    if (member !== undefined && jobs.members && !jobs.members.includes(member)) return { kind: "reply", text: memberReply(words, member, jobs.members, "gitlab") };
    if (!mr.sameRepo) return { kind: "reply", text: forkReply(words, "gitlab") };
    const open = mr.state === "open";
    const intoBase = mr.base === undefined || mr.base === base;
    // #4946: the product's sentence for an apply no job answers, in place of chant's, which say what the merge does.
    if (parsed.kind === "apply" && !jobs.applyBeforeMerge && !jobs.applyOnMerge && words.replies?.apply !== undefined) return { kind: "reply", text: words.replies.apply };
    switch (parsed.kind) {
      case "plan":
        if (!open) return { kind: "reply", text: `${at} is not open, so it is not ${words.verbs.plan[1]}` };
        if (jobs.preview) return { kind: "pipeline", ref: base, variables: { [GITLAB_PREVIEW_PR_VAR]: iid, [PREVIEW_COMMENT_ENV]: note.body.trim() }, doing: `${words.verbs.plan[0]} ${at}'s head again` };
        return { kind: "merge-request-pipeline", doing: `${words.verbs.plan[0]} ${at} again` };
      case "apply":
        if (open) {
          if (!jobs.applyBeforeMerge) return { kind: "reply", text: `${at} is not merged, and this project ${words.verbs.apply[0]}s after a merge request merges, never from its branch` };
          if (!intoBase) return { kind: "reply", text: `${at} targets ${mr.base}, not the default branch ${base}, so it is not ${words.verbs.apply[1]}` };
          return { kind: "pipeline", ref: base, variables: { [GITLAB_APPLY_PR_VAR]: iid }, doing: `${words.verbs.apply[0]} ${at}'s head${mr.headSha ? ` ${short(mr.headSha)}` : ""}` };
        }
        if (mr.state === "closed") return { kind: "reply", text: `${at} was closed without merging, so there is nothing of it to ${words.verbs.apply[0]}` };
        if (!jobs.applyOnMerge) {
          return { kind: "reply", text: jobs.applyBeforeMerge ? `${at} is merged, and this project ${words.verbs.apply[0]}s a merge request before it merges, so there is nothing of it left to ${words.verbs.apply[0]}` : `${at} is merged, and a merge here records the plan: a release deploys it` };
        }
        if (parsed.wave !== undefined) return { kind: "reply", text: `GitLab runs the waves after a retried apply job by itself, so \`wave-${parsed.wave}\` cannot stop them; write ${line("apply")}, and each wave still waits behind its own gate` };
        if (!intoBase) return { kind: "reply", text: `${at} was merged into ${mr.base}, not the default branch ${base}, so nothing applies from it` };
        if (!mr.mergeCommit) return { kind: "fail", reason: `${at} has no merge commit` };
        return { kind: "retry", sha: mr.mergeCommit };
      case "lock":
      case "unlock":
        if (!jobs.locks) return { kind: "reply", text: notRunReply(words, parsed.kind, "gitlab") };
        if (parsed.kind === "lock" && !open) return { kind: "reply", text: `${at} is not open, so it takes no lock` };
        return { kind: "pipeline", ref: base, variables: { [parsed.kind === "lock" ? GITLAB_LOCK_PR_VAR : GITLAB_UNLOCK_PR_VAR]: iid }, doing: `${parsed.kind} the ${words.noun[1]} of ${at}` };
      case "agent":
        if (!jobs.agent) return { kind: "reply", text: notRunReply(words, "agent", "gitlab") };
        if (!open) return { kind: "reply", text: `${at} is not open, so the agent does not run` };
        if (mr.head === base) return { kind: "reply", text: `${at}'s source branch is the default branch, and an agent never pushes there` };
        return { kind: "pipeline", ref: base, variables: { [GITLAB_AGENT_PR_VAR]: iid, [GITLAB_AGENT_ASK_VAR]: parsed.ask }, doing: `run the agent on ${at}` };
      case "commit":
        if (!jobs.commits) return { kind: "reply", text: `\`/${words.product} ${parsed.word}\` does not run here` };
        if (!open) return { kind: "reply", text: `${at} is not open, so \`/${words.product} ${parsed.word}\` does not run` };
        return { kind: "pipeline", ref: base, variables: { [GITLAB_COMMIT_PR_VAR]: iid, [GITLAB_COMMIT_WORD_VAR]: parsed.word, ...(parsed.arg !== undefined ? { [GITLAB_COMMIT_ARG_VAR]: parsed.arg } : {}) }, doing: `run \`${parsed.word}\` on ${at}` };
      case "action":
        return { kind: "reply", text: `${line("action")} does not run from a merge request note on GitLab: run \`${words.bin ?? words.product} action ${parsed.member} ${parsed.address}\` from a checkout of the default branch` };
    }
  };
}

/** The directory on `chant/lifecycle` that keeps the notes the poll answered. */
export const NOTES_DIR = "_notes";

/** A note's file in {@link NOTES_DIR}. */
export function noteFile(mr: number, note: number): string {
  return `${mr}-${note}.json`;
}

/**
 * The notes the poll answered, kept on the local `chant/lifecycle` of `cwd`:
 * one file per note, `_notes/<mr>-<note>.json`, written and pushed as each
 * note is answered. The caller fetches the branch first. `push: false`
 * writes the local branch alone.
 */
export function ledgerNoteLog(opts: { cwd?: string; push?: boolean } = {}): NoteLog {
  return {
    async answered(mr, note) {
      const { readBlobFromPath } = await import("./lifecycle/git");
      return (await readBlobFromPath(NOTES_DIR, noteFile(mr, note), opts)) !== null;
    },
    async record(outcome) {
      const { ledgerDir, pushLifecycleRebasing, readPathSha, writeLedgerFiles } = await import("./lifecycle/git");
      const file = noteFile(outcome.mr, outcome.note);
      const dir = await ledgerDir(NOTES_DIR, opts);
      const prior = await readPathSha(NOTES_DIR, file, opts);
      await writeLedgerFiles([{ path: `${dir}/${file}`, content: `${JSON.stringify(outcome)}\n`, expectPriorSha: prior }], `Note ${outcome.note} on !${outcome.mr}`, opts);
      if (opts.push === false) return;
      const pushed = await pushLifecycleRebasing(opts);
      if (pushWarned(pushed)) throw new Error(`answered note ${outcome.note} on !${outcome.mr}, and could not push chant/lifecycle (${pushed.pushWarning})`);
    },
  };
}

const pushWarned = (p: { pushed: boolean; pushWarning?: string }): p is { pushed: boolean; pushWarning: string } => !p.pushed && p.pushWarning !== undefined;
