/**
 * lifecycle rollback (#873) — open a PR that restores the source to a prior git
 * revision. Rollback = make an env match a past state of the declared source; the
 * PR's diff *is* the rollback delta. No cloud mutation here — a human merges, then
 * the existing gated apply rolls the env back.
 *
 * Runs entirely in an isolated `git worktree` (like {@link ./affected}), so the
 * caller's working branch/tree is never touched — important because the consumer
 * (behold) serves a live checkout.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/** Branch name for a rollback PR. Pure. */
export function rollbackBranchName(env: string | undefined, shortRef: string): string {
  return `chant/rollback-${env ?? "src"}-${shortRef}`;
}

/** PR title for a rollback. Pure. */
export function rollbackTitle(env: string | undefined, ref: string): string {
  return `rollback ${env ? env + " " : ""}source to ${ref}`;
}

/** PR body — explains that merging + applying completes the rollback. Pure. */
export function rollbackBody(env: string | undefined, ref: string, sourceDir: string): string {
  const target = env ? `the ${env} environment` : "the environment";
  return (
    `Restores \`${sourceDir}\` to its state at \`${ref}\`.\n\n` +
    `The diff below is the rollback delta. Merge this PR, then apply (Sync) to roll ${target} back — ` +
    `a destructive apply still passes through its approval gate. No cloud change was made by opening this PR.`
  );
}

export interface RollbackResult {
  /** true when the source already matched the ref — nothing to roll back. */
  noop: boolean;
  branch?: string;
  prUrl?: string;
  /**
   * The rollback delta as a unified diff — present only for a `dryRun`, where
   * it is the whole point: the PR body's diff is what a reviewer would act on,
   * so producing it without a PR is what makes the delta inspectable offline.
   */
  diff?: string;
}

/**
 * Open a rollback PR restoring `sourceDir` to `ref`. Isolated worktree; the
 * caller's branch is untouched. Throws on an unknown ref or a git/gh failure.
 *
 * `dryRun` computes the same delta and returns it as a diff without pushing a
 * branch or opening a PR, leaving the repository exactly as it found it.
 *
 * That mode exists because the PR path needs a GitHub remote and an
 * authenticated `gh` — reasonable for the operator flow this was built for
 * (#873), and impossible for a hermetic acceptance run. chant#1208's CC
 * round-trip has to demonstrate rollback offline, on an emulator, with no
 * remote in the picture; without this it could only assert the `noop` case,
 * which exercises none of the interesting work.
 */
export async function rollbackToRevision(opts: {
  ref: string;
  env: string | undefined;
  sourceDir: string;
  cwd: string;
  /** Compute and return the delta; open no PR, push nothing, leave no branch. */
  dryRun?: boolean;
}): Promise<RollbackResult> {
  const { ref, env, sourceDir, cwd, dryRun } = opts;
  const git = (args: string[], wd: string): Promise<{ stdout: string }> => execFileAsync("git", args, { cwd: wd });

  const repoRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).stdout.trim();
  // Verify the ref resolves to a commit (throws with a clear message otherwise).
  await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot });
  const shortRef = (await git(["rev-parse", "--short", ref], repoRoot)).stdout.trim();
  const branch = rollbackBranchName(env, shortRef);
  const wt = join(tmpdir(), `chant-rollback-${shortRef}-${process.pid}`);

  await git(["worktree", "add", wt, "-b", branch, "HEAD"], repoRoot);
  try {
    // Restore the source tree to the target revision (stages the changes).
    //
    // `git checkout <ref> -- <dir>` alone is a PER-PATH checkout, not a tree
    // replacement: it restores the paths that exist at `ref` and leaves
    // everything else untouched, so a file added since `ref` survives. That
    // made rollback report "nothing to roll back" whenever the only difference
    // was added files (#1327) — which is exactly what a reconcile produces,
    // since `chant import --from <env>` writes NEW files rather than editing
    // the authored ones. Clearing the directory first makes this a real
    // restore, so the deletions show up in the delta.
    await git(["rm", "-rq", "--ignore-unmatch", "--", sourceDir], wt);
    await git(["checkout", ref, "--", sourceDir], wt);
    const staged = (await git(["status", "--porcelain", "--", sourceDir], wt)).stdout.trim();
    if (!staged) return { noop: true };

    // The delta, before committing: `git diff` against the index shows exactly
    // what restoring the source to `ref` changes. A dry run stops here.
    if (dryRun) {
      const { stdout } = await git(["diff", "--cached", "--", sourceDir], wt);
      return { noop: false, branch, diff: stdout };
    }

    await git(["commit", "-m", rollbackTitle(env, ref)], wt);
    await git(["push", "-u", "origin", branch], wt);
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "create", "--title", rollbackTitle(env, ref), "--body", rollbackBody(env, ref, sourceDir), "--head", branch],
      { cwd: wt },
    );
    return { noop: false, branch, prUrl: stdout.trim() };
  } finally {
    await git(["worktree", "remove", "--force", wt], repoRoot).catch(() => {});
    // Removing the worktree leaves its branch behind. For the PR path that is
    // correct — the branch is the PR. A dry run must leave nothing, or a repo
    // accumulates a `chant/rollback-*` branch per inspection.
    if (dryRun) await git(["branch", "-D", branch], repoRoot).catch(() => {});
  }
}
