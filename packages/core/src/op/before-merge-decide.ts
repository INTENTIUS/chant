/**
 * The decision behind `/<product> apply [wave-<n>]` on an open pull request
 * whose waves run before merge (#4984), moved from terragucci's
 * `decideOpen` and `openChecks` (comment-apply.ts) and `decideGitLabApply`
 * (comment-apply-gitlab.ts). The comment job runs it on GitHub and Forgejo
 * (../ci-comment-commands.ts), the note poll on GitLab
 * (../ci-note-commands.ts), each at the default branch's commit with the
 * job's token, so none of the change's code runs here.
 *
 * In order, each refused with a reply that says why:
 *
 * - the pull request is from this repository, into the default branch, and
 *   the wave it names is one the waves have;
 * - its head, fetched from the forge's pull request ref, is still the head
 *   the forge named while the comment was read;
 * - the requires the product lists (`apply.requires`, chant's requires
 *   checks: approved, mergeable, undiverged, checks) pass at that head;
 * - every plan status of the product plan (`<product>/plan`, or one per
 *   target) passed on that head: a policy denial fails it, and nothing
 *   waives one;
 * - the change touches none of the pipeline's files (the forge's workflow
 *   directory and the waves spec by default): the run is the default
 *   branch's pipeline, so a change to it applies after it merges;
 * - with the product's reach line, it takes the locks of what it reaches at
 *   stage `apply`, and no other open pull request holds one of them.
 *
 * Then it records the decision on `chant/lifecycle` (./before-merge.ts),
 * writes a wave stop for the head when the comment named a wave, or clears
 * one (./wave-stop.ts), and starts the waves for that head: GitHub and
 * Forgejo dispatch the waves workflow on the default branch with the
 * inputs `pr`, `head` and `digest`; GitLab starts a pipeline of the default
 * branch with the same three as variables.
 */

import { commentTerms, forkReply } from "../ci-comment-replies";
import type { ApplyRetried, StartedRun } from "../ci-note-commands";
import type { CiProductWords } from "../ci-product-words";
import type { ForgeKind } from "../pr-forge";
import type { PullRequestDetail } from "../pr-forge-reads";
import type { PrApplyRequire } from "../pr-requires";
import { pullRequestHeadRef, type ReachRun } from "../lifecycle/reach-locks";
import type { BeforeMergeDecision, BeforeMergeRecord } from "./before-merge";

/** The waves before merge, as the pipeline tells the comment job and the note poll (#4984), in `CHANT_COMMENT_JOBS`. */
export interface WavesBeforeMergeJobs {
  /** GitHub and Forgejo: the waves workflow's file, which the comment job dispatches. */
  workflow?: string;
  /** The requires the forge is asked (`apply.requires`). Default every one. */
  requires?: PrApplyRequire[];
  /** The statuses that must have passed on the head: the product plan's `<product>/plan`, or one per target. */
  plan: string[];
  /** Paths the change must not touch; one that ends in `/` is a directory. */
  pipelineFiles: string[];
  /** With the product plan's reach line: the lock file the locks at stage apply go in. */
  locks?: { gate?: string };
}

/** The pipeline files a before-merge change may not touch by default, by forge: the workflows and the waves specs. */
export function defaultPipelineFiles(forge: ForgeKind): string[] {
  const workflows = forge === "gitlab" ? [".gitlab-ci.yml", ".gitlab/"] : forge === "forgejo" ? [".forgejo/workflows/"] : [".github/workflows/"];
  return [...workflows, ".chant/op-waves/"];
}

/** What {@link decideWavesBeforeMerge} takes: the comment, and what the job reads and writes with. */
export interface DecideBeforeMergeInput {
  forge: ForgeKind;
  pr: PullRequestDetail;
  user: string;
  /** The default branch. */
  base: string;
  /** The last wave, when the comment named one. */
  wave?: number;
  op: string;
  /** How many waves there are. */
  count: number;
  jobs: WavesBeforeMergeJobs;
  words: CiProductWords;
  /** The requires that are not met at `head`, as one sentence, or null when they pass. */
  requires(pr: number, head: string): Promise<string | null>;
  /** The head's statuses, newest per context. */
  statuses(sha: string): Promise<ReadonlyArray<{ context: string; state: string }>>;
  /** Git in the job's checkout of the default branch. */
  git: ReachRun;
  cwd?: string;
  /** Take the locks of what the change reaches at stage apply, for `by`; a refusal is the reply. Absent: the pipeline has no reach line, so nothing is locked. */
  lock?(pr: number, head: string, base: string, by: string): Promise<{ ok: true; targets: string[] } | { ok: false; text: string }>;
  /** Write the decision on chant/lifecycle. */
  record(d: BeforeMergeDecision): Promise<BeforeMergeRecord>;
  /** Write the head's wave stop, or clear it (null). */
  stop(head: string, through: number | null): Promise<void>;
  /** Start the waves for the recorded decision. */
  start(r: BeforeMergeRecord): Promise<StartedRun>;
  now?: () => string;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const short = (sha: string): string => sha.slice(0, 8);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;

/** Whether `file` is one of `paths`: equal to one, or under one that ends in `/`. */
export function touchesPipeline(file: string, paths: readonly string[]): boolean {
  return paths.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}

/** Decide the apply, record it and start the waves (#4984). */
export async function decideWavesBeforeMerge(i: DecideBeforeMergeInput): Promise<ApplyRetried> {
  const t = commentTerms(i.forge);
  const at = t.at(i.pr.number);
  const verb = i.words.verbs.apply;
  const typed = `/${i.words.product} ${Object.entries(i.words.commands).find(([, c]) => c === "apply")?.[0] ?? "apply"}`;
  const reply = (text: string): ApplyRetried => ({ kind: "reply", text });
  const fail = (reason: string): ApplyRetried => ({ kind: "fail", reason });
  const run = (args: string[]) => i.git(["git", ...args], { ...(i.cwd ? { cwd: i.cwd } : {}) });

  if (!i.pr.sameRepo) return reply(forkReply(i.words, i.forge));
  if (i.pr.base !== undefined && i.pr.base !== i.base) return reply(`${at} targets ${i.pr.base}, not the default branch ${i.base}, so it is not ${verb[1]} before merge`);
  if (i.wave !== undefined && i.wave > i.count) return reply(`the ${verb[0]} of this ${t.place} runs in ${i.count} wave${i.count === 1 ? "" : "s"}, so there is no \`wave-${i.wave}\``);
  const head = i.pr.headSha;
  if (!head || !SHA.test(head)) return fail(`${at} names no head commit`);
  if (!BRANCH.test(i.base) || i.base.split("/").some((s) => s === ".." || s === "")) return fail(`the default branch ${JSON.stringify(i.base)} is not a branch name this job passes on`);

  // The head as the forge's pull request ref has it now, and the default branch's commit the change is measured from.
  const headRef = "refs/remotes/chant/before-merge-head";
  const baseRef = `refs/remotes/origin/${i.base}`;
  const fetched = run(["fetch", "-q", "--no-tags", "origin", `+refs/heads/${i.base}:${baseRef}`, `+${pullRequestHeadRef(i.forge, i.pr.number)}:${headRef}`]);
  if (fetched.status !== 0) return fail(`could not fetch ${i.base} and the head of ${at} (${fetched.stderr.trim() || `git exited ${fetched.status}`})`);
  const now = run(["rev-parse", headRef]).stdout.trim();
  if (now !== head) return reply(`${at} moved while this comment was read (its head is now ${short(now) || "unknown"}); comment again once its checks pass`);
  const baseSha = run(["rev-parse", baseRef]).stdout.trim();
  if (!SHA.test(baseSha)) return fail(`could not read the commit of ${i.base}`);

  let unmet: string | null;
  try {
    unmet = await i.requires(i.pr.number, head);
  } catch (e) {
    return fail(`could not ask whether ${at} is ready (${message(e)})`);
  }
  if (unmet) return reply(`${at} is not ready at ${short(head)}, so nothing is ${verb[1]}: ${unmet}. Comment again once that is fixed and its plan passes`);

  let statuses: ReadonlyArray<{ context: string; state: string }>;
  try {
    statuses = await i.statuses(head);
  } catch (e) {
    return fail(`could not read the statuses of ${short(head)} (${message(e)})`);
  }
  const unplanned = i.jobs.plan.filter((c) => statuses.find((s) => s.context === c)?.state !== "success");
  if (unplanned.length > 0) {
    return reply(`the plan of ${at} has not passed on its head ${short(head)} (${unplanned.map((c) => `\`${c}\``).join(", ")}), so nothing is ${verb[1]}; push to it or comment the plan again, then comment \`${typed}\` again`);
  }

  const diff = run(["diff", "--name-only", "--no-renames", `${baseSha}...${head}`]);
  if (diff.status !== 0) return fail(`could not list the files ${at} changes (${diff.stderr.trim()})`);
  const touched = diff.stdout.split("\n").map((l) => l.trim()).filter((f) => f && touchesPipeline(f, i.jobs.pipelineFiles));
  if (touched.length > 0) {
    return reply(`${at} changes \`${touched[0]}\`, and the ${verb[0]} runs the pipeline of ${i.base}, so it is not ${verb[1]} before merge. Merge it, then comment \`${typed}\` on it to ${verb[0]} from the merge commit`);
  }

  let locked: string[] = [];
  if (i.lock) {
    let l;
    try {
      l = await i.lock(i.pr.number, head, baseSha, i.user);
    } catch (e) {
      return fail(`could not take the locks of ${at} (${message(e)})`);
    }
    if (!l.ok) return reply(l.text);
    locked = l.targets;
  }

  const decision: BeforeMergeDecision = { pr: i.pr.number, head, base: baseSha, ...(i.wave !== undefined ? { through: i.wave } : {}), at: (i.now ?? (() => new Date().toISOString()))(), by: i.user };
  let record: BeforeMergeRecord;
  try {
    record = await i.record(decision);
    // A wave-<n> stops the waves after it at this head; an apply without one clears an earlier stop.
    await i.stop(head, i.wave !== undefined && i.wave < i.count ? i.wave : null);
  } catch (e) {
    return fail(`could not record the decision for ${short(head)}, so nothing was started (${message(e)})`);
  }
  let started: StartedRun;
  try {
    started = await i.start(record);
  } catch (e) {
    return fail(`recorded the decision for ${short(head)}, and could not start the waves (${message(e)})`);
  }
  const through = i.wave !== undefined && i.wave < i.count ? ` through wave ${i.wave}` : "";
  const locks = locked.length > 0 ? `, holding ${locked.map((x) => `\`${x}\``).join(", ")}` : "";
  const link = started.url ? ` (${started.url})` : "";
  return { kind: "ran", text: `started the waves of ${i.op}${link} on ${at}'s head ${short(head)}${through} for ${i.user}${locks}; each wave's gate decides, and the run says when the head applied`, ...(started.url ? { url: started.url } : {}) };
}
