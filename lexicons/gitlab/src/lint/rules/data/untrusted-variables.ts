/**
 * Vendored snapshot of GitLab CI predefined variables whose values are
 * attacker-controllable — branch/tag names, commit and merge-request titles and
 * descriptions, author identity. Interpolating these into a `script:` (or using
 * them as a gate) lets a crafted branch name or commit title influence what runs.
 *
 * Source: GitLab "Predefined CI/CD variables" reference, filtered to the values
 * an outside contributor can set on a fork or merge request. Advisory and
 * necessarily incomplete; editing this list is the refresh mechanism.
 */
export const UNTRUSTED_CI_VARIABLES: readonly string[] = [
  "CI_COMMIT_TITLE",
  "CI_COMMIT_MESSAGE",
  "CI_COMMIT_DESCRIPTION",
  "CI_COMMIT_REF_NAME",
  "CI_COMMIT_REF_SLUG",
  "CI_COMMIT_BRANCH",
  "CI_COMMIT_TAG",
  "CI_COMMIT_AUTHOR",
  "CI_MERGE_REQUEST_TITLE",
  "CI_MERGE_REQUEST_DESCRIPTION",
  "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME",
  "CI_MERGE_REQUEST_SOURCE_BRANCH_SHA",
  "CI_EXTERNAL_PULL_REQUEST_SOURCE_BRANCH_NAME",
];

/** Reference forms a variable can take in a script: `$VAR` or `${VAR}`. */
export function variableReferenced(text: string, name: string): boolean {
  const re = new RegExp(`\\$\\{?${name}\\}?(?![A-Z0-9_])`);
  return re.test(text);
}
