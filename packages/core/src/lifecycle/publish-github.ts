/**
 * The GitHub REST calls the targets that write to a repository other than the
 * release's use (#4676): the Homebrew tap's formula, and the Tauri updater's
 * rolling release. Requests go through the injectable `fetch`, with the token
 * as a bearer, and every failure is redacted before it is thrown.
 */

import type { Credential } from "./publish-credentials";
import { PublishTargetError, type PublishContextBase, type PublishFetch } from "./release-publish";

/** The API root of GitHub: `api`, else `$GITHUB_API_URL`, else `https://api.github.com`. */
export function githubApi(api: string | undefined, env: NodeJS.ProcessEnv): string {
  return (api ?? env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
}

export interface GitHubAnswer {
  status: number;
  json: unknown;
  text: string;
}

/** One repository on GitHub, reached with one token. */
export class GitHubRepo {
  constructor(
    readonly api: string,
    readonly repo: string,
    private readonly token: Credential,
    private readonly fetchImpl: PublishFetch,
    private readonly ctx: PublishContextBase,
    /** The code a failed request throws. */
    private readonly code: string,
  ) {}

  get root(): string {
    return `${this.api}/repos/${this.repo}`;
  }

  async call(method: string, url: string, body?: Uint8Array | string, extra: Record<string, string> = {}): Promise<GitHubAnswer> {
    const headers = {
      authorization: `Bearer ${this.token.value}`,
      accept: "application/vnd.github+json",
      "user-agent": "chant",
      ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
      ...extra,
    };
    const res = await this.fetchImpl(url.startsWith("http") ? url : `${this.root}${url}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  fail(what: string, res: GitHubAnswer): never {
    throw new PublishTargetError(this.code, this.ctx.redactor.redact(`${what} on github ${this.repo} answered ${res.status}${res.text ? `: ${res.text.slice(0, 300)}` : ""}`));
  }

  /** The repository's default branch. */
  async defaultBranch(): Promise<string> {
    const res = await this.call("GET", "");
    const branch = (res.json as { default_branch?: unknown } | null)?.default_branch;
    if (res.status !== 200 || typeof branch !== "string") this.fail("reading the repository", res);
    return branch;
  }

  /** The commit `refs/heads/<branch>` points at, or null when there is no such branch. */
  async branchHead(branch: string): Promise<string | null> {
    const res = await this.call("GET", `/git/ref/heads/${branch}`);
    if (res.status === 404) return null;
    const sha = (res.json as { object?: { sha?: unknown } } | null)?.object?.sha;
    if (res.status !== 200 || typeof sha !== "string") this.fail(`reading branch ${branch}`, res);
    return sha;
  }

  /** A file's bytes and blob sha at `ref`, or null when it has none. */
  async file(path: string, ref: string): Promise<{ bytes: Buffer; sha: string } | null> {
    const res = await this.call("GET", `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
    if (res.status === 404) return null;
    const body = res.json as { content?: unknown; sha?: unknown; encoding?: unknown } | null;
    if (res.status !== 200 || typeof body?.sha !== "string" || typeof body.content !== "string") this.fail(`reading ${path} at ${ref}`, res);
    return { bytes: body.encoding === "base64" ? Buffer.from(body.content, "base64") : Buffer.from(body.content), sha: body.sha };
  }

  /** Commit `bytes` as `path` on `branch`, replacing the blob `sha` when the file is there. Returns the commit. */
  async putFile(path: string, branch: string, bytes: Uint8Array, message: string, sha: string | null): Promise<string> {
    const res = await this.call(
      "PUT",
      `/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
      JSON.stringify({ message, content: Buffer.from(bytes).toString("base64"), branch, ...(sha ? { sha } : {}) }),
    );
    const commit = (res.json as { commit?: { sha?: unknown } } | null)?.commit?.sha;
    if ((res.status !== 200 && res.status !== 201) || typeof commit !== "string") this.fail(`committing ${path} to ${branch}`, res);
    return commit;
  }

  /** Make `refs/heads/<branch>` at `sha`. */
  async createBranch(branch: string, sha: string): Promise<void> {
    const res = await this.call("POST", "/git/refs", JSON.stringify({ ref: `refs/heads/${branch}`, sha }));
    if (res.status !== 201) this.fail(`creating branch ${branch}`, res);
  }

  /** Move `refs/<ref>` to `sha`. Without `force`, a move that is not a fast-forward answers false. */
  async moveRef(ref: string, sha: string, force: boolean): Promise<boolean> {
    const res = await this.call("PATCH", `/git/refs/${ref}`, JSON.stringify({ sha, force }));
    if (res.status === 200) return true;
    if (res.status === 422 && !force) return false;
    this.fail(`moving ${ref} to ${sha.slice(0, 12)}`, res);
  }

  /** Delete `refs/<ref>`. One that is not there is already gone. */
  async deleteRef(ref: string): Promise<void> {
    const res = await this.call("DELETE", `/git/refs/${ref}`);
    if (res.status !== 204 && res.status !== 404 && res.status !== 422) this.fail(`deleting ${ref}`, res);
  }
}
