/**
 * The replies to comment commands no job runs (#4946), shared by the GitLab
 * note poll (./ci-note-commands.ts) and the GitHub and Forgejo comment job
 * (./ci-comment-commands.ts), so the two forges answer a command the same
 * way and a product's own sentences (`words.replies`) reach both.
 *
 * A reply names the forge's things in the forge's words: `!12`, a merge
 * request and a project on GitLab; pull request 12 and a repository on
 * GitHub and Forgejo. GitLab's sentences are the ones the note poll wrote
 * before #4946.
 *
 * This module imports nothing at run time.
 */

import type { CiProductCommand, CiProductCommentReplies, CiProductWords } from "./ci-product-words";
import type { ForgeKind } from "./pr-forge";

/** How a reply names the forge's things. */
export interface CommentTerms {
  /** The pull request by number: `!12`, or `pull request 12`. */
  at(n: number): string;
  /** `merge request` or `pull request`. */
  request: string;
  /** `project` or `repository`. */
  place: string;
}

/** The terms for `forge`. */
export function commentTerms(forge: ForgeKind): CommentTerms {
  return forge === "gitlab"
    ? { at: (n) => `!${n}`, request: "merge request", place: "project" }
    : { at: (n) => `pull request ${n}`, request: "pull request", place: "repository" };
}

/** `/<product> <word>` in backticks, for the word the words map onto `command`. */
export function commandLine(words: CiProductWords, command: CiProductCommand): string {
  return `\`/${words.product} ${Object.entries(words.commands).find(([, c]) => c === command)?.[0] ?? command}\``;
}

/** The commands no job runs, by the slot a product's reply fills. */
export type NotRunCommand = Exclude<keyof CiProductCommentReplies, "fork" | "member">;

/**
 * The reply to a command the pipeline runs no job for: the product's
 * sentence when its words give one, else chant's.
 */
export function notRunReply(words: CiProductWords, command: NotRunCommand, forge: ForgeKind): string {
  const own = words.replies?.[command];
  if (own !== undefined) return own;
  const t = commentTerms(forge);
  switch (command) {
    case "plan":
      return `this ${t.place} ${words.verbs.plan[0]}s a ${t.request} on each push to it, and no job ${words.verbs.plan[0]}s on a comment`;
    case "apply":
      return `this ${t.place} does not ${words.verbs.apply[0]} on a comment: re-run the ${words.verbs.apply[0]} job on the forge, or push to the default branch again`;
    case "lock":
    case "unlock":
      return `${commandLine(words, command)} does not run here: this ${t.place} takes no locks`;
    case "action":
      return `this ${t.place} has no workflow that runs actions, so ${commandLine(words, "action")} does not run`;
    case "agent":
      return `the agent command is off in this ${t.place}`;
  }
}

/** The reply to a command on a pull request from a fork. */
export function forkReply(words: CiProductWords, forge: ForgeKind): string {
  const t = commentTerms(forge);
  return words.replies?.fork ?? `a ${t.request} from a fork runs no command: its code never runs with this ${t.place}'s credentials`;
}

/** The reply to a comment that names a member the pipeline was not written with. */
export function memberReply(words: CiProductWords, member: string, members: readonly string[], forge: ForgeKind): string {
  const listed = [...members].sort().map((m) => `\`${m}\``).join(", ");
  const own = words.replies?.member;
  if (own !== undefined) return own.split("{member}").join(member).split("{members}").join(listed);
  return `${member} is not a ${words.noun[0]} of this ${commentTerms(forge).place}. The ${words.noun[1]} are ${listed}.`;
}
