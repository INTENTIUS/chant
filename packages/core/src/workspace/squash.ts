/**
 * Following a squash merge to the pull request's original commits (#3035,
 * ws-092).
 *
 * A squash merge folds a pull request's commits into one new commit, and with
 * them the trailers and signatures that joined each to its run and its work.
 * The forge keeps the originals: GitHub and Forgejo both keep a pull
 * request's head at `refs/pull/<n>/head` on the remote. A read that is asked
 * to follow squashes (`--follow-squash`) looks for that ref locally, fetches
 * the missing ones from `origin` in one `git fetch`, and keeps what it
 * fetched under `refs/chant/pull/<n>/head`, so the next read needs no network.
 * Without the flag nothing here runs, and a read never touches the network
 * (studio-032 b: follow only when asked).
 *
 * A commit is followed as a squash when its subject ends with `(#<n>)`, as
 * GitHub and Forgejo write a squash's subject, it has one parent, and the
 * pull request's head is not already in its history (a merge commit or a
 * rebase keeps the originals, so there is nothing to follow). Its original
 * commits are the head's commits that the squash's parent does not have,
 * oldest first. When the ref can't be read or fetched, the read says so and
 * keeps its answer without them.
 */

import { execFileSync } from "node:child_process";

/** A forge chant knows the pull request refs of. */
export type Forge = "github" | "forgejo";

/** Where a read keeps the pull request heads it fetched. */
export const PULL_CACHE_PREFIX = "refs/chant/pull/";

/** The remote a squash's pull request ref is fetched from. */
export const SQUASH_REMOTE = "origin";

/** How long one fetch of pull request refs may take. */
const FETCH_TIMEOUT_MS = 60_000;

function git(top: string, args: string[], opts: { input?: string; timeout?: number } = {}): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: top,
      encoding: "utf-8",
      input: opts.input,
      timeout: opts.timeout,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      // A fetch must never wait on a credential prompt.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    return undefined;
  }
}

/** The pull request number a squash's subject ends with, `(#<n>)`, or null. */
export function pullRequestOf(subject: string): number | null {
  const m = subject.match(/\(#([0-9]+)\)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * The forge a remote URL points at: `github` for github.com and GitHub
 * Enterprise hosts named for it, `forgejo` for codeberg.org and hosts named
 * forgejo or gitea. Null for any other, which is still read at
 * `refs/pull/<n>/head`, the ref both keep.
 */
export function forgeOf(url: string | null | undefined): Forge | null {
  if (!url) return null;
  const host = (url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i)?.[1] ?? url.match(/^(?:[^@/]*@)?([^/:]+):/)?.[1] ?? "").toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com") || /(^|[.-])github([.-]|$)/.test(host)) return "github";
  if (host === "codeberg.org" || /(^|[.-])(forgejo|gitea)([.-]|$)/.test(host)) return "forgejo";
  return null;
}

/** The pull request ref a forge keeps for `n`. GitHub and Forgejo keep the same one. */
export function pullRef(_forge: Forge | null, n: number): string {
  return `refs/pull/${n}/head`;
}

/** What following one squash commit found. */
export interface SquashFollow {
  /** The squash commit. */
  sha: string;
  pullRequest: number;
  /** The forge `origin` points at, or null when it is none chant knows, or there is no `origin`. */
  forge: Forge | null;
  /** The local ref the pull request's head was read from, or null when none could be read. */
  ref: string | null;
  /** The pull request's head commit, or null. */
  head: string | null;
  /** Whether this read fetched the ref from the remote. */
  fetched: boolean;
  /** Whether the original commits were read. */
  followed: boolean;
  /** The original commits, oldest first. Empty when not followed. */
  commits: string[];
  /** Why it was not followed, when it wasn't. */
  problem: string | null;
}

const commitOf = (top: string, rev: string): string | undefined => git(top, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])?.trim() || undefined;

/** The local ref holding pull request `n`'s head: chant's cache, the forge's own ref, or a `refs/remotes/<remote>/pr/<n>` mirror. */
function localPullRef(top: string, forge: Forge | null, n: number): { ref: string; head: string } | undefined {
  for (const ref of [`${PULL_CACHE_PREFIX}${n}/head`, pullRef(forge, n), `refs/remotes/${SQUASH_REMOTE}/pr/${n}`]) {
    const head = commitOf(top, ref);
    if (head) return { ref, head };
  }
  return undefined;
}

/** Fetch each pull request's head into chant's cache, all in one fetch and then one by one if that fails. The numbers fetched. */
function fetchPullRefs(top: string, forge: Forge | null, numbers: number[]): Set<number> {
  const spec = (n: number) => `+${pullRef(forge, n)}:${PULL_CACHE_PREFIX}${n}/head`;
  const fetchRefs = (ns: number[]) => git(top, ["fetch", "--no-tags", "--quiet", "--no-write-fetch-head", SQUASH_REMOTE, ...ns.map(spec)], { timeout: FETCH_TIMEOUT_MS }) !== undefined;
  if (numbers.length === 0) return new Set();
  if (fetchRefs(numbers)) return new Set(numbers);
  // One missing ref fails the whole fetch; the others may still be there.
  return new Set(numbers.length === 1 ? [] : numbers.filter((n) => fetchRefs([n])));
}

/**
 * Follow each squash commit among `commits` to its pull request's original
 * commits (#3035). A commit that is not a squash (no `(#<n>)` subject, a
 * merge, or a head already in its history) is left out of the result. With
 * `fetchMissing`, a pull request ref missing locally is fetched from `origin`;
 * without it, only refs already present are read.
 */
export function followSquashes(top: string, commits: { sha: string; subject: string }[], opts: { fetchMissing: boolean }): Map<string, SquashFollow> {
  const out = new Map<string, SquashFollow>();
  const candidates = commits.map((c) => ({ sha: c.sha, n: pullRequestOf(c.subject) })).filter((c): c is { sha: string; n: number } => c.n !== null);
  if (candidates.length === 0) return out;
  const parents = new Map<string, string[]>();
  for (const line of (git(top, ["log", "--no-walk=unsorted", "--stdin", "--format=%H %P"], { input: `${candidates.map((c) => c.sha).join("\n")}\n` }) ?? "").split("\n")) {
    const [sha, ...ps] = line.trim().split(/\s+/);
    if (sha) parents.set(sha, ps);
  }
  const squashes = candidates.filter((c) => parents.get(c.sha)?.length === 1);
  if (squashes.length === 0) return out;
  const url = git(top, ["config", "--get", `remote.${SQUASH_REMOTE}.url`])?.trim() || null;
  const forge = forgeOf(url);
  const local = new Map<number, { ref: string; head: string }>();
  for (const n of new Set(squashes.map((c) => c.n))) {
    const hit = localPullRef(top, forge, n);
    if (hit) local.set(n, hit);
  }
  const missing = [...new Set(squashes.map((c) => c.n))].filter((n) => !local.has(n));
  const fetched = opts.fetchMissing && url ? fetchPullRefs(top, forge, missing) : new Set<number>();
  for (const n of fetched) {
    const head = commitOf(top, `${PULL_CACHE_PREFIX}${n}/head`);
    if (head) local.set(n, { ref: `${PULL_CACHE_PREFIX}${n}/head`, head });
  }
  for (const c of squashes) {
    const hit = local.get(c.n);
    const base: SquashFollow = { sha: c.sha, pullRequest: c.n, forge, ref: null, head: null, fetched: false, followed: false, commits: [], problem: null };
    if (!hit) {
      const problem = !opts.fetchMissing
        ? `${pullRef(forge, c.n)} is not in this clone`
        : !url
          ? `there is no ${SQUASH_REMOTE} remote to fetch ${pullRef(forge, c.n)} from`
          : `${pullRef(forge, c.n)} could not be fetched from ${SQUASH_REMOTE}: the forge has no such ref, or it can't be reached`;
      out.set(c.sha, { ...base, problem });
      continue;
    }
    // A head already in the commit's history was merged or rebased, not squashed: nothing to follow.
    if (git(top, ["merge-base", "--is-ancestor", hit.head, c.sha]) !== undefined) continue;
    const parent = parents.get(c.sha)![0];
    const list = git(top, ["rev-list", "--reverse", "--no-merges", hit.head, `^${parent}`]);
    if (list === undefined) {
      out.set(c.sha, { ...base, ref: hit.ref, head: hit.head, fetched: fetched.has(c.n), problem: `the commits of ${hit.ref} could not be listed` });
      continue;
    }
    const originals = list.split("\n").map((s) => s.trim()).filter(Boolean);
    out.set(c.sha, { ...base, ref: hit.ref, head: hit.head, fetched: fetched.has(c.n), followed: true, commits: originals });
  }
  return out;
}

/**
 * For the lines of `path` in a squash commit: which original commit last wrote
 * each, by `git blame` at the pull request's head, when the file there is the
 * same as in the squash (#3035). Undefined when it is not, since the lines
 * then don't correspond one to one.
 */
export function squashLineOrigins(top: string, squash: string, head: string, path: string, originals: Set<string>): Map<number, string> | undefined {
  const a = git(top, ["rev-parse", "--verify", "--quiet", `${squash}:${path}`])?.trim();
  const b = git(top, ["rev-parse", "--verify", "--quiet", `${head}:${path}`])?.trim();
  if (!a || a !== b) return undefined;
  const out = git(top, ["blame", "--porcelain", head, "--", path]);
  if (out === undefined) return undefined;
  const lines = new Map<number, string>();
  // Every line has a header, `<sha> <line in that commit> <line now>`, with a count after it on a group's first.
  for (const l of out.split("\n")) {
    const m = l.match(/^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/);
    if (m && originals.has(m[1])) lines.set(Number(m[2]), m[1]);
  }
  return lines;
}
