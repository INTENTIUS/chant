/**
 * The pull request's base and head branch names, read off the run's own
 * event (#4299). Its own module so the review agent bundles without
 * predict-behaviour's estate code.
 */

/** Where the base branch name comes from, most specific first. Pure — exported for testing. */
export function baseRefFrom(
  env: Record<string, string | undefined>,
  explicit?: string,
): string | undefined {
  const fromArgs = explicit?.trim();
  if (fromArgs) return fromArgs;
  for (const source of ["GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]) {
    const value = env[source]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** What the head side is called in the finding: the source branch when the run names one, else the short commit. */
export function headRefFrom(env: Record<string, string | undefined>, shortSha?: string): string {
  for (const source of ["GITHUB_HEAD_REF", "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"]) {
    const value = env[source]?.trim();
    if (value) return value;
  }
  return shortSha?.trim() || "head";
}
