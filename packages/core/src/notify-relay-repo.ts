/**
 * `chant notify relay --repo <url> --token-env <VAR>` (#4759): the relay
 * clones the repository itself, so a product's relay container needs no
 * entrypoint of its own.
 *
 * Before it serves, the relay:
 *
 * 1. refuses a token that is more than approve-only. An approve-only token
 *    reads the repo and pushes `chant/lifecycle`: it neither administers the
 *    repo nor may push to the default branch, and on GitLab it carries no
 *    scope beyond `read_api`, `read_repository` and `write_repository`
 *    ({@link relayTokenVerdict}). The forge is read through chant's forge
 *    client (`./pr-forge.ts`, `tokenReach`);
 * 2. clones the repo into a checkout of its default branch. The token goes
 *    to git as an `http.extraHeader` in the environment
 *    (`GIT_CONFIG_COUNT`/`KEY`/`VALUE`), for this process's git calls only,
 *    and is never written to a file or into the remote's address.
 *
 * Each click then fetches the default branch before it reads the signers
 * (`../cli/handlers/notify-relay.ts`), so a signer added since start counts
 * without a restart.
 */

import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgejoForge, githubForge, gitlabForge, type ForgeFetch, type ForgeKind, type PrForge, type TokenReach } from "./pr-forge";

/** The repository the relay clones, read from its clone address. */
export interface RelayRepo {
  forge: ForgeKind;
  /** Lower-cased, with the port when there is one. */
  host: string;
  /** `<scheme>://<host>[:port]`. */
  web: string;
  /** `owner/name`, or GitLab's `group/subgroup/name`. */
  path: string;
  /** The clone address as given. */
  url: string;
  /** The forge's REST base. */
  apiBase: string;
}

/** The relay's clone address and forge, or why they do not name a repository. */
export function relayRepo(url: string, forge?: string): RelayRepo | { error: string } {
  const u = url.trim();
  if (!/^https?:\/\//.test(u)) return { error: `--repo is the repository's https clone address, such as https://github.com/acme/infra.git (got ${JSON.stringify(url)})` };
  if (/^https?:\/\/[^/]*@/.test(u)) return { error: "--repo must not carry a credential; the token goes in the variable --token-env names" };
  const m = /^(https?):\/\/([^/:]+)(:\d+)?\/(.+?)(?:\.git)?\/?$/.exec(u);
  if (!m || !m[4]!.includes("/")) return { error: `--repo names no owner/name: ${u}` };
  const host = m[2]!.toLowerCase();
  const kind: ForgeKind | undefined = forge === "github" || forge === "gitlab" || forge === "forgejo" ? forge : host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : undefined;
  if (forge !== undefined && forge !== "" && kind !== forge) return { error: `--forge is github, gitlab or forgejo (got ${JSON.stringify(forge)})` };
  if (!kind) return { error: `${host} is not github.com or gitlab.com; pass --forge github, gitlab or forgejo` };
  const web = `${m[1]}://${host}${m[3] ?? ""}`;
  const apiBase = kind === "gitlab" ? `${web}/api/v4` : kind === "forgejo" ? `${web}/api/v1` : host === "github.com" ? "https://api.github.com" : `${web}/api/v3`;
  return { forge: kind, host: `${host}${m[3] ?? ""}`, web, path: m[4]!, url: u, apiBase };
}

/** The forge client for `repo` with `token`. */
export function relayForge(repo: RelayRepo, token: string, fetchImpl?: ForgeFetch): PrForge {
  const f = fetchImpl ? { fetch: fetchImpl } : {};
  if (repo.forge === "gitlab") return gitlabForge({ apiBase: repo.apiBase, project: repo.path, token, host: repo.host, ...f });
  const opts = { apiBase: repo.apiBase, repo: repo.path, token, host: repo.host, ...f };
  return repo.forge === "forgejo" ? forgejoForge(opts) : githubForge(opts);
}

/** The scopes an approve-only GitLab token may carry. */
export const RELAY_GITLAB_SCOPES: readonly string[] = ["read_api", "read_repository", "write_repository"];
/** GitLab's Maintainer access level. */
const GITLAB_MAINTAINER = 40;

/** The git user a token pushes as over https, before the forge names one. */
export const relayGitUser = (forge: ForgeKind): string => (forge === "github" ? "x-access-token" : "oauth2");

/**
 * Why a token reaching `reach` is more than approve-only, or the git user
 * name it pushes as.
 */
export function relayTokenVerdict(reach: TokenReach, repoPath: string, branch: string): { user: string } | { error: string } {
  if (reach.kind === "gitlab") {
    const extra = reach.scopes.filter((s) => !RELAY_GITLAB_SCOPES.includes(s));
    if (extra.length > 0) return { error: `the token has the scopes ${extra.join(", ")}; an approve-only token has write_repository and read_api only` };
    if (reach.accessLevel >= GITLAB_MAINTAINER) return { error: `the token's user is a Maintainer or Owner of ${repoPath}; give the relay a Developer` };
    if (reach.pushLevels === null) return { error: `${branch} is not a protected branch, so the token could push to it` };
    if (reach.pushLevels.some((l) => l > 0 && l <= reach.accessLevel)) return { error: `the token's user may push to ${branch}` };
    return { user: relayGitUser("gitlab") };
  }
  if (reach.kind === "github") {
    if (reach.classic) return { error: "a classic token reaches every repo its account can; give the relay a fine-grained token for this repo with Contents: Read and write, and nothing else" };
    if (reach.admin) return { error: `the token's account administers ${repoPath}` };
    if (!reach.branchProtected) return { error: `${branch} is not protected, so the token could push to it` };
    return { user: relayGitUser("github") };
  }
  if (reach.admin) return { error: `the token's user administers ${repoPath}` };
  if (reach.canPush) return { error: `the token's user may push to ${branch}; protect it so only reviewed merges reach it` };
  return { user: reach.login || relayGitUser("forgejo") };
}

/** Read what the token reaches through chant's forge client, and judge it. Never throws. */
export async function checkRelayToken(repo: RelayRepo, token: string, branch: string, fetchImpl?: ForgeFetch): Promise<{ user: string } | { error: string }> {
  try {
    const forge = relayForge(repo, token, fetchImpl);
    if (!forge.tokenReach) return { error: `chant's ${repo.forge} client cannot read what a token reaches` };
    return relayTokenVerdict(await forge.tokenReach(branch), repo.path, branch);
  } catch (e) {
    return { error: `the forge could not be read with the token (${(e as Error).message})` };
  }
}

/**
 * The git config that carries the token as a header, appended after any
 * `GIT_CONFIG_*` entries `env` already has. Nothing is written to a file.
 */
export function relayGitAuthEnv(user: string, token: string, env: NodeJS.ProcessEnv = {}): Record<string, string> {
  const n = Number(env.GIT_CONFIG_COUNT ?? "0");
  const at = Number.isInteger(n) && n > 0 ? n : 0;
  return {
    GIT_CONFIG_COUNT: String(at + 1),
    [`GIT_CONFIG_KEY_${at}`]: "http.extraHeader",
    [`GIT_CONFIG_VALUE_${at}`]: `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Run git without blocking the process, so a forge served by the same process (a test's) can answer. */
const runGit = (args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; stdout: string; stderr: string }> =>
  new Promise((done) => {
    execFile("git", args, { encoding: "utf-8", env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => done({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" }));
  });

/** The default branch the remote at `url` names, or why it could not be read. */
export async function relayDefaultBranch(url: string, env: NodeJS.ProcessEnv): Promise<{ branch: string } | { error: string }> {
  const ls = await runGit(["ls-remote", "--symref", url, "HEAD"], env);
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(ls.stdout)?.[1];
  return branch ? { branch } : { error: ls.stderr.trim() || "the remote names no default branch" };
}

/** A checkout of `branch` of the repo at `url`, in a new directory under `parent` (default the system's temporary one). */
export async function relayCheckout(url: string, branch: string, env: NodeJS.ProcessEnv, parent: string = tmpdir()): Promise<{ dir: string } | { error: string }> {
  const dir = mkdtempSync(join(parent, "chant-relay-"));
  const r = await runGit(["clone", "-q", "--branch", branch, url, dir], env);
  return r.ok ? { dir } : { error: `cannot clone ${url}: ${r.stderr.trim()}` };
}

/** What {@link prepareRelayCheckout} made: the checkout, its default branch, and the git config every later git call needs. */
export interface RelayCheckout {
  dir: string;
  branch: string;
  repo: RelayRepo;
  user: string;
  gitEnv: Record<string, string>;
}

/**
 * Check the token and clone the repo, in that order: a token that is more
 * than approve-only is refused before anything is cloned with it.
 */
export async function prepareRelayCheckout(o: { url: string; token: string; forge?: string; env?: NodeJS.ProcessEnv; fetch?: ForgeFetch; parent?: string }): Promise<RelayCheckout | { error: string }> {
  const env = o.env ?? process.env;
  const repo = relayRepo(o.url, o.forge);
  if ("error" in repo) return repo;
  if (!o.token) return { error: "the token is empty: the relay pushes approvals with an approve-only token" };
  const probe = await relayDefaultBranch(repo.url, { ...env, ...relayGitAuthEnv(relayGitUser(repo.forge), o.token, env) });
  if ("error" in probe) return { error: `cannot read ${repo.path} with the token: ${probe.error}` };
  const checked = await checkRelayToken(repo, o.token, probe.branch, o.fetch);
  if ("error" in checked) return { error: `the relay holds only an approve-only token, and this one is more: ${checked.error}` };
  const gitEnv = relayGitAuthEnv(checked.user, o.token, env);
  const cloned = await relayCheckout(repo.url, probe.branch, { ...env, ...gitEnv }, o.parent);
  if ("error" in cloned) return cloned;
  return { dir: cloned.dir, branch: probe.branch, repo, user: checked.user, gitEnv };
}
