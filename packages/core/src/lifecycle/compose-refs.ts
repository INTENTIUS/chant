/**
 * Composed commits (#4168 4.3), as git holds them. A composed release lives
 * on a pushed `chant/compose/<name>` branch whose commits each cherry-pick
 * one trunk commit and name it in a `Chant-Composed-From: <sha>` trailer.
 * The base is the commit the first composed commit was picked onto.
 *
 * Kept free of other chant imports, so the ci tick, the cut, the metrics
 * and the compose command read composed commits the same way.
 */

import { execFileSync } from "node:child_process";

/** The branch prefix a composed release lives under. */
export const COMPOSE_BRANCH_PREFIX = "chant/compose/";

/** The trailer naming the trunk commit a composed commit picks. */
export const COMPOSED_FROM_TRAILER = "Chant-Composed-From";

/** What a composed commit carries: its branch when one is known, its base, and the trunk commits picked onto the base, oldest first. */
export interface Composition {
  branch: string | null;
  base: string;
  sources: string[];
}

function tryGit(top: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

/** Whether `branch` names a compose branch. */
export function isComposeBranch(branch: unknown): branch is string {
  return typeof branch === "string" && branch.startsWith(COMPOSE_BRANCH_PREFIX) && branch.length > COMPOSE_BRANCH_PREFIX.length;
}

/** The trunk commits one commit's `Chant-Composed-From` trailers name. */
export function composedFrom(top: string, sha: string): string[] {
  const out = tryGit(top, ["show", "-s", `--format=%(trailers:key=${COMPOSED_FROM_TRAILER},valueonly,separator=%x00)`, sha]);
  return (out ?? "")
    .split("\0")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{40}$/.test(s));
}

/**
 * The composition `sha` ends: walk its first parents while each commit
 * carries a `Chant-Composed-From` trailer. Null when `sha` carries none.
 */
export function compositionOf(top: string, sha: string, branch: string | null = null): Composition | null {
  const sources: string[] = [];
  let at = sha;
  for (;;) {
    const from = composedFrom(top, at);
    if (from.length === 0) break;
    sources.unshift(...from);
    const parent = tryGit(top, ["rev-parse", "--verify", "--quiet", `${at}^1`]);
    if (!parent) break;
    at = parent;
  }
  if (sources.length === 0) return null;
  return { branch, base: at, sources };
}

/** The compose branches this clone knows on `remote`, as `{ branch, ref }`, by name. */
export function remoteComposeBranches(top: string, remote = "origin"): Array<{ branch: string; ref: string }> {
  const prefix = `refs/remotes/${remote}/`;
  const out = tryGit(top, ["for-each-ref", "--format=%(refname)", `${prefix}${COMPOSE_BRANCH_PREFIX}`]);
  return (out ?? "")
    .split("\n")
    .filter(Boolean)
    .map((ref) => ({ branch: ref.slice(prefix.length), ref }))
    .sort((a, b) => (a.branch < b.branch ? -1 : 1));
}

/**
 * What a commit of a compose branch carries beyond trunk: walk its first
 * parents back to the first commit `trunkRef` reaches, which is the base,
 * collecting the `Chant-Composed-From` trailers on the way. A commit a
 * person made on the branch, such as a resolved conflict, carries none and
 * is walked past. Null when `sha` is on trunk or no trunk commit is found.
 */
export function compositionOnTrunk(top: string, sha: string, trunkRef: string, branch: string | null = null): Composition | null {
  const onTrunk = (c: string) => tryGit(top, ["merge-base", "--is-ancestor", c, trunkRef]) !== null;
  if (onTrunk(sha)) return null;
  const sources: string[] = [];
  let at: string | null = sha;
  while (at && !onTrunk(at)) {
    sources.unshift(...composedFrom(top, at));
    at = tryGit(top, ["rev-parse", "--verify", "--quiet", `${at}^1`]);
  }
  return at ? { branch, base: at, sources } : null;
}

/** The pushed compose branch `sha` is a first-parent commit of, as this clone last fetched it, or null. */
export function composeBranchContaining(top: string, sha: string, remote = "origin"): { branch: string; ref: string } | null {
  for (const b of remoteComposeBranches(top, remote)) {
    const line = tryGit(top, ["rev-list", "--first-parent", b.ref]);
    if (line?.split("\n").includes(sha)) return b;
  }
  return null;
}

/** The composed commits on the pushed compose branches that pick `trunkSha`. */
export function composedIncluding(top: string, trunkSha: string, remote = "origin"): Array<{ branch: string; commit: string }> {
  const out: Array<{ branch: string; commit: string }> = [];
  for (const b of remoteComposeBranches(top, remote)) {
    const tip = tryGit(top, ["rev-parse", "--verify", "--quiet", `${b.ref}^{commit}`]);
    if (!tip) continue;
    const composition = compositionOf(top, tip, b.branch);
    if (!composition?.sources.includes(trunkSha)) continue;
    // The composed commit that picked it: walk the composed commits for its trailer.
    let at: string | null = tip;
    while (at && at !== composition.base) {
      if (composedFrom(top, at).includes(trunkSha)) {
        out.push({ branch: b.branch, commit: at });
        break;
      }
      at = tryGit(top, ["rev-parse", "--verify", "--quiet", `${at}^1`]);
    }
  }
  return out;
}
