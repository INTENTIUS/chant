/**
 * What the audit activities read from GitHub and write back to it: release
 * lists over the REST API, and a sticky issue or a proposal pull request
 * through `git` and `gh`. The prometheus lexicon's rule audit uses the issue
 * half too.
 */

import { execFile } from "node:child_process";

/** Runs `git` or `gh`, returning stdout. Rejects on a non-zero exit. */
export type CommandRunner = (bin: "git" | "gh", args: string[], cwd: string) => Promise<string>;

export const defaultRunner: CommandRunner = (bin, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args.join(" ")} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });

export interface Release {
  tag: string;
  publishedAt?: string;
}

/** `v1.2.3` as numbers, or undefined when the tag is not a plain semver. */
export function semverOf(tag: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareSemver(a: string, b: string): number {
  const x = semverOf(a);
  const y = semverOf(b);
  if (!x || !y) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The published, non-prerelease releases of `repo` (`owner/name`) with a
 * plain semver tag, newest first. Reads one page of 100, which covers
 * months of collector releases.
 */
export async function fetchReleases(repo: string, f: typeof fetch = fetch, token = process.env.GITHUB_TOKEN): Promise<Release[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await f(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
  if (!res.ok) throw new Error(`GitHub releases of ${repo}: HTTP ${res.status}`);
  const body = (await res.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean; published_at?: string }>;
  return body
    .filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === "string" && semverOf(r.tag_name))
    .map((r) => ({ tag: r.tag_name!, ...(r.published_at ? { publishedAt: r.published_at } : {}) }))
    .sort((a, b) => compareSemver(b.tag, a.tag));
}

/**
 * Open an issue titled `title`, or edit the body of the open one that
 * already has that title, so a scheduled audit keeps one issue current
 * instead of opening one per run. Returns its URL.
 */
export async function stickyIssue(run: CommandRunner, cwd: string, title: string, body: string, labels: string[] = []): Promise<string> {
  const listed = await run("gh", ["issue", "list", "--state", "open", "--search", `"${title}" in:title`, "--json", "number,title,url"], cwd);
  const open = (JSON.parse(listed || "[]") as Array<{ number: number; title: string; url: string }>).find((i) => i.title === title);
  if (open) {
    await run("gh", ["issue", "edit", String(open.number), "--body", body], cwd);
    return open.url;
  }
  const args = ["issue", "create", "--title", title, "--body", body];
  for (const l of labels) args.push("--label", l);
  return (await run("gh", args, cwd)).trim();
}

export interface ProposalFile {
  /** Path relative to the repository root. */
  path: string;
  content: string;
}

export interface ProposeOptions {
  /** The repository root. */
  root: string;
  branch: string;
  title: string;
  body: string;
  files: ProposalFile[];
  commitMessage: string;
  remote?: string;
  /** The branch the pull request targets. Default: the remote's default branch. */
  base?: string;
  /** A directory for the worktree the commit is made in. */
  worktreeDir: string;
}

/**
 * Commit `files` on `branch`, from the remote's default branch, in a
 * worktree of its own (the checked-out branch and working tree are never
 * touched), push it, and open a pull request, or edit the open one for that
 * branch. Returns the pull request's URL.
 */
export async function proposePullRequest(run: CommandRunner, o: ProposeOptions): Promise<string> {
  const remote = o.remote ?? "origin";
  await run("git", ["fetch", remote], o.root);
  let base = o.base;
  if (!base) {
    const head = (await run("git", ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], o.root).catch(() => `${remote}/main`)).trim();
    base = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : head;
  }
  await run("git", ["worktree", "add", "--force", "-B", o.branch, o.worktreeDir, `${remote}/${base}`], o.root);
  try {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of o.files) writeFileSync(join(o.worktreeDir, f.path), f.content);
    await run("git", ["add", ...o.files.map((f) => f.path)], o.worktreeDir);
    await run("git", ["commit", "-m", o.commitMessage], o.worktreeDir);
    await run("git", ["push", "--force", remote, `HEAD:refs/heads/${o.branch}`], o.worktreeDir);
  } finally {
    await run("git", ["worktree", "remove", "--force", o.worktreeDir], o.root).catch(() => undefined);
  }
  const listed = await run("gh", ["pr", "list", "--head", o.branch, "--state", "open", "--json", "number,url"], o.root);
  const open = (JSON.parse(listed || "[]") as Array<{ number: number; url: string }>)[0];
  if (open) {
    await run("gh", ["pr", "edit", String(open.number), "--title", o.title, "--body", o.body], o.root);
    return open.url;
  }
  return (await run("gh", ["pr", "create", "--head", o.branch, "--base", base, "--title", o.title, "--body", o.body], o.root)).trim();
}
