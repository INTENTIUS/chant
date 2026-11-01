/**
 * Which remote `chant/lifecycle` is fetched from and pushed to (#4647).
 *
 * By default the ledger lives on `origin`, or on the first remote when there
 * is no `origin`. `CHANT_LIFECYCLE_REMOTE=<name>` names another one, for a
 * checkout whose `origin` is not where the ledger belongs (a deploy box that
 * clones from a mirror, say). Every read and write of the ledger goes through
 * here: the fetch, the push and its lease, the remote-tracking ref
 * `refs/remotes/<remote>/chant/lifecycle`, and the lease and lock refs pushed
 * beside the branch.
 *
 * A name the repository has no remote by is an error, never a fallback to
 * `origin`: a ledger pushed to the wrong remote is what the setting exists to
 * prevent.
 *
 * Kept free of git and the runtime adapter, so the synchronous readers (the
 * trust checks, `ci base`, ci-serve) can use it too.
 */

/** The environment variable that names the ledger's remote. */
export const LIFECYCLE_REMOTE_ENV = "CHANT_LIFECYCLE_REMOTE";

/** The remote `CHANT_LIFECYCLE_REMOTE` names, or undefined when it is unset or empty. */
export function lifecycleRemoteOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[LIFECYCLE_REMOTE_ENV]?.trim();
  return value ? value : undefined;
}

/** What {@link chooseLedgerRemote} found: a remote, no remote at all, or a setting that names none of them. */
export type LedgerRemoteChoice = { remote: string } | { failed: true; stderr: string; named?: string } | null;

/**
 * The ledger's remote among `names`, the output of `git remote`: the one
 * `CHANT_LIFECYCLE_REMOTE` names, else `origin`, else the first. Null when
 * there is no remote and nothing is named.
 */
export function chooseLedgerRemote(names: readonly string[], env: NodeJS.ProcessEnv = process.env): LedgerRemoteChoice {
  const named = lifecycleRemoteOverride(env);
  if (named !== undefined) {
    if (names.includes(named)) return { remote: named };
    const have = names.length === 0 ? "this repository has no remotes" : `this repository's remotes are ${names.join(", ")}`;
    return { failed: true, stderr: `${LIFECYCLE_REMOTE_ENV} names the remote "${named}", and ${have}`, named };
  }
  if (names.length === 0) return null;
  return { remote: names.includes("origin") ? "origin" : names[0] };
}
