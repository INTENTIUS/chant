/**
 * The forge, for real: the harness's Forgejo, through its REST API and git
 * over http, as three people (chant#4587, from the fan-out demo's
 * lib/forgejo.ts). The author pushes, opens and merges; the reviewer
 * approves; the admin forces main back and deletes branches. Every call
 * names one repository on the harness's own Forgejo, and nothing else.
 *
 * It also has sql-yodeler's verbs: a pull request's comments, the issues,
 * and a workflow run started by hand (the apply again, the drift watch).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { guardedGit, remoteWith, type GuardedGit } from "./git";
import type { Clock, ForgeIssue, ForgeRun, HarnessForge } from "./ports";
import { forgejoRunnerConfig, type RunnerConfigOptions } from "./stack";

export interface Person {
  login: string;
  token: string;
}

export interface ForgejoOptions {
  /** Forgejo as the driver reaches it, http://localhost:<port>. */
  url: string;
  /** `<org>/<repo>`. */
  repo: string;
  admin: Person;
  author: Person;
  reviewer: Person;
  /** A git repository holding the base commit, which forceMain pushes from. */
  baseTree: string;
  clock: Clock;
  /** The checkout git work must stay outside of. */
  checkout?: string;
  /** How long a workflow run may take, in seconds. Default 900. */
  runLimit?: number;
  /** The domain of the people's commit emails. Default chant-e2e.local. */
  emailDomain?: string;
}

const TIMEOUT_MS = 30_000;

/** One Forgejo API call. A 404 is null when `missingOk`; any other non-2xx throws. */
export async function forgejoApi<T = unknown>(
  url: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  opts: { missingOk?: boolean; basic?: { login: string; password: string } } = {},
): Promise<T | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.basic) headers.authorization = `Basic ${Buffer.from(`${opts.basic.login}:${opts.basic.password}`).toString("base64")}`;
  else if (token) headers.authorization = `token ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${url.replace(/\/$/, "")}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 && opts.missingOk) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Forgejo ${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** A workflow run as Forgejo's actions API lists it, the fields read here. */
interface ActionRun {
  id: number;
  status: string;
  commit_sha?: string;
  workflow_id?: string;
}

const DONE = new Set(["success", "failure", "cancelled", "skipped"]);

export class ForgejoForge implements HarnessForge {
  private readonly g: GuardedGit;

  constructor(private readonly o: ForgejoOptions) {
    this.g = guardedGit(o.checkout);
  }

  private api<T>(who: Person, method: string, path: string, body?: unknown, missingOk = false): Promise<T | null> {
    return forgejoApi<T>(this.o.url, who.token, method, path, body, { missingOk });
  }

  private remote(who: Person): string {
    return remoteWith(this.o.url, who.login, who.token, this.o.repo);
  }

  private get r(): string {
    return `/repos/${this.o.repo}`;
  }

  async pushBranch(branch: string, files: Record<string, string>, message: string): Promise<string> {
    const a = this.o.author;
    const dir = await this.g.clone(this.remote(a), "author", [a.token]);
    try {
      await this.g.git(dir, ["checkout", "-q", "-b", branch]);
      for (const [path, content] of Object.entries(files)) {
        const to = join(dir, ...path.split("/"));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, content);
      }
      await this.g.git(dir, ["add", "-A"]);
      await this.g.git(dir, ["-c", `user.name=${a.login}`, "-c", `user.email=${a.login}@${this.o.emailDomain ?? "chant-e2e.local"}`, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
      await this.g.git(dir, ["push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`], [a.token]);
      return await this.g.git(dir, ["rev-parse", "HEAD"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async openPull(branch: string, title: string, body: string): Promise<number> {
    const pull = await this.api<{ number?: number }>(this.o.author, "POST", `${this.r}/pulls`, { head: branch, base: "main", title, body });
    if (!pull?.number) throw new Error(`no pull request opened from ${branch}`);
    return pull.number;
  }

  async approvePull(pull: number, body: string): Promise<void> {
    await this.api(this.o.reviewer, "POST", `${this.r}/pulls/${pull}/reviews`, { event: "APPROVED", body });
  }

  async mergePull(pull: number): Promise<string> {
    // Forgejo checks a pull request's mergeability after it opens, so the
    // first try can be refused; it is tried again a few times.
    let lastErr: unknown;
    let merged = false;
    for (let i = 0; i < 10 && !merged; i++) {
      try {
        await this.api(this.o.author, "POST", `${this.r}/pulls/${pull}/merge`, { Do: "merge" });
        merged = true;
      } catch (err) {
        lastErr = err;
        await this.o.clock.sleep(2000);
      }
    }
    if (!merged) throw new Error(`pull request ${pull} did not merge: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    for (let i = 0; i < 30; i++) {
      const pr = await this.api<{ merge_commit_sha?: string }>(this.o.author, "GET", `${this.r}/pulls/${pull}`);
      if (pr?.merge_commit_sha) return pr.merge_commit_sha;
      await this.o.clock.sleep(1000);
    }
    throw new Error(`pull request ${pull} merged, but Forgejo names no merge commit`);
  }

  async openPulls(): Promise<number[]> {
    const pulls = await this.api<Array<{ number: number }>>(this.o.admin, "GET", `${this.r}/pulls?state=open&limit=50`);
    return (pulls ?? []).map((p) => p.number);
  }

  async closePull(pull: number): Promise<void> {
    await this.api(this.o.admin, "PATCH", `${this.r}/pulls/${pull}`, { state: "closed" });
  }

  async forceMain(sha: string): Promise<void> {
    const a = this.o.admin;
    await this.g.git(this.o.baseTree, ["push", "-q", "--force", this.remote(a), `${sha}:refs/heads/main`], [a.token]);
  }

  async branches(): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page < 50; page++) {
      const list = await this.api<Array<{ name: string }>>(this.o.admin, "GET", `${this.r}/branches?page=${page}&limit=50`);
      if (!list || list.length === 0) break;
      out.push(...list.map((b) => b.name));
      if (list.length < 50) break;
    }
    return out;
  }

  async deleteBranch(name: string): Promise<void> {
    await this.api(this.o.admin, "DELETE", `${this.r}/branches/${encodeURIComponent(name)}`, undefined, true);
  }

  async comments(pull: number): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page < 50; page++) {
      const list = await this.api<Array<{ body: string }>>(this.o.admin, "GET", `${this.r}/issues/${pull}/comments?page=${page}&limit=50`);
      if (!list || list.length === 0) break;
      out.push(...list.map((c) => c.body));
      if (list.length < 50) break;
    }
    return out;
  }

  async issues(): Promise<ForgeIssue[]> {
    const out: ForgeIssue[] = [];
    for (let page = 1; page < 50; page++) {
      const list = await this.api<Array<{ number: number; title: string; body?: string; state: string }>>(
        this.o.admin,
        "GET",
        `${this.r}/issues?state=all&type=issues&page=${page}&limit=50`,
      );
      if (!list || list.length === 0) break;
      out.push(...list.map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", open: i.state === "open" })));
      if (list.length < 50) break;
    }
    return out;
  }

  applyAgain(sha: string, workflow: string): Promise<ForgeRun> {
    return this.dispatch(sha, workflow);
  }

  watch(sha: string, workflow: string): Promise<ForgeRun> {
    return this.dispatch(sha, workflow);
  }

  /** Start `workflow` on main by hand and wait for the run it started at `sha`. */
  private async dispatch(sha: string, workflow: string): Promise<ForgeRun> {
    const before = new Set((await this.runs()).map((r) => r.id));
    await this.api(this.o.admin, "POST", `${this.r}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref: "main" });
    const deadline = this.o.clock.now() + (this.o.runLimit ?? 900) * 1000;
    let id: number | undefined;
    while (this.o.clock.now() < deadline) {
      const runs = await this.runs();
      const run = id === undefined ? runs.find((r) => !before.has(r.id) && (!r.commit_sha || r.commit_sha === sha)) : runs.find((r) => r.id === id);
      if (run) {
        id = run.id;
        if (DONE.has(run.status)) return { ok: run.status === "success", status: run.status, id: run.id };
      }
      await this.o.clock.sleep(2000);
    }
    throw new Error(`${workflow} on ${sha.slice(0, 8)} did not finish within ${this.o.runLimit ?? 900}s`);
  }

  private async runs(): Promise<ActionRun[]> {
    const page = await this.api<{ workflow_runs?: ActionRun[] }>(this.o.admin, "GET", `${this.r}/actions/runs?limit=50`);
    return page?.workflow_runs ?? [];
  }
}

export interface RegisterRunnerOptions extends Omit<RunnerConfigOptions, "uuid" | "token"> {
  /** Forgejo as the driver reaches it. */
  url: string;
  adminToken: string;
  /** The runner's name on the forge. */
  name: string;
  /** Write the config into the runner's /data/config.yml (`docker compose exec -T forgejoRunner sh -c 'cat > ...'`). */
  writeConfig(text: string): Promise<void>;
  /** Restart the runner so a running one reads the new credentials. */
  restart(): Promise<void>;
}

/**
 * Register forgejo-runner the Forgejo 16 / runner 13 way (terragucci
 * stack/bootstrap.sh): create the runner on the server, which answers with a
 * uuid and a token, drop earlier registrations of the same name that are
 * offline, write the config naming that pair, and restart the runner.
 */
export async function registerForgejoRunner(o: RegisterRunnerOptions): Promise<{ uuid: string }> {
  const listed = await forgejoApi<Array<{ id: number; name: string; status: string }>>(o.url, o.adminToken, "GET", "/admin/actions/runners");
  for (const stale of (listed ?? []).filter((r) => r.name === o.name && r.status === "offline")) {
    await forgejoApi(o.url, o.adminToken, "DELETE", `/admin/actions/runners/${stale.id}`, undefined, { missingOk: true });
  }
  const reg = await forgejoApi<{ uuid?: string; token?: string }>(o.url, o.adminToken, "POST", "/admin/actions/runners", {
    name: o.name,
    description: "chant e2e harness, docker executor",
  });
  if (!reg?.uuid || !reg.token) throw new Error("Forgejo created no runner (no uuid or token in its answer)");
  await o.writeConfig(forgejoRunnerConfig({ ...o, uuid: reg.uuid, token: reg.token }));
  await o.restart();
  return { uuid: reg.uuid };
}
