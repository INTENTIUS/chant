/**
 * The checkout a working-tree read is made in, and which records in it are
 * uncommitted (#3160).
 *
 * Work in progress lives as uncommitted files in a work branch's working tree
 * (#3158, #3145). A reader such as hud or studio shows "kept, not yet
 * applied" from `records --json` alone: each record says whether it is
 * committed, modified or new against `HEAD`, and the document names the
 * branch, the commit `HEAD` names and the base that branch forked from. The
 * reader never diffs git itself.
 *
 * Every git call here reads. None takes the index lock or refreshes the
 * index (`--no-optional-locks`), so a read leaves the checkout as it was,
 * `.git` included, which the reader conformance suite checks.
 */

import { execFileSync } from "node:child_process";
import { resolveBase, type BaseSource } from "./trust/provenance";

/** Where a record's file stands against `HEAD`. */
export type WorktreeState = "committed" | "modified" | "new";

/** The branch, head and base of a checkout (#3160). `records` and `status` both print it. */
export interface CheckoutHead {
  /** The checked-out branch's short name, such as `chant/work/w-12`, or null when `HEAD` is detached. */
  branch: string | null;
  /** The commit `HEAD` names, or null before the first commit. Each record's `worktree` is judged against it. */
  head: string | null;
  /** The merge base of `head` and the target branch tip: the commit the branch forked from. Null without a head, a target, or common history. */
  base: string | null;
  /** Where the target branch was found: `flag` for `--base`, else `origin/HEAD`, `main` or `master`. Null when there is none. */
  baseFrom: BaseSource | null;
}

/** {@link CheckoutHead} for one record kind, with the record files `HEAD` has and the working tree does not. */
export interface CheckoutView extends CheckoutHead {
  /** Record files of the kind at `head` that the working tree no longer has, from the repository root, sorted. */
  deleted: string[];
}

function git(top: string, args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", ...args], {
    cwd: top,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function tryGit(top: string, args: string[]): string | undefined {
  try {
    return git(top, args);
  } catch {
    return undefined;
  }
}

/**
 * The branch, head and base of the checkout at `top`. `explicitBase` is
 * `--base`, as the trust policy takes it; otherwise the target branch is the
 * one the policy is read at (`origin/HEAD`, then `main`, then `master`).
 */
export function readCheckoutHead(top: string, explicitBase?: string): CheckoutHead {
  const branch = tryGit(top, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim() || null;
  const head = tryGit(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.trim() || null;
  const target = resolveBase(top, explicitBase);
  const base = head && target.commit ? tryGit(top, ["merge-base", head, target.commit])?.trim() || null : null;
  return { branch, head, base, baseFrom: target.from };
}

/** NUL-separated git output as a list. */
function zList(out: string | undefined): string[] {
  return (out ?? "").split("\0").filter(Boolean);
}

/**
 * Each of `paths` (record files directly in `dir`, from the repository root)
 * as committed, modified or new against `head`, and the files directly in
 * `dir` at `head` whose names `match` and that `paths` leaves out: the
 * records deleted in the working tree. With no head every path is new.
 *
 * Staged and unstaged changes count alike: anything `HEAD` does not hold is
 * uncommitted. A rename is a new record and a deleted one.
 */
export function worktreeStates(
  top: string,
  head: string | null,
  dir: string,
  paths: readonly string[],
  match: RegExp,
): { states: Map<string, WorktreeState>; deleted: string[] } {
  const states = new Map<string, WorktreeState>();
  if (head === null) {
    for (const p of paths) states.set(p, "new");
    return { states, deleted: [] };
  }
  const prefix = dir === "." ? "" : `${dir}/`;
  const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
  const spec = dir === "." ? "." : dir;
  const atHead = new Set(zList(tryGit(top, ["ls-tree", "-r", "-z", "--name-only", head, "--", spec])).filter(direct));
  const changed = new Set(zList(tryGit(top, ["diff", "--name-only", "-z", "--no-renames", head, "--", spec])));
  for (const p of paths) states.set(p, !atHead.has(p) ? "new" : changed.has(p) ? "modified" : "committed");
  const present = new Set(paths);
  const deleted = [...atHead].filter((p) => !present.has(p) && match.test(p.slice(prefix.length))).sort();
  return { states, deleted };
}
