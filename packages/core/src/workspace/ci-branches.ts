/**
 * Branch routing and label filters for the pull-request loop (#4292).
 *
 * `ci.branches` maps a branch to member-name globs. A member a glob matches
 * applies from that branch: its generated pull-request pipeline targets it,
 * and its record or apply job does nothing on a push to any other branch. A
 * member no glob matches applies from every branch but those, the default
 * branch included. terragucci's `apply.branches` (`branchLayers`) works the
 * same way over Terraform roots.
 *
 * `ci.labels` maps a pull request label to member-name globs. When a pull
 * request carries one of the labels, its plan job plans only the members
 * those labels' globs match, and every other member's plan job plans
 * nothing. A label never gates: the record and apply jobs on the push never
 * read labels, and an apply still waits for an approval of the digest it
 * plans. Anyone with triage access can set a label, so a label may narrow
 * what a reviewer sees ahead of the merge and no more.
 */

// @ts-ignore: picomatch has no types declaration
import picomatch from "picomatch";

/** Branch or label name to member-name globs. */
export type MemberGlobs = Readonly<Record<string, readonly string[]>>;

const matches = (globs: readonly string[], member: string): boolean => globs.some((g) => (picomatch(g) as (s: string) => boolean)(member));

/** The keys of `map` whose globs match `member`, in declaration order. */
export function keysMatching(map: MemberGlobs | undefined, member: string): string[] {
  return Object.keys(map ?? {}).filter((k) => matches(map![k]!, member));
}

/** The branch `ci.branches` routes `member` to, or null when no glob matches it. */
export function routedBranch(branches: MemberGlobs | undefined, member: string): string | null {
  return keysMatching(branches, member)[0] ?? null;
}

/** Each member that two branches' globs match, with the branches. The declaration refuses these. */
export function routeConflicts(branches: MemberGlobs | undefined, members: readonly string[]): Array<{ member: string; branches: string[] }> {
  return members.map((member) => ({ member, branches: keysMatching(branches, member) })).filter((c) => c.branches.length > 1);
}

/**
 * Whether a push to `pushed` applies `member`, with a line that says why.
 * A routed member applies only from its branch. Any other member applies
 * from every branch `ci.branches` does not name.
 */
export function appliesFrom(branches: MemberGlobs | undefined, member: string, pushed: string): { applies: boolean; note: string } {
  const own = routedBranch(branches, member);
  if (own !== null) {
    return own === pushed
      ? { applies: true, note: `ci.branches: ${pushed} applies member ${member}` }
      : { applies: false, note: `ci.branches: member ${member} applies from ${own}, not ${pushed}` };
  }
  if (Object.prototype.hasOwnProperty.call(branches ?? {}, pushed)) {
    return { applies: false, note: `ci.branches: ${pushed} applies only the members its globs match, and member ${member} is not one` };
  }
  return { applies: true, note: `ci.branches: member ${member} is routed to no branch, so ${pushed} applies it` };
}

/**
 * Whether a pull request's plan job plans `member`, given the labels the pull
 * request carries. With none of `ci.labels` on the pull request every member
 * plans. With some, a member plans only when one of those labels' globs
 * matches it.
 */
export function plansUnderLabels(labels: MemberGlobs | undefined, member: string, carried: readonly string[]): { plans: boolean; note?: string } {
  const set = carried.filter((l) => Object.prototype.hasOwnProperty.call(labels ?? {}, l));
  if (set.length === 0) return { plans: true };
  const by = set.filter((l) => matches(labels![l]!, member));
  return by.length > 0
    ? { plans: true, note: `ci.labels: ${by.join(", ")} plan${by.length === 1 ? "s" : ""} member ${member}` }
    : { plans: false, note: `ci.labels: the pull request's labels ${set.join(", ")} plan other members, so member ${member} is not planned here; its record and apply on merge still plan it` };
}

/** The branch the job runs on, from the forge's own variables: GitHub and Forgejo's GITHUB_REF_NAME, GitLab's CI_COMMIT_BRANCH. */
export function pushedBranchFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.CI_COMMIT_BRANCH || (env.GITHUB_REF_TYPE === undefined || env.GITHUB_REF_TYPE === "branch" ? env.GITHUB_REF_NAME : undefined) || undefined;
}
