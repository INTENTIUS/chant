/**
 * The base of a repository's first commit (#5488). A gate's rules are read at
 * base so a change cannot choose its own gate, and a commit with no parent has
 * nothing reviewed before it: its base is the empty tree, where every file is
 * absent and every rule falls back to its absent case. Never the commit being
 * applied. `baseCommit` (`../gate-decision.ts`), `gitShowAtBase`
 * (`./op-waves-run.ts`) and the stage reader (`../pipeline/stage-waves.ts`)
 * all answer it.
 *
 * Imports only node:child_process, so the level-0 commands and the
 * gate-decision bundle can load it.
 */

import { spawnSync } from "node:child_process";

/** The empty tree, in a sha1 and a sha256 repository. */
const EMPTY_TREES = ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"] as const;

function git(repo: string, args: string[]) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
}

/** True when `base` is the empty tree, the base of a repository's first commit. */
export function isEmptyBase(base: string): boolean {
  return (EMPTY_TREES as readonly string[]).includes(base);
}

/** The empty tree in `repo`'s object format. */
export function emptyTreeOf(repo: string): string {
  return git(repo, ["rev-parse", "--show-object-format"]).stdout.trim() === "sha256" ? EMPTY_TREES[1] : EMPTY_TREES[0];
}

/** The first parent `sha`'s commit object names, or undefined when it names none. A shallow clone keeps the line even when it lacks the parent. */
export function commitParentLine(repo: string, sha: string): string | undefined {
  const header = git(repo, ["cat-file", "commit", sha]).stdout.split("\n\n")[0] ?? "";
  return /^parent ([0-9a-f]{40,64})$/m.exec(header)?.[1];
}

/**
 * The base `base` names when it is the first parent of a commit that has
 * none (`HEAD^1`, `HEAD^`, `HEAD~1`, `HEAD~`, of any commit): the empty tree.
 * Undefined when `base` is not of that form, the commit it names cannot be
 * read, or the commit has a parent line, as a shallow checkout's commit does
 * while it lacks the parent itself.
 */
export function rootCommitBase(repo: string, base: string): string | undefined {
  const of = /^(.+?)(?:\^1?|~1?)$/.exec(base)?.[1];
  if (!of) return undefined;
  const r = git(repo, ["rev-parse", "--verify", "-q", `${of}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.status !== 0 || !sha || commitParentLine(repo, sha) !== undefined) return undefined;
  return emptyTreeOf(repo);
}
