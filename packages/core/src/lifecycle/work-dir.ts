/**
 * Where an Op that changes the checkout makes its work worktrees (#2893).
 *
 * A work item's worktree is `<checkout>/.chant/work/[<member>/]<item>`. It
 * sits inside the checkout, so a coding agent whose project root is the
 * checkout may write there, and `node_modules` above it still resolves. It
 * used to be `<git-common-dir>/chant-work/...`, where Claude Code refuses
 * every write. `/.chant/work/` goes in `<git-common-dir>/info/exclude`, so the
 * checkout's `git status` never lists it, and the rest of `.chant/` (the
 * workspace lock, the factory's check logs) stays tracked.
 *
 * This module imports nothing from the workspace or the Op runner, so the
 * hand-written walkers can ask it which directory to skip.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** The work directory, relative to a checkout's top, `/`-separated. */
export const WORK_DIR = ".chant/work";

/** The line `<git-common-dir>/info/exclude` gets, anchored at each checkout's top. */
export const WORK_DIR_EXCLUDE = `/${WORK_DIR}/`;

/** The directory where earlier versions made work worktrees, under the git common directory. */
export const LEGACY_WORK_DIR = "chant-work";

/**
 * Whether a directory, given as a `/`-separated path relative to the root a
 * walker started from, is a work directory: `.chant/work` at that root or at
 * any depth below it. A walker skips it, since each worktree in it is a whole
 * copy of the checkout.
 */
export function isWorkDir(rel: string): boolean {
  return rel === WORK_DIR || rel.endsWith(`/${WORK_DIR}`);
}

/** The worktree for `id` under the checkout whose top is `top`. */
export function workWorktreePath(top: string, members: readonly string[], id: string): string {
  return join(top, ...WORK_DIR.split("/"), ...members, id);
}

/** The worktree an earlier version made for `id`, under the git common directory. */
export function legacyWorkWorktreePath(commonDir: string, members: readonly string[], id: string): string {
  return join(commonDir, LEGACY_WORK_DIR, ...members, id);
}

/**
 * Add {@link WORK_DIR_EXCLUDE} to `<commonDir>/info/exclude` unless the file
 * already has it, or `ignored` says git already ignores the work directory
 * (a `.gitignore` of the project's, or the global excludes file). Returns
 * whether it wrote the line.
 */
export function excludeWorkDir(commonDir: string, ignored: boolean): boolean {
  const file = join(commonDir, "info", "exclude");
  const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  if (text.split(/\r?\n/).some((l) => l.trim() === WORK_DIR_EXCLUDE)) return false;
  if (ignored) return false;
  mkdirSync(join(commonDir, "info"), { recursive: true });
  appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${WORK_DIR_EXCLUDE}\n`);
  return true;
}

/**
 * After a work worktree is removed, remove the directories above it that are
 * left empty, up to and including the checkout's `.chant`, so a run leaves
 * nothing behind in a checkout that had no `.chant` before it.
 */
export function removeEmptyWorkDirs(worktree: string): void {
  const marker = `${sep}${WORK_DIR.split("/").join(sep)}${sep}`;
  const at = worktree.lastIndexOf(marker);
  if (at < 0) return;
  const stop = worktree.slice(0, at);
  for (let dir = dirname(worktree); dir.length > stop.length; dir = dirname(dir)) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}
