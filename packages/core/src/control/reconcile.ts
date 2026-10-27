/**
 * Reconcile (#4568): from a control repo, bring every project's pipeline in
 * line with the control repo's entries. Lifted from terragucci's
 * `reconcile.ts` (INTENTIUS/terragucci 18f6431595).
 *
 * A dry run (the default) says what each project's pipeline would become.
 * `apply` pushes a branch to each project that changes and opens a pull
 * request there, or updates the one already open; it never writes a
 * default branch. One project failing does not stop the others.
 *
 * The files come from the product: chant clones the project, calls the
 * product's generator in the clone (terragucci's `init`, plywood's), and
 * commits what it wrote. The words name the branch, the commit and the pull
 * request.
 *
 * Tokens: each project's forge token is read from the variable the project
 * names, else `CHANT_<FORGE>_TOKEN` ({@link reconcileTokenEnv}), the names
 * the handover already drops from a plan step (../ci-handover.ts). git gets
 * it through the environment as an `http.extraheader`, the way
 * `checkoutScript` hands the job's token to its fetches, never in a URL or
 * the git config.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveProductWords, type CiProductWords, type CiProductWordsInput } from "../ci-product-words";
import { forgejoForge, githubForge, gitlabForge, type ForgeFetch, type ForgeKind, type PrForge } from "../pr-forge";
import { ControlConfigError, forgeApiBase, forgeFromHost, parseProjectKey } from "./dispatch";

/** A file the product's generator wrote, or would write. Paths are relative to the project's root. */
export interface ControlFileChange {
  path: string;
  status: "created" | "updated" | "unchanged" | "removed";
}

/** One project as reconcile reads it: its key and what the product resolved from the entries. */
export interface ReconcileProject {
  /** `<host>/<owner>/<name>`. */
  key: string;
  /** The project's settings, the defaults applied, as the product resolved them. Passed to the generator as is. */
  settings: Record<string, unknown>;
  /** The forge, when the host does not say. */
  forge?: ForgeKind;
  /** Where to clone from, when not `https://<host>/<path>.git`: a URL, a local path or a `file://` URL. */
  url?: string;
  /** The variable the project's forge token is in. Default {@link reconcileTokenEnv}. */
  tokenEnv?: string;
  /** The REST base, when not the host's usual one. */
  apiBase?: string;
}

/** What the generator is told about the project it runs in. */
export interface ReconcileTarget {
  key: string;
  name: string;
  forge: ForgeKind;
  settings: Record<string, unknown>;
  dryRun: boolean;
}

/**
 * The product's generator: writes the project's pipeline into the clone at
 * `dir` and says what it wrote. A dry run's clone is thrown away, so the
 * generator may write there either way.
 */
export type ControlGenerator = (dir: string, target: ReconcileTarget) => Promise<ControlFileChange[]>;

/** How reconcile reaches git. Tests pass a fake; the default runs git. */
export interface ControlGit {
  clone(url: string, dir: string, auth?: GitAuth): Promise<void>;
  /** Commits everything in `dir` on `branch` and pushes it to `origin`, replacing the branch there. */
  commitAndPush(dir: string, branch: string, message: string, author: { name: string; email: string }, auth?: GitAuth): Promise<void>;
}

/** The token git sends, as an `http.extraheader` through the environment. */
export interface GitAuth {
  user: string;
  token: string;
}

/** What {@link reconcileProjects} takes. */
export interface ReconcileOptions {
  mode: "dry-run" | "apply";
  /** Only this project key. */
  project?: string;
  words?: CiProductWordsInput | CiProductWords;
  generate: ControlGenerator;
  env?: Record<string, string | undefined>;
  fetch?: ForgeFetch;
  git?: ControlGit;
  /** A forge client for a project, in place of chant's REST clients (a fake in a test). */
  forgeFor?: (project: { key: string; forge: ForgeKind; host: string; path: string; apiBase: string; token: string }) => PrForge;
  /** A fresh directory per project, and its removal. Default under the OS temp directory. */
  workDir?: { make(): string; remove(dir: string): void };
}

/** One project's outcome. */
export interface ReconcileOutcome {
  key: string;
  status: "unchanged" | "would-change" | "pull-request" | "failed";
  changes: ControlFileChange[];
  pullRequest?: string;
  error?: string;
}

/** The variable a project's forge token is read from when it names none: `CHANT_GITHUB_TOKEN`, `CHANT_GITLAB_TOKEN`, `CHANT_FORGEJO_TOKEN`. */
export function reconcileTokenEnv(forge: ForgeKind): string {
  return `CHANT_${forge.toUpperCase()}_TOKEN`;
}

/** The branch reconcile pushes to each project: `<product>/pipeline`. */
export function reconcileBranch(wordsIn: CiProductWordsInput | CiProductWords = {}): string {
  return `${resolveProductWords(wordsIn).product}/pipeline`;
}

/** Where a project is cloned from. A local path or `file://` URL is cloned as it is. */
export function cloneUrlOf(key: string, url: string | undefined): string {
  const pk = parseProjectKey(key);
  if (!url) return `https://${pk.host}/${pk.path}.git`;
  if (url.startsWith("/") || url.startsWith("file://")) return url;
  return url.endsWith(".git") ? url : `${url}.git`;
}

/** The environment that hands `auth` to git's HTTP requests and to nothing else. */
export function gitAuthEnv(auth: GitAuth | undefined): Record<string, string> {
  if (!auth) return {};
  const basic = Buffer.from(`${auth.user}:${auth.token}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`, GIT_TERMINAL_PROMPT: "0" };
}

const run = promisify(execFile);

/** git as a command, with the token in the environment alone and cut out of any message. */
export function commandGit(): ControlGit {
  const git = async (args: string[], auth?: GitAuth): Promise<void> => {
    try {
      await run("git", args, { env: { ...process.env, ...gitAuthEnv(auth) }, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr || (e as Error).message);
      throw new Error(auth ? msg.split(auth.token).join("***") : msg);
    }
  };
  return {
    clone: (url, dir, auth) => git(["clone", "-q", "--depth", "1", url, dir], auth),
    async commitAndPush(dir, branch, message, author, auth) {
      const id = ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "-c", "commit.gpgsign=false"];
      await git(["-C", dir, "checkout", "-q", "-B", branch]);
      await git(["-C", dir, "add", "-A"]);
      await git(["-C", dir, ...id, "commit", "-q", "-m", message]);
      await git(["-C", dir, "push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`], auth);
    },
  };
}

function restClient(p: { forge: ForgeKind; host: string; path: string; apiBase: string; token: string }, fetchImpl: ForgeFetch | undefined): PrForge {
  const f = fetchImpl ? { fetch: fetchImpl } : {};
  if (p.forge === "gitlab") return gitlabForge({ apiBase: p.apiBase, project: p.path, token: p.token, host: p.host, ...f });
  if (p.forge === "forgejo") return forgejoForge({ apiBase: p.apiBase, repo: p.path, token: p.token, host: p.host, ...f });
  return githubForge({ apiBase: p.apiBase, repo: p.path, token: p.token, host: p.host, ...f });
}

const tempWork = {
  make: () => mkdtempSync(join(tmpdir(), "chant-reconcile-")),
  remove: (dir: string) => rmSync(dir, { recursive: true, force: true }),
};

/** Reconciles each project in `projects` (or the one `options.project` names). */
export async function reconcileProjects(projects: readonly ReconcileProject[], options: ReconcileOptions): Promise<ReconcileOutcome[]> {
  if (projects.length === 0) throw new ControlConfigError("reconcile needs a control repo with projects");
  const words = resolveProductWords(options.words ?? {});
  const product = words.product;
  const chosen = options.project ? projects.filter((p) => p.key === options.project) : projects;
  if (options.project && chosen.length === 0) throw new ControlConfigError(`${options.project} is not a project of this control repo`);
  const env = options.env ?? process.env;
  const git = options.git ?? commandGit();
  const work = options.workDir ?? tempWork;
  const branch = reconcileBranch(words);
  const outcomes: ReconcileOutcome[] = [];

  for (const project of chosen) {
    const key = project.key;
    let dir: string | undefined;
    try {
      const pk = parseProjectKey(key);
      const forge = project.forge ?? forgeFromHost(pk.host);
      if (!forge) throw new ControlConfigError(`cannot tell which forge ${pk.host} is; set forge for this project`);
      const tokenEnv = project.tokenEnv ?? reconcileTokenEnv(forge);
      const token = env[tokenEnv];
      if (options.mode === "apply" && !token) throw new ControlConfigError(`${tokenEnv} is not set; it holds the token for ${pk.host}`);
      const auth = token ? { user: forge === "gitlab" ? "oauth2" : "x-access-token", token } : undefined;
      dir = work.make();
      const clone = join(dir, "repo");
      await git.clone(cloneUrlOf(key, project.url), clone, auth);
      const changes = await options.generate(clone, { key, name: pk.name, forge, settings: project.settings, dryRun: options.mode === "dry-run" });
      const changed = changes.filter((f) => f.status !== "unchanged");
      if (changed.length === 0) {
        outcomes.push({ key, status: "unchanged", changes });
        continue;
      }
      if (options.mode === "dry-run") {
        outcomes.push({ key, status: "would-change", changes });
        continue;
      }
      const apiBase = (project.apiBase ?? forgeApiBase(forge, pk.host)).replace(/\/+$/, "");
      const target = { key, forge, host: pk.host, path: pk.path, apiBase, token: token! };
      const client = options.forgeFor ? options.forgeFor(target) : restClient(target, options.fetch);
      const base = client.defaultBranch ? await client.defaultBranch() : "main";
      await git.commitAndPush(clone, branch, `${product}: update the pipeline from the control repo`, { name: product, email: `${product}@users.noreply.intentius.io` }, auth);
      const title = `${product}: update the pipeline`;
      const body = [
        `The control repo's ${product} entries changed what this repo's pipeline should be.`,
        "",
        ...changed.map((f) => `- ${f.status === "created" ? "adds" : f.status === "removed" ? "removes" : "updates"} \`${f.path}\``),
        "",
        `Review and merge it here; ${product} never writes this repo's default branch.`,
      ].join("\n");
      const open = await client.findPullRequest(branch);
      const pr = open ? ((await client.editPullRequest(open.number, { title, body })) ?? open) : await client.openPullRequest({ head: branch, base, title, body });
      outcomes.push({ key, status: "pull-request", changes, ...(pr.url ? { pullRequest: pr.url } : { pullRequest: `#${pr.number}` }) });
    } catch (e) {
      outcomes.push({ key, status: "failed", changes: [], error: (e as Error).message });
    } finally {
      if (dir) work.remove(dir);
    }
  }
  return outcomes;
}

/** The outcomes as lines a person reads. */
export function describeReconcile(outcomes: readonly ReconcileOutcome[], mode: "dry-run" | "apply"): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    const files = o.changes.filter((f) => f.status !== "unchanged").map((f) => `${f.status === "created" ? "new" : f.status === "removed" ? "removed" : "changed"} ${f.path}`);
    if (o.status === "unchanged") lines.push(`${o.key}: unchanged`);
    else if (o.status === "would-change") lines.push(`${o.key}: would write ${files.join(", ")}`);
    else if (o.status === "pull-request") lines.push(`${o.key}: ${files.join(", ")} -> ${o.pullRequest}`);
    else lines.push(`${o.key}: FAILED ${o.error}`);
  }
  const failed = outcomes.filter((o) => o.status === "failed").length;
  lines.push(
    mode === "dry-run"
      ? `dry run: ${outcomes.filter((o) => o.status === "would-change").length} of ${outcomes.length} would change; nothing was written`
      : `${outcomes.filter((o) => o.status === "pull-request").length} pull request(s) opened or updated`,
  );
  if (failed) lines.push(`${failed} project(s) failed`);
  return lines.join("\n");
}
