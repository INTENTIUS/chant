/**
 * Remote fetch — pull a repo's CI files from a git host so the auditor can run
 * on a URL, not just a local path. This is the ONLY audit module that touches
 * the network; the core stays pure.
 *
 * SSRF posture: only an allowlisted set of hosts is accepted; request URLs are
 * built from the parsed owner/repo (never a user-controlled host); redirects
 * are refused; and file count / size / total bytes / time are all capped.
 */

import type { AuditInput, AuditLexicon } from "./core";

export interface FetchOptions {
  /** Branch/tag/sha; defaults to the repo's default branch. */
  ref?: string;
  /** Server-side token (lifts rate limits). Never surfaced to callers. */
  token?: string;
  /** Max number of CI files to fetch (default 50). */
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

function authHeaders(kind: HostKind, token?: string): Record<string, string> {
  if (!token) return {};
  if (kind === "github") return { Authorization: `Bearer ${token}` };
  if (kind === "forgejo") return { Authorization: `token ${token}` };
  return { "PRIVATE-TOKEN": token };
}

function isYaml(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml");
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

export async function fetchCiFiles(url: string, opts: FetchOptions = {}): Promise<AuditInput[]> {
  const { host, owner, repo } = parseRepoUrl(url);
  const doFetch = opts.fetchImpl ?? fetch;
  const cfg = {
    maxFiles: opts.maxFiles ?? DEFAULTS.maxFiles,
    maxBytesPerFile: opts.maxBytesPerFile ?? DEFAULTS.maxBytesPerFile,
    maxTotalBytes: opts.maxTotalBytes ?? DEFAULTS.maxTotalBytes,
    timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
  };
  const headers = authHeaders(host.kind, opts.token);

  async function getJson(apiUrl: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await doFetch(apiUrl, { headers, redirect: "error", signal: timeoutSignal(cfg.timeoutMs) });
    } catch (err) {
      throw new FetchError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new FetchError(`Refusing to follow redirect from ${apiUrl}`);
    }
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new FetchError(`${apiUrl} returned ${res.status}`);
    return { status: res.status, body: await res.json() };
  }

  if (host.kind === "gitlab") {
    return fetchGitlab(host, owner, repo, opts.ref, cfg, doFetch, headers);
  }

  // GitHub / Forgejo share the Gitea-style contents API.
  const dirs = host.kind === "forgejo" ? [".forgejo/workflows", ".github/workflows"] : [".github/workflows"];
  const ref = opts.ref ? `?ref=${encodeURIComponent(opts.ref)}` : "";

  const candidates: ContentsEntry[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const { body } = await getJson(`${host.api}/repos/${owner}/${repo}/contents/${dir}${ref}`);
    if (!Array.isArray(body)) continue;
    for (const entry of body as ContentsEntry[]) {
      if (entry.type === "file" && isYaml(entry.name) && !seen.has(entry.path)) {
        seen.add(entry.path);
        candidates.push(entry);
      }
    }
  }

  const inputs: AuditInput[] = [];
  let total = 0;
  for (const entry of candidates) {
    if (inputs.length >= cfg.maxFiles) break;
    if ((entry.size ?? 0) > cfg.maxBytesPerFile) continue; // skip oversize
    const { body } = await getJson(`${host.api}/repos/${owner}/${repo}/contents/${entry.path}${ref}`);
    const file = body as ContentsEntry | null;
    if (!file?.content) continue;
    const content = Buffer.from(file.content, (file.encoding as BufferEncoding) ?? "base64").toString("utf-8");
    if (content.length > cfg.maxBytesPerFile) continue;
    total += content.length;
    if (total > cfg.maxTotalBytes) throw new FetchError("Repository CI files exceed the total size cap.");
    inputs.push({ path: entry.path, content, lexicon: host.lexicon });
  }
  return inputs;
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
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      redirect: "error",
      signal: timeoutSignal(opts.timeoutMs ?? DEFAULTS.timeoutMs),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { sha?: string };
    return body.sha && SHA40.test(body.sha) ? body.sha : undefined;
  } catch {
    return undefined;
  }
}

async function fetchGitlab(
  host: HostConfig,
  owner: string,
  repo: string,
  ref: string | undefined,
  cfg: { maxBytesPerFile: number; maxTotalBytes: number; timeoutMs: number },
  doFetch: typeof fetch,
  headers: Record<string, string>,
): Promise<AuditInput[]> {
  const projectId = encodeURIComponent(`${owner}/${repo}`);
  const refQ = `?ref=${encodeURIComponent(ref ?? "HEAD")}`;
  const apiUrl = `${host.api}/projects/${projectId}/repository/files/${encodeURIComponent(".gitlab-ci.yml")}/raw${refQ}`;
  let res: Response;
  try {
    res = await doFetch(apiUrl, { headers, redirect: "error", signal: timeoutSignal(cfg.timeoutMs) });
  } catch (err) {
    throw new FetchError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 300 && res.status < 400) throw new FetchError(`Refusing to follow redirect from ${apiUrl}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new FetchError(`${apiUrl} returned ${res.status}`);
  const content = await res.text();
  if (content.length > cfg.maxBytesPerFile || content.length > cfg.maxTotalBytes) {
    throw new FetchError("Pipeline file exceeds the size cap.");
  }
  return [{ path: ".gitlab-ci.yml", content, lexicon: "gitlab" }];
}
