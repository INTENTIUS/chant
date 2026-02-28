/**
 * Schema fetching — downloads Config Connector CRD bundle from GitHub releases.
 *
 * Uses the release bundle tar.gz, filtering for CRD YAML files.
 */

import { homedir } from "os";
import { join } from "path";
import { fetchWithCache, clearCacheFile } from "@intentius/chant/codegen/fetch";

/**
 * Pinned Config Connector version for reproducible codegen.
 */
export const KCC_VERSION = "v1.145.0";

const CACHE_DIR = join(homedir(), ".chant");

function bundleUrl(version: string): string {
  // The release-bundle.tar.gz asset is no longer published.
  // Use GitHub's auto-generated source tarball instead — CRDs are at config/crds/resources/.
  return `https://github.com/GoogleCloudPlatform/k8s-config-connector/archive/refs/tags/${version}.tar.gz`;
}

function cacheFile(version: string): string {
  return join(CACHE_DIR, `kcc-crds-${version}.tar.gz`);
}

/**
 * Fetch the Config Connector CRD bundle and extract CRD YAML files.
 *
 * Returns a Map keyed by CRD filename (e.g., "computeinstance.yaml") with
 * the raw YAML content as a Buffer.
 */
export async function fetchCRDBundle(
  force = false,
  version: string = KCC_VERSION,
): Promise<Map<string, Buffer>> {
  const url = bundleUrl(version);
  const cache = cacheFile(version);

  const tarData = await fetchWithCache({ url, cacheFile: cache }, force);
  return extractCRDs(tarData);
}

/**
 * Extract CRD YAML files from a tar.gz bundle.
 *
 * Filters for entries under a crds/ directory or standalone CRD YAML files.
 */
async function extractCRDs(tarData: Buffer): Promise<Map<string, Buffer>> {
  const { gunzipSync } = await import("fflate");
  const crds = new Map<string, Buffer>();

  // Decompress gzip synchronously (avoids lingering event loop references)
  const gunzipped = gunzipSync(new Uint8Array(tarData));

  // Parse tar (512-byte header blocks) with PAX extended header support.
  // GitHub source tarballs use PAX headers (type 'x') for long filenames.
  let offset = 0;
  const data = gunzipped;
  let paxPath: string | null = null;

  while (offset < data.length - 512) {
    const header = data.slice(offset, offset + 512);
    offset += 512;

    if (header.every((b) => b === 0)) break;

    // Extract filename: ustar prefix (bytes 345-499) + name (bytes 0-99)
    const nameBytes = header.slice(0, 100);
    const nameEnd = nameBytes.indexOf(0);
    let name = new TextDecoder().decode(nameBytes.slice(0, nameEnd > 0 ? nameEnd : 100)).trim();
    const prefixBytes = header.slice(345, 500);
    const prefixEnd = prefixBytes.indexOf(0);
    const ustarPrefix = new TextDecoder().decode(prefixBytes.slice(0, prefixEnd > 0 ? prefixEnd : 155)).trim();
    if (ustarPrefix) name = `${ustarPrefix}/${name}`;

    const sizeStr = new TextDecoder().decode(header.slice(124, 136)).trim().replace(/\0/g, "");
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = header[156];
    const typeFlagChar = String.fromCharCode(typeFlag);

    const blocks = Math.ceil(size / 512);
    const fileData = data.slice(offset, offset + size);
    offset += blocks * 512;

    // PAX extended header — extract path= for the next entry
    if (typeFlagChar === "x") {
      const paxStr = new TextDecoder().decode(fileData);
      const match = paxStr.match(/\bpath=([^\n]+)/);
      if (match) paxPath = match[1];
      continue;
    }

    // Use PAX path if available, then reset
    if (paxPath) {
      name = paxPath;
      paxPath = null;
    }

    // Only process regular files
    if (typeFlag !== 48 && typeFlag !== 0) continue;
    if (size === 0) continue;

    // Match CRD YAML files — source tarball has them at config/crds/resources/
    if (name.includes("config/crds/resources/") && name.endsWith(".yaml")) {
      const basename = name.split("/").pop() || name;
      crds.set(basename, Buffer.from(fileData));
    }
  }

  return crds;
}

export function getCachePath(version: string = KCC_VERSION): string {
  return cacheFile(version);
}

export function clearCache(version: string = KCC_VERSION): void {
  clearCacheFile(cacheFile(version));
}
