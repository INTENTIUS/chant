/**
 * Generic HTTP fetch with caching and zip extraction utilities.
 *
 * Provides the download + cache + zip pattern used by lexicon codegen
 * pipelines that fetch schemas from remote sources.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync, rmSync } from "fs";
import { dirname, join } from "path";
import { debug } from "../cli/debug";

// ── Types ──────────────────────────────────────────────────────────

export interface FetchConfig {
  /** URL to fetch. */
  url: string;
  /** Local file path for caching the download. */
  cacheFile: string;
  /** Cache TTL in milliseconds (default: 24 hours). */
  cacheTtlMs?: number;
}

// ── Transient-aware fetch ──────────────────────────────────────────

/**
 * HTTP statuses worth retrying. These are transient: a gateway hiccup,
 * a rate limit, or an overloaded upstream — not a permanent 404/403.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const DEFAULT_RETRIES = 4;
const DEFAULT_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a URL, retrying on transient failures (network errors and
 * retryable HTTP statuses) with exponential backoff.
 *
 * Permanent failures (e.g. 404, 403) are not retried — they throw on the
 * first response. The returned response is guaranteed `ok`.
 *
 * `init` is passed through to `fetch` on every attempt, so callers that
 * need request headers (e.g. the GitHub API `Accept` header) or an abort
 * signal get retries without duplicating the loop.
 */
export async function fetchWithRetry(
  url: string,
  retries = DEFAULT_RETRIES,
  backoffMs = DEFAULT_BACKOFF_MS,
  init?: RequestInit,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = backoffMs * 2 ** (attempt - 1);
      debug(`retrying ${url} (attempt ${attempt}/${retries}) after ${delay}ms: ${lastError?.message}`);
      await sleep(delay);
    }

    let response: Response;
    try {
      response = init === undefined ? await fetch(url) : await fetch(url, init);
    } catch (e) {
      // Network-level failure (DNS, connection reset, timeout). Transient.
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }

    if (response.ok) return response;

    const err = new Error(`Download from ${url} returned ${response.status}`);
    if (!RETRYABLE_STATUSES.has(response.status)) throw err;
    lastError = err;
  }

  throw lastError ?? new Error(`Download from ${url} failed after ${retries} retries`);
}

// ── Fetch with cache ───────────────────────────────────────────────

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch a URL with local file caching.
 *
 * Returns cached data if the cache file exists and is younger than cacheTtlMs.
 * Otherwise downloads from the URL, caches the result, and returns it.
 */
export async function fetchWithCache(config: FetchConfig, force = false): Promise<Buffer> {
  const ttl = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  if (!force) {
    try {
      if (existsSync(config.cacheFile)) {
        const stat = statSync(config.cacheFile);
        if (Date.now() - stat.mtimeMs < ttl) {
          return readFileSync(config.cacheFile) as unknown as Buffer;
        }
      }
    } catch (e) {
      debug("cache read failed:", e);
    }
  }

  const response = await fetchWithRetry(config.url);
  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer);

  try {
    mkdirSync(dirname(config.cacheFile), { recursive: true });
    writeFileSync(config.cacheFile, data as unknown as Uint8Array);
  } catch (e) {
    debug("cache write failed:", e);
  }

  return data;
}

// ── Zip extraction ─────────────────────────────────────────────────

/**
 * Extract files from a zip buffer using fflate.
 *
 * @param filter - Optional predicate to select which files to include.
 *   Receives the file name (path within the zip). Defaults to all files.
 * @returns Map of filename → Buffer for each extracted file.
 */
export async function extractFromZip(
  zipData: Buffer,
  filter?: (name: string) => boolean,
): Promise<Map<string, Buffer>> {
  const { unzipSync } = await import("fflate");
  const files = unzipSync(new Uint8Array(zipData));

  const result = new Map<string, Buffer>();
  for (const [name, data] of Object.entries(files)) {
    if (filter && !filter(name)) continue;
    result.set(name, Buffer.from(data));
  }
  return result;
}

// ── Tar extraction ──────────────────────────────────────────────────

/**
 * Extract files from an uncompressed tar buffer.
 *
 * The caller handles gunzip (via `fflate.gunzipSync` or `zlib.gunzipSync`)
 * and any prefix stripping. Returns `Map<path, Buffer>`.
 *
 * @param filter - Optional predicate to select which files to include.
 *   Receives the full file name (path within the tar). Defaults to all regular files.
 */
export function extractFromTar(
  tarData: Uint8Array,
  filter?: (path: string) => boolean,
): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | null = null;

  while (offset < tarData.length - 512) {
    const header = tarData.slice(offset, offset + 512);
    offset += 512;

    // Check for end-of-archive marker (all zeros)
    if (header.every((b) => b === 0)) break;

    // Parse file name (first 100 bytes)
    const nameBytes = header.slice(0, 100);
    let name = new TextDecoder().decode(nameBytes).replace(/\0+$/, "");

    // Check type flag
    const typeFlag = String.fromCharCode(header[156]);

    // Parse file size (bytes 124-135, octal)
    const sizeStr = new TextDecoder().decode(header.slice(124, 136)).replace(/\0+$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;

    // Calculate blocks to skip
    const blocks = Math.ceil(size / 512);

    if (typeFlag === "L") {
      // GNU long name: read the name from the next data block
      const longNameData = tarData.slice(offset, offset + size);
      longName = new TextDecoder().decode(longNameData).replace(/\0+$/, "");
      offset += blocks * 512;
      continue;
    }

    // Apply long name from previous GNU 'L' entry
    if (longName !== null) {
      name = longName;
      longName = null;
    } else {
      // Check prefix field (bytes 345-500) for USTAR format
      const prefix = new TextDecoder().decode(header.slice(345, 500)).replace(/\0+$/, "");
      if (prefix) {
        name = prefix + "/" + name;
      }
    }

    const fileData = tarData.slice(offset, offset + size);
    offset += blocks * 512;

    // Skip non-regular files
    if (typeFlag !== "0" && typeFlag !== "\0") continue;

    if (filter && !filter(name)) continue;
    result.set(name, Buffer.from(fileData));
  }

  return result;
}

// ── Directory-level tar cache ───────────────────────────────────────

export interface FetchTarConfig {
  /** URL of the gzipped tarball. */
  url: string;
  /** Local directory for extracted files. */
  destDir: string;
  /** Cache TTL in milliseconds (default: 7 days). */
  cacheTtlMs?: number;
}

const DEFAULT_TAR_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Fetch a gzipped tarball, extract files matching `tarPrefix`, and cache them
 * in `destDir`. Returns `destDir`.
 *
 * Checks `destDir` mtime against TTL. If fresh, returns immediately.
 * Otherwise downloads, gunzips, extracts matching files, and writes to `destDir`.
 *
 * @param tarPrefix - Only files whose path (after stripping the top-level directory)
 *   starts with this prefix will be extracted.
 * @param force - If true, ignore cache and re-download.
 */
export async function fetchAndExtractTar(
  config: FetchTarConfig,
  tarPrefix: string,
  force = false,
): Promise<string> {
  const ttl = config.cacheTtlMs ?? DEFAULT_TAR_CACHE_TTL_MS;

  if (!force) {
    try {
      if (existsSync(config.destDir)) {
        const stat = statSync(config.destDir);
        if (Date.now() - stat.mtimeMs < ttl) {
          return config.destDir;
        }
      }
    } catch (e) {
      debug("tar cache check failed:", e);
    }
  }

  const resp = await fetchWithRetry(config.url);
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const { gunzipSync } = await import("fflate");
  const tarData = gunzipSync(compressed);

  // Remove old cache
  if (existsSync(config.destDir)) {
    rmSync(config.destDir, { recursive: true });
  }

  // Extract files matching the prefix
  let extracted = 0;
  const files = extractFromTar(tarData);

  for (const [name, data] of files) {
    // Strip top-level directory (e.g. "cfn-lint-main/")
    const slashIdx = name.indexOf("/");
    if (slashIdx < 0) continue;
    const relPath = name.slice(slashIdx + 1);

    if (!relPath.startsWith(tarPrefix)) continue;
    const localPath = relPath.slice(tarPrefix.length);
    if (!localPath) continue;

    const fullPath = join(config.destDir, localPath);
    const dir = dirname(fullPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, data as unknown as Uint8Array);
    extracted++;
  }

  if (extracted === 0) {
    throw new Error(`No files matching prefix "${tarPrefix}" found in tarball`);
  }

  return config.destDir;
}

// ── Cache utilities ────────────────────────────────────────────────

/**
 * Clear a cache file. Ignores errors if the file doesn't exist.
 */
export function clearCacheFile(cacheFile: string): void {
  try {
    if (existsSync(cacheFile)) unlinkSync(cacheFile);
  } catch (e) {
    debug("cache clear failed:", e);
  }
}
