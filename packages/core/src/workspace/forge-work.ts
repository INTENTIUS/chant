/**
 * Work items from the forge (#4649): the issues a squash-merged pull request
 * closes.
 *
 * A project that squash-merges pull requests and tracks its work in forge
 * issues writes no `Chant-Record` trailer. Its commit subjects end in
 * `(#<n>)`, the pull request, and the pull request closes issues. Asked to
 * (`--forge-issues`), `release candidates` and `workspace graph --intent` ask
 * the forge which issues each pull request closes, through the forge clients
 * of `../pr-forge.ts` ({@link PrForge.closingIssues}): one call per pull
 * request, each answer kept for the rest of the read.
 *
 * The forge is the CI job's when the read runs in one ({@link detectForge}),
 * else the one `origin` points at: github.com and hosts named for GitHub,
 * hosts named for GitLab, and codeberg.org and hosts named for Forgejo or
 * Gitea. The token is read in {@link FORGE_TOKEN_ORDER}, with
 * `CHANT_FORGE_TOKEN` first, and on GitHub `gh auth token` for the host last.
 *
 * Nothing here fails a read. Without a forge or a token, offline, or when the
 * forge answers an error, a pull request is `resolved: false` with the
 * reason, and its number still stands. After a network failure, a 401 or a
 * 403, the rest are answered with the same reason without another call.
 */

import { execFileSync } from "node:child_process";
import { remoteRepoPath } from "../op/activities/forge-pull-request";
import { remoteHost } from "../op/activities/gh-host";
import { detectForge, FORGE_TOKEN_ORDER, ForgeApiError, forgeClient, forgeTargetFromEnv, type ForgeFetch, type ForgeKind, type ForgeTarget, type PrForge } from "../pr-forge";

/** What the forge says one pull request closes. */
export interface PullRequestCloses {
  /** Whether the forge answered. When false, `issues` is empty and `reason` says why. */
  resolved: boolean;
  /** The issues of the repository the pull request closes, ascending. */
  issues: number[];
  /** Why the forge was not read, or null when it was. */
  reason: string | null;
}

/** The forge a {@link ForgeWorkReader} reads, as the read found it. */
export interface ForgeWorkSource {
  kind: ForgeKind;
  host: string;
  /** `owner/name`, or the GitLab project path. */
  repo: string;
}

export interface ForgeWorkReader {
  /** The forge read, or null when none could be worked out. */
  source: ForgeWorkSource | null;
  /** What pull request `pr` closes. Asked twice, the forge is called once. */
  closes(pr: number): Promise<PullRequestCloses>;
  /** {@link closes} for each of `prs`, a few at a time. */
  closesAll(prs: Iterable<number>): Promise<Map<number, PullRequestCloses>>;
}

export interface ForgeWorkOptions {
  /** Default `process.env`. */
  env?: Record<string, string | undefined>;
  fetch?: ForgeFetch;
  /** `origin`'s URL. Default `git remote get-url origin` in `top`; null for none. */
  remoteUrl?: string | null;
  /** The token `gh` holds for a GitHub host, or undefined. Default `gh auth token --hostname <host>`. */
  ghToken?: (host: string) => string | undefined;
  /** How long one call may take. Default 15 seconds. */
  timeoutMs?: number;
}

/** How many pull requests are asked about at once. */
const CONCURRENCY = 4;

function gitRemote(top: string): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function ghAuthToken(host: string): string | undefined {
  try {
    return execFileSync("gh", ["auth", "token", "--hostname", host], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The forge kind a remote host is: github.com and hosts named for GitHub, GitLab, or Forgejo and Gitea (codeberg.org too). Null for any other. */
export function forgeKindOfHost(host: string): ForgeKind | null {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (h === "github.com" || /(^|[.-])github([.-]|$)/.test(h)) return "github";
  if (h === "gitlab.com" || /(^|[.-])gitlab([.-]|$)/.test(h)) return "gitlab";
  if (h === "codeberg.org" || /(^|[.-])(forgejo|gitea)([.-]|$)/.test(h)) return "forgejo";
  return null;
}

/** The REST base of a forge at `host`, as the clients take it. */
export function forgeApiBase(kind: ForgeKind, host: string): string {
  if (kind === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  return kind === "gitlab" ? `https://${host}/api/v4` : `https://${host}/api/v1`;
}

/** Where the issues are read from, or why they can't be. */
function locate(top: string, opts: ForgeWorkOptions): { target: ForgeTarget } | { source: ForgeWorkSource | null; reason: string } {
  const env = opts.env ?? process.env;
  const job = detectForge(env);
  if (job) {
    try {
      return { target: forgeTargetFromEnv(env, { kind: job }) };
    } catch (err) {
      return { source: null, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  const url = opts.remoteUrl !== undefined ? opts.remoteUrl : gitRemote(top);
  if (!url) return { source: null, reason: "there is no origin remote to name the forge" };
  const host = remoteHost(url);
  const repo = remoteRepoPath(url);
  const kind = host ? forgeKindOfHost(host) : null;
  if (!host || !repo || !kind) return { source: null, reason: `origin (${url}) is not on a forge chant reads issues from: GitHub, GitLab or Forgejo` };
  const source = { kind, host, repo };
  const names = ["CHANT_FORGE_TOKEN", ...FORGE_TOKEN_ORDER[kind]];
  const tokenSource = names.find((n) => env[n]?.trim());
  const token = tokenSource ? env[tokenSource]!.trim() : kind === "github" ? (opts.ghToken ?? ghAuthToken)(host) : undefined;
  if (!token) return { source, reason: `no token for ${host}: set ${names.join(", ")}${kind === "github" ? ", or log in with gh auth login" : ""}` };
  return { target: { kind, apiBase: forgeApiBase(kind, host), repo, host, token, tokenSource: tokenSource ?? "gh auth token" } };
}

/** Why a failed call stops the rest: the forge can't be reached, or won't let this token read. */
function stopsTheRest(err: unknown): boolean {
  return !(err instanceof ForgeApiError) || err.status === 401 || err.status === 403;
}

/** A reader of what pull requests close, for the repository at `top`. */
export function forgeWorkReader(top: string, opts: ForgeWorkOptions = {}): ForgeWorkReader {
  const where = locate(top, opts);
  const cache = new Map<number, Promise<PullRequestCloses>>();
  let stopped: string | null = "reason" in where ? where.reason : null;
  const client: PrForge | null = "target" in where ? forgeClient(where.target, opts.fetch) : null;
  const source: ForgeWorkSource | null = "target" in where ? { kind: where.target.kind, host: where.target.host, repo: where.target.repo } : where.source;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const unresolved = (reason: string): PullRequestCloses => ({ resolved: false, issues: [], reason });

  const ask = async (pr: number): Promise<PullRequestCloses> => {
    if (stopped !== null) return unresolved(stopped);
    if (!client?.closingIssues) return unresolved(`the ${source?.kind ?? "forge"} client can't list the issues a pull request closes`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs / 1000}s`)), timeoutMs);
      });
      const issues = await Promise.race([client.closingIssues(pr), timeout]);
      return { resolved: true, issues, reason: null };
    } catch (err) {
      const message = `${source?.host ?? "the forge"} could not be read: ${err instanceof Error ? err.message : String(err)}`;
      if (stopsTheRest(err)) stopped = message;
      return unresolved(message);
    } finally {
      clearTimeout(timer);
    }
  };

  const closes = (pr: number): Promise<PullRequestCloses> => {
    let hit = cache.get(pr);
    if (!hit) {
      hit = ask(pr);
      cache.set(pr, hit);
    }
    return hit;
  };

  return {
    source,
    closes,
    async closesAll(prs) {
      const queue = [...new Set(prs)];
      const out = new Map<number, PullRequestCloses>();
      const worker = async (): Promise<void> => {
        for (let pr = queue.shift(); pr !== undefined; pr = queue.shift()) out.set(pr, await closes(pr));
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      return out;
    },
  };
}

/**
 * Set `closes` on each commit from what its `pullRequest` closes, asking the
 * forge once per pull request; null for a commit with none. For
 * `workspace graph --intent --forge-issues`, over the graph's commit nodes or
 * a record walk's commits.
 */
export async function setCommitCloses(commits: { pullRequest: number | null; closes?: PullRequestCloses | null }[], reader: ForgeWorkReader): Promise<void> {
  const closed = await reader.closesAll(commits.map((c) => c.pullRequest).filter((n): n is number => n !== null));
  for (const c of commits) c.closes = c.pullRequest !== null ? (closed.get(c.pullRequest) ?? null) : null;
}
