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

  /** The published release for `tag`, or null. A draft is not found here. */
  async publishedRelease(tag: string): Promise<GitHubRelease | null> {
    const res = await this.call("GET", `/releases/tags/${encodeURIComponent(tag)}`);
    if (res.status === 404) return null;
    if (res.status !== 200 || !res.json) this.fail(`reading release ${tag}`, res);
    return toRelease(res.json as Record<string, unknown>);
  }

  /** The draft release for `tag` named `name`, or null. */
  async draftRelease(tag: string, name: string): Promise<GitHubRelease | null> {
    const res = await this.call("GET", "/releases?per_page=100");
    if (res.status !== 200) this.fail("listing releases", res);
    const found = (Array.isArray(res.json) ? (res.json as Array<Record<string, unknown>>) : []).find((r) => r.draft === true && r.tag_name === tag && r.name === name);
    return found ? toRelease(found) : null;
  }

  /** A new draft release for `tag` named `name`, at `commit`. */
  async createDraft(tag: string, commit: string, name: string): Promise<GitHubRelease> {
    const res = await this.call("POST", "/releases", JSON.stringify({ tag_name: tag, target_commitish: commit, name, draft: true }));
    if (res.status !== 201 || !res.json) this.fail(`creating a draft release ${tag}`, res);
    return toRelease(res.json as Record<string, unknown>);
  }

  /** Upload `bytes` as the asset `name` of `release`. */
  async uploadAsset(release: GitHubRelease, name: string, bytes: Uint8Array): Promise<void> {
    const base = (release.uploadUrl ?? `${this.root}/releases/${release.id}/assets`).replace(/\{[^}]*\}$/, "");
    const res = await this.call("POST", `${base}?name=${encodeURIComponent(name)}`, bytes, { "content-type": "application/octet-stream" });
    if (res.status !== 201) this.fail(`uploading ${name}`, res);
  }

  /** Publish the draft `id`, with `make_latest` when it is given. */
  async publishDraft(id: string, makeLatest: string | undefined): Promise<GitHubAnswer> {
    return this.call("PATCH", `/releases/${id}`, JSON.stringify(makeLatest === undefined ? { draft: false } : { draft: false, make_latest: makeLatest }));
  }

  /** Delete the release `id`. Its tag stays. */
  async deleteRelease(id: string): Promise<void> {
    const res = await this.call("DELETE", `/releases/${id}`);
    if (res.status !== 204 && res.status !== 404) this.fail(`deleting release ${id}`, res);
  }

  /** Delete `refs/<ref>`. One that is not there is already gone. */
  async deleteRef(ref: string): Promise<void> {
    const res = await this.call("DELETE", `/git/refs/${ref}`);
    if (res.status !== 204 && res.status !== 404 && res.status !== 422) this.fail(`deleting ${ref}`, res);
  }
}

/** A GitHub release as the targets read it. */
export interface GitHubRelease {
  id: string;
  draft: boolean;
  /** Asset names, with the digest GitHub reports. */
  assets: Map<string, string | null>;
  uploadUrl?: string;
}

function toRelease(body: Record<string, unknown>): GitHubRelease {
  const assets = new Map<string, string | null>();
  for (const a of (body.assets as Array<{ name: string; digest?: string | null }> | undefined) ?? []) assets.set(a.name, typeof a.digest === "string" ? a.digest : null);
  return { id: String(body.id), draft: body.draft === true, assets, ...(typeof body.upload_url === "string" ? { uploadUrl: body.upload_url } : {}) };
}
