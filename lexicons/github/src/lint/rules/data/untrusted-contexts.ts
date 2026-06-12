/**
 * Vendored snapshot of GitHub Actions expression contexts that are
 * attacker-controllable — their values come from event payloads a fork or an
 * outside contributor can set. Interpolating them into a shell (`run:`), into
 * `GITHUB_ENV`/`GITHUB_PATH`, or into another execution sink turns data into
 * code (script injection).
 *
 * Source: GitHub's "Security hardening for GitHub Actions — understanding the
 * risk of script injections" plus the commonly-cited untrusted-context list.
 * Advisory and necessarily incomplete; refresh by editing this list.
 */
export const UNTRUSTED_CONTEXTS: readonly string[] = [
  "github.event.issue.title",
  "github.event.issue.body",
  "github.event.pull_request.title",
  "github.event.pull_request.body",
  "github.event.pull_request.head.ref",
  "github.event.pull_request.head.label",
  "github.event.pull_request.head.repo.default_branch",
  "github.event.comment.body",
  "github.event.review.body",
  "github.event.review_comment.body",
  "github.event.discussion.title",
  "github.event.discussion.body",
  "github.event.head_commit.message",
  "github.event.head_commit.author.email",
  "github.event.head_commit.author.name",
  "github.event.commits", // .*.message / .*.author.* (array — matched by prefix)
  "github.event.pages", // .*.page_name
  "github.head_ref",
];

/**
 * Return the first untrusted context referenced inside an expression body, or
 * undefined. Matches by substring so array element accesses
 * (`github.event.commits[0].message`) are caught via their prefix.
 */
export function matchUntrustedContext(exprBody: string): string | undefined {
  const normalized = exprBody.replace(/\s+/g, "");
  for (const ctx of UNTRUSTED_CONTEXTS) {
    if (normalized.includes(ctx.replace(/\s+/g, ""))) return ctx;
  }
  return undefined;
}
