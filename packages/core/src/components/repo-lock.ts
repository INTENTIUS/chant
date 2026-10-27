/**
 * The `repo` lock grain in a generated pipeline (#4552): one apply at a time
 * in the repository. GitHub runs the apply jobs in one concurrency group,
 * GitLab in one resource group, and Forgejo, whose runner does not queue on
 * a concurrency group, through a lock tag on the remote,
 * `refs/tags/chant-apply-lock`, the way terragucci's Forgejo pipelines do
 * (`forgejoLock` in terragucci's `render.ts` at 18f6431).
 *
 * The tag points at an empty commit whose subject is the holder's lease,
 * `run <id> <epoch>`. A runner that kills a job never runs its exit trap, so
 * a waiter takes the lock over, with a lease push, when `chant lock --alive`
 * says the holder's run is gone or its lease is older than
 * `CHANT_LOCK_STALE` seconds (default 7200; `TG_LOCK_STALE` is read as an
 * alias). The step's exit trap lets go of the tag.
 */

/** The concurrency or resource group every apply job of a pipeline on the repo grain shares. */
export const REPO_APPLY_GROUP = "chant-apply-repo";

/** The tag Forgejo applies on the repo grain hold. */
export const REPO_LOCK_REF = "refs/tags/chant-apply-lock";

/**
 * The shell lines that take the repo lock tag before an apply on Forgejo,
 * and let go of it when the step's shell exits. They run in the apply
 * command's own step, before it, so the trap fires when the apply ends.
 * Waits up to an hour, polling every `CHANT_LOCK_POLL` seconds (default 10).
 */
export function forgejoRepoLockLines(): string[] {
  const id = "${GITHUB_RUN_ID:-$$}";
  return [
    `lock_ref="${REPO_LOCK_REF}"`,
    'empty="$(git mktree </dev/null)"',
    `mine="$(GIT_AUTHOR_NAME=chant GIT_AUTHOR_EMAIL=chant@localhost GIT_COMMITTER_NAME=chant GIT_COMMITTER_EMAIL=chant@localhost git commit-tree "$empty" -m "run ${id} $(date +%s)")"`,
    'stale="${CHANT_LOCK_STALE:-${TG_LOCK_STALE:-7200}}"',
    "tries=0",
    'until git push -q origin "$mine:$lock_ref" 2>/dev/null; do',
    '  held="$(git ls-remote origin "$lock_ref" | cut -f1)"',
    '  if [ -n "$held" ] && git fetch -q origin "+$lock_ref:$lock_ref" 2>/dev/null; then',
    '    lease="$(git log -1 --format=%s "$lock_ref")"',
    '    holder="$(echo "$lease" | cut -d" " -f2)"; since="$(echo "$lease" | cut -d" " -f3)"',
    '    if [ "$(chant lock --alive "$holder" 2>/dev/null)" = dead ] || [ $(( $(date +%s) - ${since:-0} )) -ge "$stale" ]; then',
    '      echo "the apply lock was held by run $holder, which is gone; taking it over"',
    '      git push -q --force-with-lease="$lock_ref:$held" origin "+$mine:$lock_ref" 2>/dev/null && break',
    "    fi",
    "  fi",
    '  if [ "$tries" -ge 360 ]; then echo "another apply has held $lock_ref for an hour" >&2; exit 1; fi',
    '  sleep "${CHANT_LOCK_POLL:-10}"; tries=$((tries + 1))',
    "done",
    "trap 'git push -q --force-with-lease=\"$lock_ref:$mine\" origin \":$lock_ref\" || true' EXIT",
  ];
}
