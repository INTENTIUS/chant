/**
 * `@intentius/chant/ci-base` (#4966): the base a CI job measures a change
 * from, read off the job's own variables, so a product's check and policy
 * steps need no rule of their own for it (terragucci's `policyBase`).
 *
 * - A pull request's job: its target branch, `origin/<target>`
 *   (`GITHUB_BASE_REF` on GitHub and Forgejo, GitLab's
 *   `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`).
 * - A push to a branch other than the default branch: `origin/<default>`,
 *   so a change that edits a check or a policy on a side branch is still
 *   judged by the default branch's.
 * - A push to the default branch, or a job with no branch: no base, and
 *   the checkout's own files are the trusted ones.
 *
 * `chant ci check` takes it as its `--base` when none is given.
 *
 * This module imports nothing.
 */

export interface CiBaseOptions {
  /** A base the caller already has (a flag, a product's own variable); it wins over everything. */
  base?: string;
  /** The default branch. Default GitLab's `CI_DEFAULT_BRANCH`; GitHub and Forgejo jobs carry none, so a product passes its own. */
  defaultBranch?: string;
  /** The remote the branches are fetched from. Default `origin`. */
  remote?: string;
}

const set = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

/** The base ref for the job `env` describes, as the module comment says; undefined when there is none. */
export function ciBaseRef(env: Record<string, string | undefined> = process.env, options: CiBaseOptions = {}): string | undefined {
  const given = set(options.base);
  if (given) return given;
  const remote = options.remote ?? "origin";
  const target = set(env.GITHUB_BASE_REF) ?? set(env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME);
  if (target) return `${remote}/${target}`;
  const branch = set(env.GITHUB_REF_NAME) ?? set(env.CI_COMMIT_BRANCH);
  const main = set(options.defaultBranch) ?? set(env.CI_DEFAULT_BRANCH);
  return branch && main && branch !== main ? `${remote}/${main}` : undefined;
}

export { CI_BASE_REF_FLOOR } from "./release-floors";
