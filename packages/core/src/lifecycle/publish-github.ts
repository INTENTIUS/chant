/**
 * The GitHub REST calls the targets that write to a repository other than the
 * release's use (#4676): the Homebrew tap's formula, the Tauri updater's
 * rolling release, and an index repository's manifests, fork and pull
 * request (#5158). Requests go through the injectable `fetch`, with the token
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

  /** The commits of `branch` that touch `path`, newest first, up to 100 (#5163). */
  async commitsTouching(path: string, branch: string): Promise<string[]> {
    const res = await this.call("GET", `/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&per_page=100`);
    if (res.status !== 200 || !Array.isArray(res.json)) this.fail(`listing the commits of ${branch} that touch ${path}`, res);
    return (res.json as Array<{ sha?: unknown }>).map((c) => c.sha).filter((c): c is string => typeof c === "string");
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

  /** True when the token sees the repository. */
  async exists(): Promise<boolean> {
    const res = await this.call("GET", "");
    if (res.status === 404) return false;
    if (res.status !== 200) this.fail("reading the repository", res);
    return true;
  }

  /** The commit a submodule at `path` points to at `ref`, or null when `path` is not a submodule there (#5158). */
  async submodule(path: string, ref: string): Promise<string | null> {
    const res = await this.call("GET", `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
    if (res.status === 404) return null;
    const body = res.json as { type?: unknown; sha?: unknown } | null;
    if (res.status !== 200) this.fail(`reading ${path} at ${ref}`, res);
    return body?.type === "submodule" && typeof body.sha === "string" ? body.sha : null;
  }

  /**
   * A commit on `parent` that writes each file, points each submodule
   * path at its commit and removes each `remove` path (#5163), made with
   * the git data API (#5158): one commit
   * whatever the number of files. No branch moves.
   */
  async commitTree(parent: string, changes: ReadonlyArray<{ path: string; bytes: Uint8Array } | { path: string; gitlink: string } | { path: string; remove: true }>, message: string): Promise<string> {
    const base = await this.call("GET", `/git/commits/${parent}`);
    const tree = (base.json as { tree?: { sha?: unknown } } | null)?.tree?.sha;
    if (base.status !== 200 || typeof tree !== "string") this.fail(`reading commit ${parent.slice(0, 12)}`, base);
    const entries: Array<Record<string, string | null>> = [];
    for (const c of changes) {
      if ("remove" in c) {
        // #5163: a null sha takes the path out of the tree.
        entries.push({ path: c.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      if ("gitlink" in c) {
        entries.push({ path: c.path, mode: "160000", type: "commit", sha: c.gitlink });
        continue;
      }
      const blob = await this.call("POST", "/git/blobs", JSON.stringify({ content: Buffer.from(c.bytes).toString("base64"), encoding: "base64" }));
      const sha = (blob.json as { sha?: unknown } | null)?.sha;
      if (blob.status !== 201 || typeof sha !== "string") this.fail(`writing ${c.path}`, blob);
      entries.push({ path: c.path, mode: "100644", type: "blob", sha });
    }
    const made = await this.call("POST", "/git/trees", JSON.stringify({ base_tree: tree, tree: entries }));
    const madeSha = (made.json as { sha?: unknown } | null)?.sha;
    if (made.status !== 201 || typeof madeSha !== "string") this.fail("writing the tree", made);
    const commit = await this.call("POST", "/git/commits", JSON.stringify({ message, tree: madeSha, parents: [parent] }));
    const commitSha = (commit.json as { sha?: unknown } | null)?.sha;
    if (commit.status !== 201 || typeof commitSha !== "string") this.fail("committing", commit);
    return commitSha;
  }

  /** Ask for the token's user's fork of this repository (#5158). GitHub answers with the fork it has, or makes one; it may take a moment to appear. Returns its `owner/name`. */
  async fork(): Promise<string> {
    const res = await this.call("POST", "/forks", JSON.stringify({ default_branch_only: true }));
    const name = (res.json as { full_name?: unknown } | null)?.full_name;
    if ((res.status !== 202 && res.status !== 200) || typeof name !== "string") this.fail("forking", res);
    return name;
  }

  /** The pull request from `head` (`owner:branch`) in any state, newest first, or null (#5158). */
  async findPull(head: string): Promise<GitHubPull | null> {
    const res = await this.call("GET", `/pulls?state=all&per_page=100&head=${encodeURIComponent(head)}`);
    if (res.status !== 200) this.fail(`listing pull requests from ${head}`, res);
    const list = Array.isArray(res.json) ? (res.json as Array<Record<string, unknown>>) : [];
    const found = list.find((p) => (p.head as { label?: unknown } | undefined)?.label === head) ?? null;
    return found ? toPull(found) : null;
  }

  /** Open a pull request from `head` (`owner:branch`) into `base`. */
  async openPull(title: string, body: string, head: string, base: string): Promise<GitHubPull> {
    const res = await this.call("POST", "/pulls", JSON.stringify({ title, body, head, base, maintainer_can_modify: true }));
    if (res.status !== 201 || !res.json) this.fail(`opening a pull request from ${head} into ${base}`, res);
    return toPull(res.json as Record<string, unknown>);
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

/** A pull request as the index target reads it (#5158). */
export interface GitHubPull {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
}

function toPull(body: Record<string, unknown>): GitHubPull {
  return {
    number: Number(body.number),
    url: typeof body.html_url === "string" ? body.html_url : `#${String(body.number)}`,
    state: body.state === "open" ? "open" : "closed",
    merged: typeof body.merged_at === "string" && body.merged_at.length > 0,
  };
}

/** A GitHub release as the targets read it. */
export interface GitHubRelease {
  id: string;
  draft: boolean;
  /** Asset names, with the digest GitHub reports. */
  assets: Map<string, string | null>;
  uploadUrl?: string;
  /** The release's name, when GitHub gives one. */
  name?: string;
}

function toRelease(body: Record<string, unknown>): GitHubRelease {
  const assets = new Map<string, string | null>();
  for (const a of (body.assets as Array<{ name: string; digest?: string | null }> | undefined) ?? []) assets.set(a.name, typeof a.digest === "string" ? a.digest : null);
  return { id: String(body.id), draft: body.draft === true, assets, ...(typeof body.upload_url === "string" ? { uploadUrl: body.upload_url } : {}), ...(typeof body.name === "string" ? { name: body.name } : {}) };
}
