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
import { answerProductComment, COMMENT_JOBS_ENV, commentRuns, type CommentJobs } from "../../ci-comment-commands";
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
  const known = new Set(["preview", "applyBeforeMerge", "applyOnMerge", "locks", "agent", "commits", "actions", "skipForks", "targets", "noPlanFlags", "waves"]);
  const jobs: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!known.has(k)) throw new Error(`${COMMENT_JOBS_ENV} names ${JSON.stringify(k)}, which is not one of ${[...known].join(", ")}`);
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
  return jobs as CommentJobs;
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
