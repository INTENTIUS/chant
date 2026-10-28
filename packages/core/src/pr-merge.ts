/**
 * Auto merge after an update before merge (#4636): `pr-apply --before-merge
 * --merge auto --merge-token-env <VAR>` merges the pull request once every
 * member applied and the apply's records are on the ledger's remote.
 *
 * The merge is a second step after the apply, and never a reason to apply
 * again:
 *
 * - The records come first. The apply's release records and gate facts are
 *   pushed to `chant/lifecycle`; a push that did not land leaves the pull
 *   request open with the reason posted.
 * - The head is checked again. The pull request must still be open at the
 *   commit that applied, and the forge's merge is asked to merge only that
 *   commit, so a push after the apply is never merged unapplied.
 * - A refusal (branch protection, a new push, a conflict, a closed pull
 *   request) is posted on the pull request in one comment the next attempt
 *   edits, and the apply stays as it was recorded.
 * - The merge's forge client holds the token `--merge-token-env` names and
 *   no other: never the plan job's token, nor the apply job's own. On GitLab
 *   the variable is a protected one.
 */

import { activeProductWords, type CiProductWords } from "./ci-product-words";
import type { MergeOptions, PrForge } from "./pr-forge";

/** How a pull request applied before merge gets merged. */
export type PrApplyMerge = "manual" | "auto";

export const PR_APPLY_MERGES: readonly PrApplyMerge[] = ["manual", "auto"];

export type PrMergeMethod = NonNullable<MergeOptions["method"]>;

export const PR_MERGE_METHODS: readonly PrMergeMethod[] = ["merge", "squash", "rebase"];

/** The marker of the comment a refused merge posts. */
export function prMergeMarker(pr: number): string {
  return `<!-- chant:merge:${pr} -->`;
}

/** What {@link mergeAfterApply} did. */
export interface MergeAfterApply {
  merged: boolean;
  /** The merge commit, when the forge says. */
  sha?: string;
  /** Why it was not merged. */
  reason?: string;
  /** The refusal was posted on the pull request. */
  posted?: boolean;
}

export interface MergeAfterApplyInput {
  /** The client built from the merge token alone. */
  forge: Pick<PrForge, "kind" | "mergePullRequest" | "pullRequestHead" | "upsertComment">;
  pr: number;
  /** The commit that applied. */
  head: string;
  method?: PrMergeMethod;
  /** Whether the apply's records reached the ledger's remote, and why not. */
  recorded: { pushed: boolean; warning?: string };
  words?: CiProductWords;
}

const short = (sha: string): string => sha.slice(0, 12);

/** Merge the pull request after its update applied. Never throws; a refusal is posted and returned. */
export async function mergeAfterApply(i: MergeAfterApplyInput): Promise<MergeAfterApply> {
  const words = i.words ?? activeProductWords();
  const what = i.forge.kind === "gitlab" ? `Merge request !${i.pr}` : `Pull request ${i.pr}`;
  const refuse = async (reason: string): Promise<MergeAfterApply> => {
    const body = `${prMergeMarker(i.pr)}\n${what} was not merged: ${reason}. The ${words.verbs.apply[0]} of ${short(i.head)} stays applied and recorded; it is never applied again to merge. Merge it by hand once the reason is gone, or ${words.verbs.apply[0]} again after a new push.\n`;
    try {
      await i.forge.upsertComment(i.pr, prMergeMarker(i.pr), body);
      return { merged: false, reason, posted: true };
    } catch {
      return { merged: false, reason, posted: false };
    }
  };
  if (!i.recorded.pushed) return refuse(`the ${words.verbs.apply[0]}'s records are not on the ledger's remote${i.recorded.warning ? ` (${i.recorded.warning})` : ""}`);
  try {
    if (i.forge.pullRequestHead) {
      const now = await i.forge.pullRequestHead(i.pr);
      if (!now) return refuse("the forge could not say its head");
      if (!now.open) return refuse("it is no longer open");
      if (now.sha !== i.head) return refuse(`its head is ${short(now.sha)} now, not ${short(i.head)}, the commit that applied`);
    }
    const merged = await i.forge.mergePullRequest(i.pr, { sha: i.head, ...(i.method ? { method: i.method } : {}) });
    if (!merged.merged) return refuse(merged.reason ?? "the forge refused the merge");
    return { merged: true, ...(merged.sha ? { sha: merged.sha } : {}) };
  } catch (err) {
    return refuse(`the forge answered ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The environment a merge client reads its token from: the job's, with the
 * named variable as the only token and every other forge token left out.
 */
export function mergeTokenEnv(tokenEnv: string, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> | { error: string } {
  const token = env[tokenEnv]?.trim();
  if (!token) return { error: `--merge-token-env names ${tokenEnv}, which is not set in this job` };
  const out: Record<string, string | undefined> = { ...env };
  for (const name of ["CHANT_FORGE_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "CI_JOB_TOKEN", "FORGEJO_TOKEN", "CHANT_GITHUB_TOKEN", "CHANT_GITLAB_TOKEN", "CHANT_FORGEJO_TOKEN"]) delete out[name];
  out.CHANT_FORGE_TOKEN = token;
  return out;
}
