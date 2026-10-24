/**
 * Another repository's workspace, named by URL and pinned revision (#3168).
 *
 * A member of kind `repo` is read the way a nested `workspace` member is
 * (./nested-graph.ts): through that repository's own `chant workspace graph`,
 * at the pinned revision, and nothing is ever written there. To have a tree
 * to run that read in, chant fetches the revision into the user's cache
 * directory, never under the workspace: one clone per URL, and one detached
 * worktree per revision, which is immutable once made, so two reads of one
 * revision share it and a read never moves another's checkout.
 *
 * This is the only place `chant workspace graph` reaches a remote, and only
 * for repo members. `chant workspace check` never fetches.
 *
 * The read contract's identity names the repository a document came from
 * (`workspace.repo`): the URL of the `origin` remote, credentials removed.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CACHE_DIR_ENV } from "./graph-cache";
import { urlCredential } from "./checks/org";
import type { RepoRef } from "./declaration";

/** A URL with any user name and password removed; scp-style and local paths are returned as they are. */
export function redactUrl(url: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    if (u.username === "" && u.password === "") return url;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * The repository a workspace on disk came from (#3168): its git repository's
 * `origin` URL, redacted, or null without git or an origin. Reads local git
 * config only; never reaches the remote.
 */
export function repoIdentity(dir: string): string | null {
  try {
    const url = execFileSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return url ? redactUrl(url) : null;
  } catch {
    return null;
  }
}

/** Where fetched repositories live: `<cache>/repos`, with the cache dir as the graph cache finds it. */
export function repoCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env[CACHE_DIR_ENV] || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "chant");
  return join(base, "repos");
}

/** The URL git is handed: a relative local path is resolved from the workspace root, since git runs in the cache. */
export function fetchUrl(url: string, workspaceRoot: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  if (/^(?:[^@/\s]+@)?[^:/\s]+:(?!\/\/)/.test(url) && !isAbsolute(url) && !/^[a-z]:[\\/]/i.test(url)) return url;
  return resolve(workspaceRoot, url);
}

export type RepoFetch = { ok: true; dir: string; worktree: string } | { ok: false; message: string };

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

function git(args: string[], cwd?: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message: string };
    return { ok: false, out: String(e.stderr ?? e.message).trim().split("\n").slice(-3).join("; ") };
  }
}

/**
 * Make `ref`'s revision available in the cache, fetching it when the cache
 * doesn't hold it, and return the directory of its workspace root there.
 * Never throws; a failure says why.
 */
export function fetchRepoAt(ref: RepoRef, workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): RepoFetch {
  if (urlCredential(ref.url)) return { ok: false, message: `the repo url carries a credential, which chant refuses to use (WSP016)` };
  const url = fetchUrl(ref.url, workspaceRoot);
  const clone = join(repoCacheDir(env), createHash("sha256").update(url).digest("hex").slice(0, 24));
  const worktree = join(clone, "at", ref.rev);
  const dir = ref.workspace === "." ? worktree : join(worktree, ...ref.workspace.split("/"));
  if (existsSync(join(worktree, ".git"))) return { ok: true, dir, worktree };
  if (!existsSync(join(clone, ".git"))) {
    mkdirSync(clone, { recursive: true });
    const init = git(["init", "-q", clone]);
    if (!init.ok) return { ok: false, message: `could not make the cache clone in ${clone}: ${init.out}` };
    git(["-C", clone, "remote", "add", "origin", url]);
  }
  const has = () => git(["-C", clone, "cat-file", "-e", `${ref.rev}^{commit}`]).ok;
  if (!has()) {
    // A pinned commit by id first; a server that refuses unadvertised ids gets a full fetch.
    const byId = git(["-C", clone, "fetch", "-q", "origin", ref.rev]);
    if (!has()) {
      const all = git(["-C", clone, "fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"]);
      if (!has()) return { ok: false, message: `could not fetch ${ref.rev} from ${redactUrl(ref.url)}: ${all.ok ? (byId.ok ? "the repository has no such commit" : byId.out) : all.out}` };
    }
  }
  const add = git(["-C", clone, "worktree", "add", "-q", "--detach", worktree, ref.rev]);
  if (!add.ok && !existsSync(join(worktree, ".git"))) return { ok: false, message: `could not check out ${ref.rev} in the cache: ${add.out}` };
  return { ok: true, dir, worktree };
}
