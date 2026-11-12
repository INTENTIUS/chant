/**
 * `chant components pr-comment --forge github|forgejo` (#4946): the comment
 * job of GitHub's and Forgejo's product pipeline.
 *
 * It reads the `issue_comment` event from `GITHUB_EVENT_PATH`, and the jobs
 * the pipeline has from `CHANT_COMMENT_JOBS` (JSON, written by the
 * generator), and answers the comment when no other job of the pipeline
 * does (`../../ci-comment-commands.ts`): a refusal, a command no job runs,
 * or the re-run of a merged pull request's apply. The words are the
 * product's, as its bin set them.
 *
 * It runs at the target branch's commit with the job's token
 * (`GITHUB_TOKEN`), so none of the change's code runs here, and it loads no
 * plugins.
 */

import { readFileSync } from "node:fs";
import { activeProductWords } from "../../ci-product-words";
import { answerProductComment, COMMENT_JOBS_ENV, commentRuns, type CommentBeforeMerge, type CommentJobs } from "../../ci-comment-commands";
import type { WavesBeforeMergeJobs } from "../../op/before-merge-decide";
import { PR_APPLY_REQUIRES } from "../../pr-requires";
import { forgeFromEnv, forgeTargetFromEnv, type PrForge } from "../../pr-forge";
import { forgeReadsFor } from "../../pr-forge-reads";
import { formatError, formatInfo } from "../format";
import type { CommandContext } from "../registry";

const fail = (message: string): number => {
  console.error(formatError({ message }));
  return 1;
};

/** The jobs named in {@link COMMENT_JOBS_ENV}: each a boolean, `targets` a list of names, and anything else is refused. */
export function commentJobsFromEnv(raw: string | undefined): CommentJobs {
  if (raw === undefined || raw.trim() === "") return {};
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${COMMENT_JOBS_ENV} is a JSON object of the jobs the pipeline has`);
  const known = new Set(["preview", "applyBeforeMerge", "applyOnMerge", "locks", "agent", "commits", "actions", "skipForks", "targets", "noPlanFlags", "waves", "wavesBeforeMerge"]);
  const jobs: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!known.has(k)) throw new Error(`${COMMENT_JOBS_ENV} names ${JSON.stringify(k)}, which is not one of ${[...known].join(", ")}`);
    // #4984: the waves before merge.
    if (k === "wavesBeforeMerge") {
      jobs.wavesBeforeMerge = wavesBeforeMergeOf(x);
      continue;
    }
    // #4979: the waves' op and count, for a wave stop on a re-run.
    if (k === "waves") {
      const w = x as { op?: unknown; count?: unknown } | null;
      if (!w || typeof w !== "object" || typeof w.op !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(w.op) || !Number.isInteger(w.count) || (w.count as number) < 1) throw new Error(`${COMMENT_JOBS_ENV}.waves is { op, count }: the waves' op name and how many waves there are`);
      jobs.waves = { op: w.op, count: w.count };
      continue;
    }
    if (k === "targets") {
      if (!Array.isArray(x) || x.some((t) => typeof t !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(t))) throw new Error(`${COMMENT_JOBS_ENV}.targets is a list of target names`);
      if (x.length > 0) jobs.targets = x;
      continue;
    }
    if (typeof x !== "boolean") throw new Error(`${COMMENT_JOBS_ENV}.${k} is true or false`);
    if (x) jobs[k] = true;
  }
  if (jobs.wavesBeforeMerge && !jobs.waves) throw new Error(`${COMMENT_JOBS_ENV}.wavesBeforeMerge needs waves: { op, count }, the waves it starts`);
  return jobs as CommentJobs;
}

/** {@link COMMENT_JOBS_ENV}'s `wavesBeforeMerge` (#4984), each field checked, since the comment job pushes and dispatches with what it names. */
export function wavesBeforeMergeOf(x: unknown): WavesBeforeMergeJobs {
  const what = `${COMMENT_JOBS_ENV}.wavesBeforeMerge`;
  const o = x as Partial<WavesBeforeMergeJobs> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${what} is { workflow?, inputs?, requires?, plan, pipelineFiles, locks? }`);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "" && !/[\r\n]/.test(s));
  if (o.workflow !== undefined && (typeof o.workflow !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(o.workflow))) throw new Error(`${what}.workflow is a workflow file name, like deploy.yml`);
  if (o.requires !== undefined && (!Array.isArray(o.requires) || o.requires.some((r) => !(PR_APPLY_REQUIRES as readonly string[]).includes(r)))) throw new Error(`${what}.requires is a list of ${PR_APPLY_REQUIRES.join(", ")}`);
  if (!strings(o.plan)) throw new Error(`${what}.plan is the list of plan statuses that must pass on the head`);
  if (!strings(o.pipelineFiles)) throw new Error(`${what}.pipelineFiles is the list of paths a change may not touch`);
  if (o.locks !== undefined && (typeof o.locks !== "object" || o.locks === null || (o.locks.gate !== undefined && (typeof o.locks.gate !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(o.locks.gate))))) throw new Error(`${what}.locks is { gate? }`);
  // #5022: the waves workflow's input names, the product's.
  const inputs = o.inputs;
  if (inputs !== undefined && (typeof inputs !== "object" || inputs === null || Object.entries(inputs).some(([k, n]) => !["pr", "head", "digest"].includes(k) || typeof n !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(n)))) throw new Error(`${what}.inputs names the inputs pr, head and digest`);
  return {
    ...(o.workflow ? { workflow: o.workflow } : {}),
    ...(inputs ? { inputs: { ...inputs } } : {}),
    ...(o.requires ? { requires: [...o.requires] } : {}),
    plan: [...o.plan],
    pipelineFiles: [...o.pipelineFiles],
    ...(o.locks ? { locks: { ...(o.locks.gate ? { gate: o.locks.gate } : {}) } } : {}),
  };
}

/**
 * What the decision before merge reads and writes with (#4984), in the
 * comment job (GitHub, Forgejo) and the note poll (GitLab): the requires
 * and statuses through the job's client, git in the checkout of the
 * default branch, the reach line's locks at stage apply, and the decision
 * and the wave stop on this checkout's `chant/lifecycle`.
 */
export async function beforeMergeDeps(forge: PrForge, jobs: CommentJobs, env: NodeJS.ProcessEnv = process.env): Promise<CommentBeforeMerge> {
  const bm = jobs.wavesBeforeMerge!;
  const op = jobs.waves!.op;
  const { spawnSync } = await import("node:child_process");
  const { checkPrRequires, unmetRequires } = await import("../../pr-requires");
  const { productStatusContext, activeProductWords } = await import("../../ci-product-words");
  const { LOCK_REACH_ENV, reachedTargets } = await import("../../lifecycle/reach-locks");
  const { takeTargetLocks, describeHeldTargetLocks } = await import("../../lifecycle/target-lock");
  const { recordBeforeMerge } = await import("../../op/before-merge-store");
  const { setWaveStop } = await import("../../op/wave-stop");
  const { PR_APPLY_GATE } = await import("../../pr-loop");
  const words = activeProductWords();
  const line = env[LOCK_REACH_ENV];
  const name = (n: number) => (forge.kind === "gitlab" ? `!${n}` : `pull request ${n}`);
  return {
    // The plan and apply statuses never hold the apply back: the plan status is asked for by name (#5003: the product plan's own names too).
    requires: async (pr, head) => unmetRequires(await checkPrRequires(forge, pr, head, { ignore: [...new Set([productStatusContext(words, "apply"), productStatusContext(words, "plan"), `${productStatusContext(words, "plan")}/`, ...bm.plan])], ...(bm.requires ? { only: bm.requires } : {}) })),
    statuses: async (sha) => (await forge.commitStatuses?.(sha)) ?? [],
    git: (argv, o) => {
      const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", ...(o.cwd ? { cwd: o.cwd } : {}) });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : (r.stderr ?? "") };
    },
    // #4979's reach line says what the change reaches; the locks go up at stage apply, refused while another holds one.
    ...(line && line.trim()
      ? {
          lock: async (pr: number, head: string, base: string, by: string) => {
            const reached = reachedTargets({ forge: forge.kind, pr, head, base, line });
            if ("error" in reached) throw new Error(reached.error);
            if ("moved" in reached) return { ok: false as const, text: `${name(pr)} moved while this comment was read, so nothing is ${words.verbs.apply[1]}; comment again once its checks pass` };
            const isOpen = forge.pullRequestOpen?.bind(forge);
            const r = await takeTargetLocks(bm.locks?.gate ?? PR_APPLY_GATE, reached.targets, { pr, by, at: new Date().toISOString(), stage: "apply", head }, { ...(isOpen ? { isOpen } : {}) });
            if (!r.ok) {
              const request = forge.kind === "gitlab" ? "merge request" : "pull request";
              return { ok: false as const, text: `${describeHeldTargetLocks(r.held, name)}, so ${name(pr)} is not ${words.verbs.apply[1]}. It ${words.verbs.apply[0]}s once that ${request} merges or closes, or someone with write access unlocks it` };
            }
            return { ok: true as const, targets: r.taken };
          },
        }
      : {}),
    record: (d) => recordBeforeMerge(op, d),
    stop: async (head, through) => {
      await setWaveStop(op, head, through === null ? null : { through, at: new Date().toISOString() });
    },
  };
}

export async function runComponentsPrComment(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const kind = args.forge;
  if (kind !== "github" && kind !== "forgejo") return fail("pr-comment answers a GitHub or Forgejo comment: --forge github|forgejo (GitLab's notes are polled by pr-notes)");
  const env = process.env;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) return fail("pr-comment reads the comment from the event file, and GITHUB_EVENT_PATH is not set");
  let event: unknown;
  let jobs: CommentJobs;
  let poster: PrForge;
  let target: ReturnType<typeof forgeTargetFromEnv>;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8"));
    jobs = commentJobsFromEnv(env[COMMENT_JOBS_ENV]);
    poster = forgeFromEnv(kind, env);
    target = forgeTargetFromEnv(env, { kind });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const repository = (event as { repository?: { default_branch?: unknown } } | null)?.repository;
  const base = args.branch ?? (typeof repository?.default_branch === "string" ? repository.default_branch : undefined);
  if (!base) return fail("pr-comment needs the default branch: --branch <name>, or repository.default_branch in the event");
  const outcome = await answerProductComment({
    forge: kind,
    event,
    repo: target.repo,
    reads: forgeReadsFor(target),
    poster,
    runs: commentRuns({ apiBase: target.apiBase, repo: target.repo, token: target.token }),
    words: activeProductWords(),
    base,
    jobs,
    env,
    // #4984: the decision before merge, its record and its wave stop on this checkout's chant/lifecycle.
    ...(jobs.wavesBeforeMerge ? { beforeMerge: await beforeMergeDeps(poster, jobs, env) } : {}),
    // #4979: the wave stop goes on this checkout's chant/lifecycle, which the job pushes with its token.
    ...(jobs.waves
      ? {
          stops: async (op, sha, stop) => {
            const { setWaveStop } = await import("../../op/wave-stop");
            await setWaveStop(op, sha, stop);
          },
        }
      : {}),
  });
  const line = `pr-comment: ${outcome.reason}`;
  if (outcome.fail) return fail(line);
  console.error(formatInfo(line));
  return 0;
}
