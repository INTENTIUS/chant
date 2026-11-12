/**
 * The forge client a chant command in a CI job posts with (#4964): the
 * pull request loop's {@link forgeFromEnv}, with each commit status for the
 * run's own commit put on the pull request's head.
 *
 * A GitHub `pull_request` run checks out `GITHUB_SHA`, the merge preview
 * (`refs/pull/<n>/merge`), and the loop's jobs plan, check and sign that
 * commit, as a merge would make it. The forge shows no status of that commit
 * on the pull request, and a required status is read from the head, so a
 * status the plan note, the check evidence or the ref gate sets for it goes
 * on `pull_request.head.sha` instead. Forgejo's run is of the head already,
 * and so is a status for any other commit; both are posted as asked. GitLab
 * is left as it is: its merge request pipeline runs on the head.
 *
 * Kept out of ./pr-forge.ts, whose bundle a product posts with.
 */

import { readFileSync } from "node:fs";
import { forgeFromEnv, type ForgeKind, type PrForge } from "./pr-forge";

/** The pull request's head from a GitHub-style `pull_request` run's event payload, or undefined for any other run. */
export function pullRequestEventHead(env: Record<string, string | undefined>): string | undefined {
  if (!env.GITHUB_EVENT_NAME?.startsWith("pull_request") || !env.GITHUB_EVENT_PATH) return undefined;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { head?: { sha?: unknown } } };
    const sha = event.pull_request?.head?.sha;
    return typeof sha === "string" && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The commit a GitHub `pull_request` run's plan job checked out for `head`
 * when it is not `head` (#5020): the run's merge preview, `GITHUB_SHA`, when
 * `head` is the event's pull request head. The note job names the head, and
 * takes a report for the merge preview as the head's. Undefined on any other
 * run, on Forgejo (whose run is of the head) and on GitLab.
 */
export function plannedForHead(head: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const merge = env.GITHUB_SHA;
  if (!merge || merge === head || !/^[0-9a-f]{40,64}$/.test(merge)) return undefined;
  return pullRequestEventHead(env) === head ? merge : undefined;
}

/** {@link forgeFromEnv}, whose statuses for the run's merge preview go on the pull request's head (#4964). */
export function forgeFromJobEnv(kind: ForgeKind, env: Record<string, string | undefined> = process.env, fetchImpl?: Parameters<typeof forgeFromEnv>[2]): PrForge {
  const forge = forgeFromEnv(kind, env, fetchImpl);
  const merge = env.GITHUB_SHA;
  const head = kind === "gitlab" ? undefined : pullRequestEventHead(env);
  if (!head || !merge || head === merge) return forge;
  const at = (sha: string): string => (sha === merge ? head : sha);
  const { setStatus, setCommitStatus } = forge;
  return {
    ...forge,
    setStatus: (sha, status) => setStatus(at(sha), status),
    ...(setCommitStatus ? { setCommitStatus: (sha: string, status: Parameters<typeof setCommitStatus>[1]) => setCommitStatus(at(sha), status) } : {}),
  };
}
