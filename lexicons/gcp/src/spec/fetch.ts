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
export const KCC_VERSION = "v1.125.0";

const CACHE_DIR = join(homedir(), ".chant");

function bundleUrl(version: string): string {
  return `https://github.com/GoogleCloudPlatform/k8s-config-connector/releases/download/${version}/release-bundle.tar.gz`;
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
  const { Decompress } = await import("fflate");
  const crds = new Map<string, Buffer>();

  // Decompress gzip
  const gunzipped = await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const decompress = new Decompress((chunk, final) => {
      if (chunk) chunks.push(chunk);
      if (final) {
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          result.set(c, offset);
          offset += c.length;
        }
        resolve(result);
      }
    });
    decompress.push(tarData, true);
  });

  // Parse tar (512-byte header blocks)
  let offset = 0;
  const data = gunzipped;

  while (offset < data.length - 512) {
    // Read header
    const header = data.slice(offset, offset + 512);
    offset += 512;

    // Empty header = end of archive
    if (header.every((b) => b === 0)) break;

    // Extract filename (bytes 0-99)
    const nameBytes = header.slice(0, 100);
    const nameEnd = nameBytes.indexOf(0);
    const name = new TextDecoder().decode(nameBytes.slice(0, nameEnd > 0 ? nameEnd : 100)).trim();

    // Extract size (bytes 124-135, octal)
    const sizeStr = new TextDecoder().decode(header.slice(124, 136)).trim().replace(/\0/g, "");
    const size = parseInt(sizeStr, 8) || 0;

    // Extract type flag (byte 156)
    const typeFlag = header[156];

    // Read file data (rounded up to 512-byte blocks)
    const blocks = Math.ceil(size / 512);
    const fileData = data.slice(offset, offset + size);
    offset += blocks * 512;

    // Only process regular files that look like CRD YAMLs
    if (typeFlag !== 48 && typeFlag !== 0) continue; // '0' or null = regular file
    if (size === 0) continue;

    // Match CRD YAML files
    const isCRDPath = name.includes("crds/") && name.endsWith(".yaml");
    const isCRDFile = name.endsWith("_crd.yaml") || name.endsWith(".crd.yaml");

    if (isCRDPath || isCRDFile) {
      const basename = name.split("/").pop() || name;
      crds.set(basename, Buffer.from(fileData));
    }
  }

  // If tar extraction yielded nothing, the bundle might be structured differently.
  // Try treating all YAML files as potential CRDs.
  if (crds.size === 0) {
    offset = 0;
    while (offset < data.length - 512) {
      const header = data.slice(offset, offset + 512);
      offset += 512;
      if (header.every((b) => b === 0)) break;

      const nameBytes = header.slice(0, 100);
      const nameEnd = nameBytes.indexOf(0);
      const name = new TextDecoder().decode(nameBytes.slice(0, nameEnd > 0 ? nameEnd : 100)).trim();
      const sizeStr = new TextDecoder().decode(header.slice(124, 136)).trim().replace(/\0/g, "");
      const size = parseInt(sizeStr, 8) || 0;
      const typeFlag = header[156];
      const blocks = Math.ceil(size / 512);
      const fileData = data.slice(offset, offset + size);
      offset += blocks * 512;

      if (typeFlag !== 48 && typeFlag !== 0) continue;
      if (size === 0) continue;
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;

      // Quick check: does it look like a CRD?
      const content = new TextDecoder().decode(fileData);
      if (content.includes("kind: CustomResourceDefinition") && content.includes("cnrm.cloud.google.com")) {
        const basename = name.split("/").pop() || name;
        crds.set(basename, Buffer.from(fileData));
      }
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
