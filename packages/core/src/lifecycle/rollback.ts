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
}

/**
 * Open a rollback PR restoring `sourceDir` to `ref`. Isolated worktree; the
 * caller's branch is untouched. Throws on an unknown ref or a git/gh failure.
 */
export async function rollbackToRevision(opts: {
  ref: string;
  env: string | undefined;
  sourceDir: string;
  cwd: string;
}): Promise<RollbackResult> {
  const { ref, env, sourceDir, cwd } = opts;
  const git = (args: string[], wd: string): Promise<{ stdout: string }> => execFileAsync("git", args, { cwd: wd });

  const repoRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).stdout.trim();
  // Verify the ref resolves to a commit (throws with a clear message otherwise).
  await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot });
  const shortRef = (await git(["rev-parse", "--short", ref], repoRoot)).stdout.trim();
  const branch = rollbackBranchName(env, shortRef);
  const wt = join(tmpdir(), `chant-rollback-${shortRef}-${process.pid}`);

  await git(["worktree", "add", wt, "-b", branch, "HEAD"], repoRoot);
  try {
    // Restore just the source tree to the target revision (stages the changes).
    await git(["checkout", ref, "--", sourceDir], wt);
    const staged = (await git(["status", "--porcelain", "--", sourceDir], wt)).stdout.trim();
    if (!staged) return { noop: true };

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
  }
}
