/**
 * Remote fetch — pull a repo's candidate files (all lexicons) from a git host so
 * the auditor can run on a URL, not just a local path. This is the ONLY audit
 * module that touches the network; the core stays pure.
 *
 * SSRF posture: only an allowlisted set of hosts is accepted; request URLs are
 * built from the parsed owner/repo (never a user-controlled host); redirects
 * are refused; and file count / size / total bytes / time are all capped.
 */

import type { AuditLexicon } from "./core";

export interface FetchOptions {
  /** Branch/tag/sha; defaults to the repo's default branch. */
  ref?: string;
  /** Server-side token (lifts rate limits). Never surfaced to callers. */
  token?: string;
  /** Max number of files to fetch (default 50). */
  maxFiles?: number;
  /** Max bytes for a single file; larger files are skipped (default 256 KiB). */
  maxBytesPerFile?: number;
  /** Max total bytes across all files; exceeding throws (default 2 MiB). */
  maxTotalBytes?: number;
  /** Per-request timeout in ms (default 10000). */
  timeoutMs?: number;
  /** Injectable fetch for testing. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  maxFiles: 50,
  maxBytesPerFile: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  timeoutMs: 10_000,
};

type HostKind = "github" | "forgejo" | "gitlab";

interface HostConfig {
  kind: HostKind;
  api: string;
  lexicon: AuditLexicon;
}

const ALLOWED_HOSTS: Record<string, HostConfig> = {
  "github.com": { kind: "github", api: "https://api.github.com", lexicon: "github" },
  "codeberg.org": { kind: "forgejo", api: "https://codeberg.org/api/v1", lexicon: "forgejo" },
  "gitlab.com": { kind: "gitlab", api: "https://gitlab.com/api/v4", lexicon: "gitlab" },
};

export class FetchError extends Error {}

interface ParsedRepo {
  host: HostConfig;
  owner: string;
  repo: string;
}

/** Parse and validate a repo URL against the host allowlist (SSRF guard). */
export function parseRepoUrl(url: string): ParsedRepo {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FetchError(`Invalid URL: ${url}`);
  }
  if (u.protocol !== "https:") {
    throw new FetchError(`Only https:// URLs are allowed (got ${u.protocol}).`);
  }
  const host = ALLOWED_HOSTS[u.hostname];
  if (!host) {
    throw new FetchError(
      `Host not allowed: ${u.hostname}. Allowed: ${Object.keys(ALLOWED_HOSTS).join(", ")}.`,
    );
  }
  const parts = u.pathname.replace(/^\/+/, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new FetchError(`URL must be https://${u.hostname}/<owner>/<repo>.`);
  }
  return { host, owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}

/** GitHub (and good manners) require a User-Agent — workerd's fetch sends none,
 * so a missing UA 403s every request. Always set one, with or without a token. */
const USER_AGENT = "chant-audit (+https://github.com/intentius/chant)";

function authHeaders(kind: HostKind, token?: string): Record<string, string> {
  const base = { "User-Agent": USER_AGENT };
  if (!token) return base;
  if (kind === "github") return { ...base, Authorization: `Bearer ${token}` };
  if (kind === "forgejo") return { ...base, Authorization: `token ${token}` };
  return { ...base, "PRIVATE-TOKEN": token };
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** Gitea/GitHub contents-API entry (directory listing or single file). */
interface ContentsEntry {
  name: string;
  path: string;
  type: string;
  size?: number;
  content?: string;
  encoding?: string;
}

// ── Whole-repo fetch (all lexicons, not just CI) ─────────────────────────────
// Mirrors the local walk: list the repo tree, keep candidate paths, fetch their
// contents (capped), and hand the raw {path, content} set to the shared
// classifier in discover.ts. SSRF posture is unchanged — allowlisted host,
// URLs built from parsed owner/repo, redirects refused, counts/bytes capped.

/** Module-level JSON GET that refuses redirects (reused by the tree-walk). */
async function getJsonAt(
  url: string,
  headers: Record<string, string>,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await doFetch(url, { headers, redirect: "manual", signal: timeoutSignal(timeoutMs) });
  } catch (err) {
    throw new FetchError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 300 && res.status < 400) throw new FetchError(`Refusing to follow redirect from ${url}`);
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new FetchError(`${url} returned ${res.status}`);
  return { status: res.status, body: await res.json() };
}

function projectId(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

/** The repo's default branch, so the tree request has a concrete ref. */
async function defaultBranch(host: HostConfig, owner: string, repo: string, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<string> {
  const url =
    host.kind === "gitlab"
      ? `${host.api}/projects/${projectId(owner, repo)}`
      : `${host.api}/repos/${owner}/${repo}`;
  const { body } = await getJsonAt(url, headers, doFetch, ms);
  const branch = (body as { default_branch?: string } | null)?.default_branch;
  return branch && typeof branch === "string" ? branch : "HEAD";
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

/** List every blob path in the repo (recursive), with size where the host reports it. */
async function listTree(host: HostConfig, owner: string, repo: string, ref: string, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<TreeEntry[]> {
  if (host.kind === "gitlab") {
    // GitLab's recursive tree API returns ALL directory nodes before any blob nodes
    // for large repos (#518). A 20-page recursive scan sees only directories and
    // yields 0 files. Fix: non-recursive BFS so root blobs (e.g. .gitlab-ci.yml)
    // appear on the very first request, regardless of repo size.
    const out: TreeEntry[] = [];
    const queue: string[] = [""]; // "" = repo root
    const MAX_DIRS = 30;          // bound API calls; candidate filter + maxFiles cap trim further
    const MAX_BLOBS = 200;        // stop early once we have far more than any maxFiles default
    let dirs = 0;
    while (queue.length > 0 && dirs < MAX_DIRS && out.length < MAX_BLOBS) {
      const dir = queue.shift()!;
      dirs++;
      const pathParam = dir ? `&path=${encodeURIComponent(dir)}` : "";
      for (let page = 1; page <= 5; page++) {
        const url = `${host.api}/projects/${projectId(owner, repo)}/repository/tree?per_page=100&page=${page}&ref=${encodeURIComponent(ref)}${pathParam}`;
        const { body } = await getJsonAt(url, headers, doFetch, ms);
        if (!Array.isArray(body) || body.length === 0) break;
        for (const e of body as Array<{ path: string; type: string }>) {
          if (e.type === "blob") out.push({ path: e.path, type: "blob" });
          else if (e.type === "tree") queue.push(e.path);
        }
        if (body.length < 100) break;
      }
    }
    return out;
  }
  // GitHub / Forgejo (Gitea) share the git/trees recursive API.
  const url = `${host.api}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const { body } = await getJsonAt(url, headers, doFetch, ms);
  const tree = (body as { tree?: TreeEntry[] } | null)?.tree;
  if (!Array.isArray(tree)) return [];
  return tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, type: "blob", size: e.size }));
}

/**
 * Resilient GET → text. Returns undefined on any error or non-ok status, so one
 * file's failure (a bad path, a 403 secondary rate-limit, a timeout) never
 * aborts the whole walk. `redirect: "manual"` keeps the SSRF posture — a 3xx is
 * skipped, never followed.
 */
async function fetchText(url: string, headers: Record<string, string>, doFetch: typeof fetch, ms: number): Promise<string | undefined> {
  let res: Response;
  try {
    res = await doFetch(url, { headers, redirect: "manual", signal: timeoutSignal(ms) });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}

/**
 * Fetch one file's content. GitHub reads from the raw CDN first — a burst of
 * contents-API calls trips GitHub's *secondary* rate limit on large repos
 * (dozens of files), whereas raw.githubusercontent.com isn't subject to it and
 * needs no auth for public repos. The contents API is the fallback for private
 * repos (raw 404s there without auth). GitLab uses its raw endpoint; Forgejo
 * uses the contents API.
 */
async function fetchFileContent(host: HostConfig, owner: string, repo: string, path: string, ref: string, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<string | undefined> {
  // Encode each segment (keep the slashes) — paths can contain spaces and other
  // characters that make an unencoded URL malformed and 403 (e.g. GitHub's
  // changelog fragments like ".changes/v1.16/NEW FEATURES-….yaml").
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");

  if (host.kind === "gitlab") {
    const url = `${host.api}/projects/${projectId(owner, repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;
    return fetchText(url, headers, doFetch, ms);
  }

  if (host.kind === "github") {
    // No token sent cross-host to the CDN; public repos need none.
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${encodedPath}`;
    const raw = await fetchText(rawUrl, { "User-Agent": USER_AGENT }, doFetch, ms);
    if (raw !== undefined) return raw;
    // Private repo (raw 404s without auth) — fall through to the contents API.
  }

  // Contents API: base64 JSON. Forgejo always; GitHub private-repo fallback.
  const url = `${host.api}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
  let res: Response;
  try {
    res = await doFetch(url, { headers, redirect: "manual", signal: timeoutSignal(ms) });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  let file: ContentsEntry | null;
  try {
    file = (await res.json()) as ContentsEntry | null;
  } catch {
    return undefined;
  }
  if (!file?.content) return undefined;
  return Buffer.from(file.content, (file.encoding as BufferEncoding) ?? "base64").toString("utf-8");
}

/**
 * Fetch every candidate file in a repo (all lexicons), so a URL audit covers the
 * same ground as a local one. Returns raw {path, content}; classification (which
 * needs the lexicon plugins) is the caller's job via `classifyFiles`.
 */
export async function fetchRepoFiles(url: string, opts: FetchOptions = {}): Promise<Array<{ path: string; content: string }>> {
  const { isCandidatePath } = await import("./discover");
  const { host, owner, repo } = parseRepoUrl(url);
  const doFetch = opts.fetchImpl ?? fetch;
  const cfg = {
    maxFiles: opts.maxFiles ?? DEFAULTS.maxFiles,
    maxBytesPerFile: opts.maxBytesPerFile ?? DEFAULTS.maxBytesPerFile,
    maxTotalBytes: opts.maxTotalBytes ?? DEFAULTS.maxTotalBytes,
    timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
  };
  const headers = authHeaders(host.kind, opts.token);
  const ref = opts.ref ?? (await defaultBranch(host, owner, repo, doFetch, headers, cfg.timeoutMs));

  const tree = await listTree(host, owner, repo, ref, doFetch, headers, cfg.timeoutMs);
  const candidates = tree.filter((e) => isCandidatePath(e.path));

  const files: Array<{ path: string; content: string }> = [];
  let total = 0;
  for (const entry of candidates) {
    if (files.length >= cfg.maxFiles) break;
    if ((entry.size ?? 0) > cfg.maxBytesPerFile) continue; // skip oversize when the host reports size
    const content = await fetchFileContent(host, owner, repo, entry.path, ref, doFetch, headers, cfg.timeoutMs);
    if (content === undefined) continue;
    if (content.length > cfg.maxBytesPerFile) continue;
    total += content.length;
    if (total > cfg.maxTotalBytes) throw new FetchError("Repository files exceed the total size cap.");
    files.push({ path: entry.path, content });
  }
  return files;
}

const SHA40 = /^[0-9a-f]{40}$/;

/**
 * Resolve an action ref (e.g. action="actions/checkout", ref="v4") to its
 * commit SHA via the GitHub API. Returns undefined on any failure — pinning
 * degrades gracefully to guidance. Actions are GitHub-hosted slugs, so this
 * queries api.github.com regardless of the audited repo's host.
 */
export async function resolveActionSha(
  action: string,
  ref: string,
  opts: { token?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const parts = action.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  const [owner, repo] = parts;
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  try {
    const res = await doFetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      redirect: "manual",
      signal: timeoutSignal(opts.timeoutMs ?? DEFAULTS.timeoutMs),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { sha?: string };
    return body.sha && SHA40.test(body.sha) ? body.sha : undefined;
  } catch {
    return undefined;
  }
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Public registries we'll talk to. The image ref is untrusted (SSRF guard). */
const ALLOWED_REGISTRIES = new Set([
  "registry-1.docker.io",
  "ghcr.io",
  "quay.io",
  "gcr.io",
  "public.ecr.aws",
  "mcr.microsoft.com",
  "registry.gitlab.com",
]);

interface ImageRef {
  registry: string;
  repository: string;
  tag: string;
}

/** Parse a Docker/OCI image reference. Returns undefined if already digested. */
export function parseImageRef(ref: string): ImageRef | undefined {
  if (ref.includes("@")) return undefined; // already digest-pinned
  let registry = "registry-1.docker.io";
  let rest = ref;
  let repoPrefix = "";
  const firstSlash = ref.indexOf("/");
  const firstPart = firstSlash === -1 ? "" : ref.slice(0, firstSlash);
  if (firstPart && (firstPart.includes(".") || firstPart.includes(":") || firstPart === "localhost")) {
    registry = firstPart;
    rest = ref.slice(firstSlash + 1);
  } else if (firstSlash === -1) {
    repoPrefix = "library/"; // bare Docker Hub official image
  }
  let tag = "latest";
  const lastColon = rest.lastIndexOf(":");
  const lastSlash = rest.lastIndexOf("/");
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
  }
  if (!rest) return undefined;
  return { registry, repository: repoPrefix + rest, tag };
}

/** Parse a `Bearer realm=...,service=...,scope=...` challenge into a token URL. */
function tokenUrlFromChallenge(header: string): string | undefined {
  const m = /Bearer\s+(.*)/i.exec(header);
  if (!m) return undefined;
  const params: Record<string, string> = {};
  for (const part of m[1].split(",")) {
    const kv = /(\w+)="([^"]*)"/.exec(part.trim());
    if (kv) params[kv[1]] = kv[2];
  }
  if (!params.realm) return undefined;
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set("service", params.service);
  if (params.scope) url.searchParams.set("scope", params.scope);
  return url.toString();
}

/**
 * Resolve a container image `name:tag` to its `sha256:...` digest via the OCI
 * registry v2 API (anonymous bearer-token challenge). Returns undefined on any
 * failure or for a non-allowlisted registry. The image ref is untrusted, so we
 * only ever contact allowlisted public registries (SSRF guard).
 */
export async function resolveImageDigest(
  image: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const parsed = parseImageRef(image);
  if (!parsed || !ALLOWED_REGISTRIES.has(parsed.registry)) return undefined;
  const doFetch = opts.fetchImpl ?? fetch;
  const ms = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");
  const manifestUrl = `https://${parsed.registry}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.tag)}`;

  try {
    let res = await doFetch(manifestUrl, { headers: { Accept: accept, "User-Agent": USER_AGENT }, redirect: "manual", signal: timeoutSignal(ms) });
    if (res.status === 401) {
      const tokenUrl = tokenUrlFromChallenge(res.headers.get("www-authenticate") ?? "");
      if (!tokenUrl) return undefined;
      const tokRes = await doFetch(tokenUrl, { headers: { "User-Agent": USER_AGENT }, redirect: "manual", signal: timeoutSignal(ms) });
      if (!tokRes.ok) return undefined;
      const tok = (await tokRes.json()) as { token?: string; access_token?: string };
      const bearer = tok.token ?? tok.access_token;
      if (!bearer) return undefined;
      res = await doFetch(manifestUrl, { headers: { Accept: accept, "User-Agent": USER_AGENT, Authorization: `Bearer ${bearer}` }, redirect: "manual", signal: timeoutSignal(ms) });
    }
    if (!res.ok) return undefined;
    const digest = res.headers.get("docker-content-digest");
    return digest && DIGEST_RE.test(digest) ? digest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the audited repo's current commit SHA (best-effort) for the report
 * snapshot, so findings are anchored to an exact commit. Returns undefined on
 * any failure.
 */
export async function resolveRepoCommit(
  url: string,
  opts: { token?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | undefined> {
  let parsed: ParsedRepo;
  try {
    parsed = parseRepoUrl(url);
  } catch {
    return undefined;
  }
  const { host, owner, repo } = parsed;
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = authHeaders(host.kind, opts.token);
  const apiUrl =
    host.kind === "gitlab"
      ? `${host.api}/projects/${encodeURIComponent(`${owner}/${repo}`)}/repository/commits?per_page=1`
      : `${host.api}/repos/${owner}/${repo}/commits?per_page=1&limit=1`;
  try {
    const res = await doFetch(apiUrl, { headers, redirect: "manual", signal: timeoutSignal(opts.timeoutMs ?? DEFAULTS.timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Array<{ sha?: string; id?: string }>;
    if (!Array.isArray(body) || body.length === 0) return undefined;
    const sha = body[0].sha ?? body[0].id;
    return typeof sha === "string" ? sha : undefined;
  } catch {
    return undefined;
  }
}

