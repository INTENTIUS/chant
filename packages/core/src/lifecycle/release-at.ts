/**
 * `release cut --at <sha>` (#4168 4.2): cut from a chosen commit of trunk,
 * not the checkout's `HEAD`. The commit is checked out in a temporary
 * detached worktree, as `chant rollback` works in one (./rollback.ts), so the
 * caller's branch and working tree are never touched and need not be clean.
 * The cut then runs in the member's directory inside that worktree, with the
 * same refusals a cut at `HEAD` has: a commit that is not green, a revoked
 * one, and build steps that differ by environment.
 *
 * Refs are shared between worktrees, so the release and the cut the cut
 * writes to `chant/lifecycle`, the tags it reads and the tag it makes are the
 * repository's own. The checkout's `node_modules` are linked in, so the
 * compile resolves the packages the checkout already installed; a commit
 * whose lockfile differs from the checkout's would need its own install
 * (inferred, as the cut can't tell).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export type CutAtCode = "release-at-unknown";

export class CutAtError extends Error {
  constructor(
    readonly code: CutAtCode,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "CutAtError";
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The full sha `ref` names in the repository at `top`, or a {@link CutAtError}. */
export function resolveCutCommit(top: string, ref: string): string {
  try {
    return git(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw new CutAtError(
      "release-at-unknown",
      `--at ${ref} names no commit this clone has`,
      "Fetch it first (git fetch origin --tags), or name a sha `chant release candidates` lists.",
    );
  }
}

/** A checkout of one commit for the cut, and the member's directory inside it. */
export interface CommitCheckout {
  /** The worktree's top. */
  dir: string;
  /** The member's directory inside it, the cut's `cwd`. */
  memberDir: string;
  /** Remove the worktree. Safe to call twice. */
  remove(): void;
}

/**
 * Check `commit` out in a temporary detached worktree of the repository at
 * `top`, with the checkout's `node_modules` linked at the top and at each
 * directory down to `cwd`, the member's directory in the caller's checkout.
 */
export function checkoutCommit(top: string, cwd: string, commit: string): CommitCheckout {
  const realTop = realpathSync(top);
  const rel = relative(realTop, realpathSync(cwd));
  const dir = mkdtempSync(join(tmpdir(), `chant-cut-${commit.slice(0, 12)}-`));
  git(realTop, ["worktree", "add", "--detach", "--quiet", dir, commit]);
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    try {
      git(realTop, ["worktree", "remove", "--force", dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
      try {
        git(realTop, ["worktree", "prune"]);
      } catch {
        // Nothing left to prune.
      }
    }
  };
  try {
    const levels = rel === "" ? [""] : ["", ...rel.split(sep).map((_, i, parts) => parts.slice(0, i + 1).join(sep))];
    for (const level of levels) {
      const from = join(realTop, level, "node_modules");
      const to = join(dir, level, "node_modules");
      if (existsSync(from) && !existsSync(to) && existsSync(dirname(to))) symlinkSync(from, to, "dir");
    }
  } catch (err) {
    remove();
    throw err;
  }
  return { dir, memberDir: resolve(dir, rel), remove };
}
