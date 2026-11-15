/**
 * Where a path a manifest names lives (#5109): an Argo CD Application's
 * `spec.source.path` is a path inside the repository its `repoURL` names, not
 * inside whatever directory a command was started from.
 *
 * Given the directory of a tree that is being read (the root `chant audit`
 * walks), {@link resolveRepoPath} finds the checkout the tree is in and
 * answers one of three things:
 *
 * - `found` or `missing`: the repository is this one, or no `origin` remote
 *   says otherwise, and the path is (or is not) a directory or file below the
 *   checkout's root.
 * - `elsewhere`: the checkout's `origin` remote names a different repository
 *   than `repoURL`, so the path is in a tree that is not on disk and nothing
 *   can be said about it.
 *
 * A tree outside any checkout (an extracted archive) has no remote to compare,
 * and resolves against the directory itself. `requireOrigin` turns that case
 * into `elsewhere`, for a caller that wants a path read only when a remote
 * says the repository is the workspace's own.
 *
 * Reading the remote runs `git`, once per directory.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { remoteHost, remoteRepoPath } from "./forge-remote";

/** The checkout a directory is in. */
export interface RepoTree {
  /** The checkout's root, or the directory itself when it is in none. */
  root: string;
  /** The `origin` remote's URL, when the directory is in a checkout that has one. */
  origin?: string;
}

const trees = new Map<string, RepoTree>();

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The checkout `dir` is in, read once per directory. */
export function repoTreeOf(dir: string): RepoTree {
  const abs = resolve(dir);
  const known = trees.get(abs);
  if (known) return known;
  const top = git(abs, ["rev-parse", "--show-toplevel"]);
  const tree: RepoTree = top ? { root: top, origin: git(abs, ["remote", "get-url", "origin"]) } : { root: abs };
  if (tree.origin === undefined) delete tree.origin;
  trees.set(abs, tree);
  return tree;
}

/** Whether two repository URLs name the same repository: the same host and path, whatever the scheme, user, case or `.git` suffix. */
export function sameRepository(a: string | undefined, b: string | undefined): boolean {
  const pa = remoteRepoPath(a);
  const pb = remoteRepoPath(b);
  if (!pa || !pb) return false;
  return pa.toLowerCase() === pb.toLowerCase() && remoteHost(a) === remoteHost(b);
}

export type RepoPathStatus = "found" | "missing" | "elsewhere";

export interface RepoPathResolution {
  status: RepoPathStatus;
  /** The path from the checkout's root, with `.` and `..` folded, or the path as given when it leaves the checkout. */
  path: string;
}

export interface ResolveRepoPathOptions {
  /** Whether the path names a directory (the default) or a file. */
  type?: "dir" | "file";
  /** Treat a tree with no `origin` remote as another repository. Default false. */
  requireOrigin?: boolean;
}

/**
 * Resolve `path`, which a manifest in the tree at `dir` names inside the
 * repository `repoURL`. See the module comment for the three answers.
 */
export function resolveRepoPath(dir: string, repoURL: string | undefined, path: string, opts: ResolveRepoPathOptions = {}): RepoPathResolution {
  const tree = repoTreeOf(dir);
  if (tree.origin === undefined ? opts.requireOrigin : repoURL !== undefined && repoURL !== "" && !sameRepository(tree.origin, repoURL)) {
    return { status: "elsewhere", path };
  }
  // A path in a repository is relative to its root, with or without a leading slash.
  const full = resolve(tree.root, path.replace(/^\/+/, ""));
  const rel = relative(tree.root, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return { status: "missing", path };
  const shown = rel === "" ? "." : rel.split(sep).join("/");
  try {
    const stat = statSync(full);
    const ok = (opts.type ?? "dir") === "dir" ? stat.isDirectory() : stat.isFile();
    return { status: ok ? "found" : "missing", path: shown };
  } catch {
    return { status: "missing", path: shown };
  }
}
