/**
 * The files a change touched, and the units lexicons own that those files
 * belong to (#3183).
 *
 * `lifecycle affected` judges chant source by diffing what it builds. A unit
 * that is not chant source, such as a hand-written Terraform root, never
 * shows in that diff, so a lexicon that owns such units answers from the
 * changed paths instead (`LexiconPlugin.changedUnits`).
 */

import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { LexiconPlugin } from "../lexicon";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * The commit a change is measured from: the merge base of `base` and `head`.
 * A pull request's head that branched before `base` moved is measured from
 * where it branched, so the other changes on `base` are not counted as its
 * own; a merge commit's first parent is its own merge base.
 */
export async function resolveMergeBase(cwd: string, base: string, head = "HEAD"): Promise<string> {
  try {
    return (await git(cwd, ["merge-base", base, head])).trim();
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim();
    throw new Error(
      `cannot find where ${head} and ${base} meet${detail ? `: ${detail}` : ""}. ` +
        "Is the base fetched? A CI checkout needs the history (fetch-depth: 0, GIT_DEPTH: 0).",
    );
  }
}

/** The full commit `ref` names. */
export async function resolveCommit(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

/**
 * Files changed between `base` and `head`, relative to `cwd`, with `/`
 * separators. A rename counts as its old and its new path.
 *
 * Every changed file in the repository is listed, not only those under
 * `cwd`: one outside it reads `../...`. A project in a workspace member
 * (#3465) can call a module that lives in another member or beside the
 * members, and a change there reaches it; `changedUnits` decides which of
 * these paths matter.
 */
export async function changedFilesBetween(cwd: string, base: string, head = "HEAD"): Promise<string[]> {
  const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).trim().replace(/\/+$/, "");
  const out = await git(cwd, ["diff", "--name-only", "-z", "--no-renames", "--no-relative", base, head]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((file) => {
      const rel = posix.relative(prefix, file);
      return rel === "" ? "." : rel;
    })
    .sort();
}

/** The union of every plugin's `changedUnits` answer, sorted. */
export async function lexiconChangedUnits(
  plugins: readonly Pick<LexiconPlugin, "changedUnits">[],
  ctx: { projectRoot: string; config: Record<string, unknown>; changedFiles: string[] },
): Promise<string[]> {
  if (ctx.changedFiles.length === 0) return [];
  const units = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.changedUnits) continue;
    for (const unit of await plugin.changedUnits(ctx)) units.add(unit);
  }
  return [...units].sort();
}
