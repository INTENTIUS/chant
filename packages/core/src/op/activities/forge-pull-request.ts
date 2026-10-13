/**
 * Where chant's own pull-request paths open their pull request (#3798).
 *
 * `reconcilePr`'s `pull-request` mode, `lexiconUpgrade`, rollback and
 * `proposeWorkspaceUpgrade` open a pull request with `gh pr`. `gh pr create`,
 * `view`, `edit` and `list` speak GitHub's GraphQL API, which Forgejo does not
 * serve, so #3780's `GH_HOST` sends them to the right Forgejo instance only
 * for them to fail there. GitLab has no `gh` at all. On those two forges each
 * path opens, finds and edits its pull request over REST through
 * `../../pr-forge.ts` instead. GitHub, and a run outside any CI job, keep
 * `gh` and the operator's own `gh auth login`.
 *
 * The forge and its token come from the CI job's environment
 * ({@link forgeTargetFromEnv}). The repository is the one the checkout's
 * remote names, when that remote is on the job's forge, so a path working in
 * another checkout than the job's own still opens its pull request there.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectForge, forgeClient, forgeTargetFromEnv, type ForgeFetch, type PrForge, type PullRequest, type PullRequestSpec } from "../../pr-forge";
import { remoteHost } from "./gh-host";

const execFileAsync = promisify(execFile);

type Env = Record<string, string | undefined>;

/** The repository path a git remote URL names: `owner/name`, or `group/sub/name` on GitLab. */
export function remoteRepoPath(url: string | undefined): string | undefined {
  const u = url?.trim();
  if (!u) return undefined;
  const scp = /^[^@/\s]+@[^:/\s]+:(?!\/)(.+)$/.exec(u);
  let path: string;
  if (scp) path = scp[1]!;
  else {
    try {
      path = new URL(u).pathname;
    } catch {
      return undefined;
    }
  }
  const out = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return out.includes("/") ? out : undefined;
}

export interface PullRequestForgeOptions {
  /** A checkout whose remote names the repository. Default: the job's repository. */
  cwd?: string;
  /** The remote in `cwd`. Default `origin`. */
  remote?: string;
  fetch?: ForgeFetch;
  /** Reads a remote's URL. Default `git remote get-url`. For tests. */
  remoteUrl?: (cwd: string, remote: string) => Promise<string | undefined>;
}

const gitRemoteUrl = async (cwd: string, remote: string): Promise<string | undefined> => {
  try {
    return (await execFileAsync("git", ["remote", "get-url", remote], { cwd })).stdout.trim();
  } catch {
    return undefined;
  }
};

/**
 * The REST client a pull request is opened through, or undefined when `gh`
 * serves: on GitHub, and outside a CI job. A Forgejo or GitLab job that lacks
 * a token or a repository throws `ForgeEnvironmentError` naming it, where
 * `gh pr` would have failed on GraphQL.
 */
export async function restPullRequestForge(env: Env = process.env, opts: PullRequestForgeOptions = {}): Promise<PrForge | undefined> {
  const kind = detectForge(env);
  if (kind !== "forgejo" && kind !== "gitlab") return undefined;
  const target = forgeTargetFromEnv(env, { kind });
  if (opts.cwd) {
    const url = await (opts.remoteUrl ?? gitRemoteUrl)(opts.cwd, opts.remote ?? "origin");
    const path = remoteRepoPath(url);
    if (path && remoteHost(url) === target.host) target.repo = path;
  }
  return forgeClient(target, opts.fetch);
}

/** What {@link upsertPullRequest} did. */
export interface UpsertedPullRequest {
  action: "opened" | "updated" | "unchanged";
  pr: PullRequest;
}

/**
 * Open a pull request for `spec.head`, or bring the open one's title and
 * body in line with `spec`. An open one already current is left alone.
 */
export async function upsertPullRequest(forge: PrForge, spec: PullRequestSpec): Promise<UpsertedPullRequest> {
  const open = await forge.findPullRequest(spec.head);
  if (!open) return { action: "opened", pr: await forge.openPullRequest(spec) };
  if (open.title === spec.title && open.body.trim() === spec.body.trim()) return { action: "unchanged", pr: open };
  const edited = await forge.editPullRequest(open.number, { title: spec.title, body: spec.body });
  return { action: "updated", pr: edited ?? { ...open, title: spec.title, body: spec.body } };
}
