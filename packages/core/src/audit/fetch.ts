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

/**
 * Like `getJsonAt`, but for search endpoints specifically: a 404 here means
 * "this endpoint doesn't exist" (an unsupported/misconfigured search API — the
 * real-world case for Forgejo, whose code-search availability is undocumented,
 * #520), not "zero results" the way a missing *file* would be. Zero results are
 * a 200 with an empty array/list, so treating 404 as an error (rather than
 * `getJsonAt`'s "return null" leniency) lets a genuinely unsupported search API
 * fall back to the walk instead of silently reporting no matches.
 */
async function getSearchJsonAt(url: string, headers: Record<string, string>, doFetch: typeof fetch, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await doFetch(url, { headers, redirect: "manual", signal: timeoutSignal(timeoutMs) });
  } catch (err) {
    throw new FetchError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 300 && res.status < 400) throw new FetchError(`Refusing to follow redirect from ${url}`);
  if (!res.ok) throw new FetchError(`${url} returned ${res.status}`);
  return res.json();
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

// ── Search-first discovery for large repos (#520) ───────────────────────────
//
// A full tree walk + extension filter over-fetches badly on a large monorepo
// (thousands of `.yml`/`.json` candidates, almost all irrelevant) and still
// misses IaC/CI content living at non-canonical paths. Above a size threshold,
// switch from "walk everything `isCandidatePath` allows" to "search for each
// content-detected lexicon's characteristic signature, download only hits":
//
//   - Known-path lexicons (github, forgejo, and gitlab's canonical file) never
//     need a search query — their location is fixed, so a plain path/tree
//     lookup already finds them for any repo size. GitHub/Forgejo Actions
//     *must* live under `.github`/`.forgejo` workflows (the platform enforces
//     it), so no search term is listed for them at all. GitLab's `include:`
//     can pull in CI files from anywhere, so its canonical file is still
//     backed by a `stages:` search term to catch those satellites (#518).
//   - Content-detected lexicons (k8s, aws, azure, gcp, docker, helm) have no
//     fixed path, so at scale the only cheap way to find them is a search for
//     the grep-equivalent of their `detectTemplate` signature.
//   - Search is additive, never load-bearing: any error, rate limit, or
//     unsupported/unavailable API degrades to the walk rather than failing
//     the audit.

/** Repos above this many tree entries switch from the walk to search-first
 * discovery. Cheap to evaluate — it's the size of a call already being made
 * (GitHub/Forgejo's one-shot recursive tree; GitLab's first root-tree page,
 * see below) — and keeps small repos on the walk, which needs no search API
 * at all and so works even where search is unavailable (e.g. a Forgejo
 * instance with no code indexer). */
const LARGE_REPO_TREE_ENTRIES = 500;

/** How many result pages to pull per search term. GitLab's basic (non-
 * Elasticsearch) blob search returns at most ~20 results per query regardless
 * of `per_page` and doesn't paginate past them; GitHub code search is rate-
 * limited (~10 req/min unauthenticated) and caps at 1000 results/query. Either
 * way, a short page (`< per_page`) already stops the loop early — this is just
 * a hard ceiling on round trips per term. */
const MAX_SEARCH_PAGES = 3;

/**
 * Content-detected lexicons: no canonical path, so search-first discovery
 * needs one characteristic content term per lexicon, taken from that lexicon's
 * own `detectTemplate` signature. One row per lexicon — docker gets two
 * (Dockerfile and Compose share nothing in content) — so adding a new
 * content-detected lexicon here is the only step needed to search for it.
 * Ordered most → least selective; the caller de-duplicates by path, so a
 * broader later term (`apiVersion`) adds nothing for files the more specific
 * earlier term (`apiVersion: v2`) already found.
 */
const CONTENT_SEARCH_TERMS: Array<{ lexicon: AuditLexicon; term: string }> = [
  { lexicon: "aws", term: "AWSTemplateFormatVersion" }, // CloudFormation
  { lexicon: "azure", term: "deploymentTemplate" }, // ARM $schema substring
  { lexicon: "gcp", term: "cnrm.cloud.google.com" }, // GCP Config Connector
  { lexicon: "helm", term: "apiVersion: v2" }, // Chart.yaml
  { lexicon: "docker", term: "FROM " }, // Dockerfiles (space avoids false hits)
  { lexicon: "docker", term: "services:" }, // Docker Compose
  { lexicon: "k8s", term: "apiVersion" }, // any k8s resource (broad; runs last)
];

/** GitLab-only: `include:` can pull a CI file in from anywhere, so the
 * canonical-path lexicon still gets a search term (#518, #520). GitHub and
 * Forgejo Actions have no such mechanism, so they need none. */
const GITLAB_CI_TERM = "stages:";

/** One page of GitLab's blob search (`scope=blobs`) for a single term. */
async function gitlabSearchPage(host: HostConfig, owner: string, repo: string, ref: string, term: string, page: number, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<string[]> {
  const url = `${host.api}/projects/${projectId(owner, repo)}/search?scope=blobs&search=${encodeURIComponent(term)}&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`;
  const body = await getSearchJsonAt(url, headers, doFetch, ms);
  if (!Array.isArray(body)) return [];
  return (body as Array<{ path?: string }>).map((e) => e.path).filter((p): p is string => typeof p === "string");
}

/**
 * GitLab content search across every term (CI + content-detected lexicons),
 * de-duplicated by path. Throws on the first request error (a 401 with a bad
 * or absent token, a rate limit, a transient failure) — the caller catches
 * that and falls back to the BFS walk (#520).
 */
async function gitlabSearch(host: HostConfig, owner: string, repo: string, ref: string, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  const seen = new Set<string>();
  const terms = [GITLAB_CI_TERM, ...CONTENT_SEARCH_TERMS.map((t) => t.term)];
  for (const term of terms) {
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const hits = await gitlabSearchPage(host, owner, repo, ref, term, page, doFetch, headers, ms);
      if (hits.length === 0) break;
      for (const p of hits) if (!seen.has(p)) { seen.add(p); out.push({ path: p, type: "blob" }); }
      if (hits.length < 100) break;
    }
  }
  return out;
}

/**
 * Non-recursive BFS over a bounded directory frontier. GitLab's recursive tree
 * API lists ALL directories before any blobs for large repos (#518), so this
 * walks directories breadth-first to ensure root blobs appear on the first
 * request regardless of how many subdirectories follow. `seedRootPage1`, when
 * given, is the root's page-1 entries already fetched by the size probe below
 * — reused here so the small-repo path never double-fetches it.
 */
async function gitlabBfsWalk(host: HostConfig, owner: string, repo: string, ref: string, doFetch: typeof fetch, headers: Record<string, string>, ms: number, seedRootPage1?: Array<{ path: string; type: string }>): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  const queue: string[] = [""]; // "" = repo root
  const MAX_DIRS = 30;
  const MAX_BLOBS = 200;
  let dirs = 0;
  while (queue.length > 0 && dirs < MAX_DIRS && out.length < MAX_BLOBS) {
    const dir = queue.shift()!;
    dirs++;
    const pathParam = dir ? `&path=${encodeURIComponent(dir)}` : "";
    for (let page = 1; page <= 5; page++) {
      let body: unknown;
      if (dir === "" && page === 1 && seedRootPage1) {
        body = seedRootPage1;
      } else {
        const url = `${host.api}/projects/${projectId(owner, repo)}/repository/tree?per_page=100&page=${page}&ref=${encodeURIComponent(ref)}${pathParam}`;
        ({ body } = await getJsonAt(url, headers, doFetch, ms));
      }
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

/**
 * GitLab tree discovery: a cheap size probe (the root's first tree page, which
 * every path below needs anyway) decides walk vs. search. GitLab's own
 * recursive-tree endpoint can't be used to size the repo up front — that's the
 * exact pagination trap #518 fixed (directories dominate the page cap before
 * any blob appears) — so "is the root itself large" (a full 100-entry page)
 * stands in for "is the repo large".
 */
async function listTreeGitLab(host: HostConfig, owner: string, repo: string, ref: string, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<TreeEntry[]> {
  const rootUrl = `${host.api}/projects/${projectId(owner, repo)}/repository/tree?per_page=100&page=1&ref=${encodeURIComponent(ref)}`;
  const { body: rootBody } = await getJsonAt(rootUrl, headers, doFetch, ms);
  const rootPage1 = Array.isArray(rootBody) ? (rootBody as Array<{ path: string; type: string }>) : [];
  const isLarge = rootPage1.length >= 100;

  if (isLarge && "PRIVATE-TOKEN" in headers) {
    // GitLab's search API requires authentication even for public projects, so
    // this branch only ever runs with a token. Any failure — no search access,
    // a rate limit, a transient error — falls back to the walk (#520) rather
    // than failing the audit.
    try {
      return await gitlabSearch(host, owner, repo, ref, doFetch, headers, ms);
    } catch {
      // fall through to the walk below
    }
  }
  return gitlabBfsWalk(host, owner, repo, ref, doFetch, headers, ms, rootPage1);
}

/** One page of GitHub's code search (`GET /search/code`) for a single term. */
async function githubSearchPage(host: HostConfig, owner: string, repo: string, term: string, page: number, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<string[]> {
  const q = encodeURIComponent(`${term} repo:${owner}/${repo}`);
  const url = `${host.api}/search/code?q=${q}&per_page=100&page=${page}`;
  const body = await getSearchJsonAt(url, { ...headers, Accept: "application/vnd.github+json" }, doFetch, ms);
  const items = (body as { items?: Array<{ path?: string }> } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map((e) => e.path).filter((p): p is string => typeof p === "string");
}

/**
 * GitHub code search across the content-detected lexicons. Rate-limited to
 * ~10 req/min unauthenticated (#520) — a 403/422/429 throws (via `getSearchJsonAt`)
 * and the caller falls back to the already-fetched full tree.
 */
async function githubCodeSearch(host: HostConfig, owner: string, repo: string, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  const seen = new Set<string>();
  for (const { term } of CONTENT_SEARCH_TERMS) {
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const hits = await githubSearchPage(host, owner, repo, term, page, doFetch, headers, ms);
      if (hits.length === 0) break;
      for (const p of hits) if (!seen.has(p)) { seen.add(p); out.push({ path: p, type: "blob" }); }
      if (hits.length < 100) break;
    }
  }
  return out;
}

/**
 * One page of a Forgejo/Gitea repo code search. The shape here mirrors Gitea's
 * `{ok, data}` search envelope (also used by `GET /repos/search`), tolerating
 * a bare array too — Forgejo's code-search REST surface (and whether an
 * instance even runs a code indexer) isn't consistently documented across
 * versions (#520), so this is best-effort: any unexpected shape/status throws
 * and the caller falls back to the full tree, never breaking the audit.
 */
async function forgejoSearchPage(host: HostConfig, owner: string, repo: string, term: string, page: number, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<string[]> {
  const url = `${host.api}/repos/${owner}/${repo}/search?q=${encodeURIComponent(term)}&page=${page}&limit=100`;
  const body = await getSearchJsonAt(url, headers, doFetch, ms);
  const data = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return (data as Array<{ path?: string }>).map((e) => e.path).filter((p): p is string => typeof p === "string");
}

/** Forgejo/Gitea code search across the content-detected lexicons. See `forgejoSearchPage`. */
async function forgejoCodeSearch(host: HostConfig, owner: string, repo: string, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  const seen = new Set<string>();
  for (const { term } of CONTENT_SEARCH_TERMS) {
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const hits = await forgejoSearchPage(host, owner, repo, term, page, doFetch, headers, ms);
      if (hits.length === 0) break;
      for (const p of hits) if (!seen.has(p)) { seen.add(p); out.push({ path: p, type: "blob" }); }
      if (hits.length < 100) break;
    }
  }
  return out;
}

/**
 * GitHub/Forgejo tree discovery: their `git/trees?recursive=1` API returns the
 * whole tree in one call (no GitLab-style ordering trap), so the entry count
 * from that single call is a free large-repo signal. Below the threshold,
 * behavior is unchanged — the full blob list, later filtered by
 * `isCandidatePath`. Above it, known-path lexicons (CI) are kept straight from
 * the tree we already have — free, no search needed — and the content-detected
 * lexicons are found by search instead of downloaded wholesale.
 */
async function listTreeGitHubLike(host: HostConfig, owner: string, repo: string, ref: string, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<TreeEntry[]> {
  const url = `${host.api}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const { body } = await getJsonAt(url, headers, doFetch, ms);
  const treeBody = body as { tree?: TreeEntry[]; truncated?: boolean } | null;
  const tree = treeBody?.tree;
  if (!Array.isArray(tree)) return [];
  const blobs = tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, type: "blob", size: e.size }));

  const isLarge = blobs.length > LARGE_REPO_TREE_ENTRIES || treeBody?.truncated === true;
  if (!isLarge) return blobs;

  const { ciLexiconForPath } = await import("./discover");
  const known = blobs.filter((e) => ciLexiconForPath(e.path));
  try {
    const hits = host.kind === "github"
      ? await githubCodeSearch(host, owner, repo, doFetch, headers, ms)
      : await forgejoCodeSearch(host, owner, repo, doFetch, headers, ms);
    const knownPaths = new Set(known.map((e) => e.path));
    return [...known, ...hits.filter((h) => !knownPaths.has(h.path))];
  } catch {
    // Search unavailable/errored/rate-limited — degrade to the full tree we
    // already have, filtered by isCandidatePath downstream, same as a small
    // repo (#520: search is additive, never load-bearing).
    return blobs;
  }
}

/** List blob paths worth considering for download (all lexicons), choosing walk vs. search-first per host (#520). */
async function listTree(host: HostConfig, owner: string, repo: string, ref: string, doFetch: typeof fetch, headers: Record<string, string>, ms: number): Promise<TreeEntry[]> {
  if (host.kind === "gitlab") return listTreeGitLab(host, owner, repo, ref, doFetch, headers, ms);
  return listTreeGitHubLike(host, owner, repo, ref, doFetch, headers, ms);
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

