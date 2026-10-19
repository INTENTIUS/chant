/**
 * The forge, for real: the demo's Forgejo, through its REST API and git over
 * http, as three people. The author pushes, opens and merges; the reviewer
 * approves; the admin forces main back to the base and deletes branches at a
 * reset. Every call names the demo repo, chant-demo/fan-out-estate, on the
 * demo's own Forgejo, and nothing else.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO } from "../steps.js";
import { clone, git, remoteWith } from "./git.js";
import type { Clock, Forge } from "./ports.js";

export interface Person {
  login: string;
  token: string;
}

export interface ForgejoOptions {
  /** Forgejo as the driver reaches it, http://localhost:<port>. */
  url: string;
  admin: Person;
  author: Person;
  reviewer: Person;
  /** The base tree, a git repository holding the base commit. */
  baseTree: string;
  clock: Clock;
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

export class ForgejoForge implements Forge {
  constructor(private readonly o: ForgejoOptions) {}

  private api<T>(who: Person, method: string, path: string, body?: unknown, missingOk = false): Promise<T | null> {
    return forgejoApi<T>(this.o.url, who.token, method, path, body, { missingOk });
  }

  private remote(who: Person): string {
    return remoteWith(this.o.url, who.login, who.token, REPO);
  }

  async pushBranch(branch: string, files: Record<string, string>, message: string): Promise<string> {
    const a = this.o.author;
    const dir = await clone(this.remote(a), "author", [a.token]);
    try {
      await git(dir, ["checkout", "-q", "-b", branch]);
      for (const [path, content] of Object.entries(files)) {
        const to = join(dir, ...path.split("/"));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, content);
      }
      await git(dir, ["add", "-A"]);
      await git(dir, ["-c", `user.name=${a.login}`, "-c", `user.email=${a.login}@chant-demo.local`, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
      await git(dir, ["push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`], [a.token]);
      return await git(dir, ["rev-parse", "HEAD"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async openPull(branch: string, title: string, body: string): Promise<number> {
    const pull = await this.api<{ number?: number }>(this.o.author, "POST", `/repos/${REPO}/pulls`, { head: branch, base: "main", title, body });
    if (!pull?.number) throw new Error(`no pull request opened from ${branch}`);
    return pull.number;
  }

  async approvePull(pull: number, body: string): Promise<void> {
    await this.api(this.o.reviewer, "POST", `/repos/${REPO}/pulls/${pull}/reviews`, { event: "APPROVED", body });
  }

  async mergePull(pull: number): Promise<string> {
    // Forgejo checks a pull request's mergeability after it opens, so the
    // first try can be refused; it is tried again a few times.
    let lastErr: unknown;
    let merged = false;
    for (let i = 0; i < 10 && !merged; i++) {
      try {
        await this.api(this.o.author, "POST", `/repos/${REPO}/pulls/${pull}/merge`, { Do: "merge" });
        merged = true;
      } catch (err) {
        lastErr = err;
        await this.o.clock.sleep(2000);
      }
    }
    if (!merged) throw new Error(`pull request ${pull} did not merge: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    for (let i = 0; i < 30; i++) {
      const pr = await this.api<{ merge_commit_sha?: string }>(this.o.author, "GET", `/repos/${REPO}/pulls/${pull}`);
      if (pr?.merge_commit_sha) return pr.merge_commit_sha;
      await this.o.clock.sleep(1000);
    }
    throw new Error(`pull request ${pull} merged, but Forgejo names no merge commit`);
  }

  async openPulls(): Promise<number[]> {
    const pulls = await this.api<Array<{ number: number }>>(this.o.admin, "GET", `/repos/${REPO}/pulls?state=open&limit=50`);
    return (pulls ?? []).map((p) => p.number);
  }

  async closePull(pull: number): Promise<void> {
    await this.api(this.o.admin, "PATCH", `/repos/${REPO}/pulls/${pull}`, { state: "closed" });
  }

  async forceMain(sha: string): Promise<void> {
    const a = this.o.admin;
    await git(this.o.baseTree, ["push", "-q", "--force", this.remote(a), `${sha}:refs/heads/main`], [a.token]);
  }

  async branches(): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page < 50; page++) {
      const list = await this.api<Array<{ name: string }>>(this.o.admin, "GET", `/repos/${REPO}/branches?page=${page}&limit=50`);
      if (!list || list.length === 0) break;
      out.push(...list.map((b) => b.name));
      if (list.length < 50) break;
    }
    return out;
  }

  async deleteBranch(name: string): Promise<void> {
    await this.api(this.o.admin, "DELETE", `/repos/${REPO}/branches/${encodeURIComponent(name)}`, undefined, true);
  }
}
