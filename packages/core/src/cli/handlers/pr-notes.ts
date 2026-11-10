/**
 * `chant components pr-notes --forge gitlab` (#4785): the note-commands job.
 *
 * GitLab starts no pipeline on a note, so a scheduled pipeline of the default
 * branch runs this: it reads the merge requests' notes through chant's forge
 * reads, and for each new command from a Developer or above starts the job
 * that answers it (`../../ci-note-commands.ts`). The flags name the jobs the
 * pipeline has, as `chant build --pr-loop --note-commands` wrote them. Each
 * answered note is recorded on `chant/lifecycle`.
 */

import { resolve } from "node:path";
import { activeProductWords } from "../../ci-product-words";
import { chantNoteRuns, gitlabPipelines, ledgerNoteLog, pollNoteCommands } from "../../ci-note-commands";
import { COMMENT_JOBS_ENV, type CommentJobs } from "../../ci-comment-commands";
import { beforeMergeDeps, commentJobsFromEnv } from "./pr-comment";
import { forgeFromEnv, forgeTargetFromEnv, type PrForge } from "../../pr-forge";
import { forgeReadsFor } from "../../pr-forge-reads";
import { formatError, formatInfo, formatWarning } from "../format";
import type { CommandContext } from "../registry";

const fail = (message: string): number => {
  console.error(formatError({ message }));
  return 1;
};

export async function runComponentsPrNotes(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.forge !== "gitlab") return fail("pr-notes polls GitLab's merge request notes: --forge gitlab (GitHub and Forgejo start a workflow on a comment)");
  const env = process.env;
  const base = args.branch ?? env.CI_DEFAULT_BRANCH;
  if (!base) return fail("pr-notes needs the target branch: --branch <name>, or CI_DEFAULT_BRANCH in the environment");
  let forge: PrForge;
  let target: ReturnType<typeof forgeTargetFromEnv>;
  try {
    forge = forgeFromEnv("gitlab", env);
    target = forgeTargetFromEnv(env, { kind: "gitlab" });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const cwd = resolve(".");
  const { fetchLifecycle } = await import("../../lifecycle/git");
  // The ledger keeps the notes answered: read it as the remote has it.
  await fetchLifecycle({ cwd });
  const words = activeProductWords();
  // #4984: the waves' op and count, and the waves before merge, as the pipeline wrote them in CHANT_COMMENT_JOBS.
  let more: CommentJobs;
  try {
    more = commentJobsFromEnv(env[COMMENT_JOBS_ENV]);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const beforeMerge = more.wavesBeforeMerge && more.waves ? await beforeMergeDeps(forge, more, env) : undefined;
  const polled = await pollNoteCommands({
    reads: forgeReadsFor(target),
    forge,
    pipelines: gitlabPipelines({ apiBase: target.apiBase, project: target.repo, token: target.token, host: target.host, ...(target.tokenHeader ? { tokenHeader: target.tokenHeader } : {}) }),
    words,
    base,
    runs: chantNoteRuns(
      {
        ...(args.previewComment ? { preview: true } : {}),
        ...(args.applyBeforeMerge ? { applyBeforeMerge: true } : {}),
        ...(args.applyOnMerge ? { applyOnMerge: true } : {}),
        ...(args.locks ? { locks: true } : {}),
        ...(more.waves ? { waves: more.waves } : {}),
        ...(more.wavesBeforeMerge ? { wavesBeforeMerge: more.wavesBeforeMerge } : {}),
      },
      beforeMerge ? { beforeMerge } : {},
    ),
    log: ledgerNoteLog({ cwd }),
    env,
    // #4984: a merged merge request's wave-<n> stops the retried waves after it.
    ...(more.waves
      ? {
          stops: async (op, sha, stop) => {
            const { setWaveStop } = await import("../../op/wave-stop");
            await setWaveStop(op, sha, stop, { cwd });
          },
        }
      : {}),
  });
  let failed = polled.fail !== undefined;
  for (const o of polled.outcomes) {
    const line = `pr-notes: !${o.mr} note ${o.note}: ${o.reason}`;
    if (o.fail) {
      failed = true;
      console.error(formatWarning({ message: line }));
    } else console.error(formatInfo(line));
  }
  if (polled.fail) console.error(formatError({ message: `pr-notes: ${polled.fail}` }));
  if (polled.outcomes.length === 0 && !polled.fail) console.error(formatInfo("pr-notes: no new command"));
  return failed ? 1 : 0;
}
