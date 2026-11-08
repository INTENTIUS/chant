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
 *    ({@link relayTokenVerdict}). The forge is read with a few GETs of its
 *    own ({@link readTokenReach}), kept out of `./pr-forge.ts` so the forge
 *    client's bundles do not grow for the relay;
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
import type { ForgeFetch, ForgeKind } from "./pr-forge";

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

/**
 * What a token may do in a repository, as {@link readTokenReach} reads it.
 *
 * - GitHub: whether it is a classic token (GitHub sends `x-oauth-scopes` for
 *   one), whether its account administers the repository, and whether the
 *   default branch is protected.
 * - GitLab: the token's scopes, its user's access level on the project
 *   (project or group, the higher), and the push access levels of the
 *   default branch's protection, or null when it is not protected.
 * - Forgejo: its user's login, whether that user administers the
 *   repository, and whether it may push to the default branch.
 */
export type TokenReach =
  | { kind: "github"; classic: boolean; admin: boolean; branchProtected: boolean }
  | { kind: "gitlab"; scopes: string[]; accessLevel: number; pushLevels: number[] | null }
  | { kind: "forgejo"; login: string; admin: boolean; canPush: boolean };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The header the forge takes a token in, as chant's forge clients send it. */
function authHeaders(forge: ForgeKind, token: string): Record<string, string> {
  if (forge === "gitlab") return { "PRIVATE-TOKEN": token, Accept: "application/json" };
  if (forge === "forgejo") return { Authorization: `token ${token}`, Accept: "application/json" };
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
}

/** Read what `token` reaches in `repo`, with GETs against the forge's REST base. Throws when a read the check needs is refused. */
export async function readTokenReach(repo: RelayRepo, token: string, branch: string, fetchImpl: ForgeFetch = globalThis.fetch as unknown as ForgeFetch): Promise<TokenReach> {
  const headers = authHeaders(repo.forge, token);
  const get = async (path: string, missing?: "null"): Promise<{ body: unknown; header: (n: string) => string | null }> => {
    const url = `${repo.apiBase}${path}`;
    const res = await fetchImpl(url, { method: "GET", headers });
    const text = await res.text();
    const header = (n: string): string | null => (res as { headers?: { get(n: string): string | null } }).headers?.get(n) ?? null;
    if (res.status === 404 && missing) return { body: null, header };
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
    return { body: text ? JSON.parse(text) : null, header };
  };
  const enc = (b: string): string => b.split("/").map(encodeURIComponent).join("/");
  if (repo.forge === "gitlab") {
    const project = `/projects/${encodeURIComponent(repo.path)}`;
    const self = (await get("/personal_access_tokens/self")).body;
    const scopes = isObject(self) && Array.isArray(self.scopes) ? self.scopes.filter((x): x is string => typeof x === "string") : [];
    const got = (await get(project)).body;
    const perms = isObject(got) && isObject(got.permissions) ? got.permissions : {};
    const level = (k: string): number => {
      const v = perms[k];
      return isObject(v) && typeof v.access_level === "number" ? v.access_level : 0;
    };
    const accessLevel = Math.max(level("project_access"), level("group_access"));
    const pb = (await get(`${project}/protected_branches/${encodeURIComponent(branch)}`, "null")).body;
    if (pb === null) return { kind: "gitlab", scopes, accessLevel, pushLevels: null };
    const push = isObject(pb) && Array.isArray(pb.push_access_levels) ? pb.push_access_levels : [];
    const pushLevels = push.map((p) => (isObject(p) && typeof p.access_level === "number" ? p.access_level : undefined)).filter((n): n is number => n !== undefined);
    return { kind: "gitlab", scopes, accessLevel, pushLevels };
  }
  const at = `/repos/${repo.path}`;
  const adminOf = (v: unknown): boolean => isObject(v) && isObject(v.permissions) && v.permissions.admin === true;
  if (repo.forge === "forgejo") {
    const me = (await get("/user")).body;
    const r = (await get(at)).body;
    const b = (await get(`${at}/branches/${enc(branch)}`)).body;
    // Anything but an explicit false counts as a push: a Forgejo that does not say is not trusted.
    return { kind: "forgejo", login: isObject(me) && typeof me.login === "string" ? me.login : "", admin: adminOf(r), canPush: !(isObject(b) && b.user_can_push === false) };
  }
  const r = await get(at);
  const b = (await get(`${at}/branches/${enc(branch)}`)).body;
  return { kind: "github", classic: Boolean(r.header("x-oauth-scopes")), admin: adminOf(r.body), branchProtected: isObject(b) && b.protected === true };
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
    return relayTokenVerdict(await readTokenReach(repo, token, branch, fetchImpl), repo.path, branch);
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
