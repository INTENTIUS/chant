import { homedir } from "os";
import { dirname, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { fetchWithCache, extractFromZip, clearCacheFile } from "@intentius/chant/codegen/fetch";
import { ACCEPT_ENV, AWS_SPEC_PIN, specContentDigest, type SpecPin } from "./pin";

/**
 * Top-level CloudFormation Registry JSON Schema for a single resource type.
 */
export interface CFNSchema {
  typeName: string;
  description?: string;
  properties?: Record<string, SchemaProperty>;
  definitions?: Record<string, SchemaDefinition>;
  required?: string[];
  readOnlyProperties?: string[];
  createOnlyProperties?: string[];
  writeOnlyProperties?: string[];
  primaryIdentifier?: string[];
  deprecatedProperties?: string[];
  conditionalCreateOnlyProperties?: string[];
  replacementStrategy?: string;
  tagging?: {
    taggable?: boolean;
    tagOnCreate?: boolean;
    tagUpdatable?: boolean;
    cloudFormationSystemTags?: boolean;
    tagProperty?: string;
  };
  additionalProperties?: boolean;
}

/**
 * A single property in a CloudFormation Registry schema.
 */
export interface SchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: string[];
  $ref?: string;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  oneOf?: unknown[];
  anyOf?: unknown[];
  required?: string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  const?: unknown;
  default?: unknown;
}

/**
 * A named type within the definitions section.
 */
export interface SchemaDefinition {
  type?: string | string[];
  description?: string;
  enum?: string[];
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  items?: SchemaProperty;
}

const SCHEMA_ZIP_URL = "https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip";
const CACHE_DIR = join(homedir(), ".chant");
const CACHE_FILE = join(CACHE_DIR, "CloudformationSchema.zip");

/**
 * The committed, content-addressed pin archive (chant #1511) — `spec-archive/
 * <first 12 digest hex>.zip` at the package root, beside `src/`/`dist/` so the
 * path resolves from both layouts and the npm tarball (`files: ["src/",
 * "dist/"]`) never carries it.
 *
 * Why it exists: `prepack` regenerates from upstream, and the registry serves
 * a single mutable "latest" artifact — on 2026-08-05 four distinct contents
 * were observed in one day, two of them *contradicting* each other about the
 * same resources, so the surface gate compared artifacts built from whichever
 * variant that fetch happened to hit. Publishing aws was a retry lottery
 * (v0.41.1 and v0.41.2 both stranded it). The accepted content itself is the
 * only deterministic input, so the accept commits it.
 */
export function pinnedArchivePath(pin: SpecPin = AWS_SPEC_PIN): string {
  const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const hex = pin.digest.replace(/^sha256:/, "").slice(0, 12);
  return join(packageRoot, "spec-archive", `${hex}.zip`);
}

/**
 * Load and verify the pinned archive: undefined when it is not committed
 * (fall back to the live fetch — a fresh clone that never accepted, or an npm
 * install, where the tarball excludes it), a schema map when its extracted
 * content digests to exactly the pin, and a throw when it does not — a
 * corrupted or half-updated archive must never silently pass as the accepted
 * spec.
 */
export async function loadPinnedSchemas(
  options: { pin?: SpecPin; path?: string } = {},
): Promise<Map<string, Buffer> | undefined> {
  const pin = options.pin ?? AWS_SPEC_PIN;
  const path = options.path ?? pinnedArchivePath(pin);
  if (!existsSync(path)) return undefined;
  const schemas = await extractRawSchemas(readFileSync(path));
  const digest = specContentDigest(schemas);
  if (digest !== pin.digest) {
    throw new Error(
      `pinned schema archive ${path} extracts to ${digest}, but the pin declares ${pin.digest} — ` +
        `the archive and src/spec/pin.ts must move together. Re-run the accept ` +
        `(${ACCEPT_ENV}=1 npm run generate) and commit both.`,
    );
  }
  return schemas;
}

/** Write the just-accepted zip as the new pin archive and say where it landed. */
function storePinnedArchive(zipData: Buffer, digest: string): void {
  const path = pinnedArchivePath({ ...AWS_SPEC_PIN, digest });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, zipData);
  console.error(
    `Accepted spec written to ${path} — commit it with the pin, and remove the previous spec-archive/*.zip.`,
  );
}

/**
 * Fetch the CloudFormation Registry schema zip and extract per-resource JSON schemas.
 * Returns a Map keyed by typeName (e.g. "AWS::S3::Bucket") to raw JSON bytes.
 *
 * chant #1511 — the committed pin archive is the primary source: when present
 * and matching the pin, generation never touches the network, so every build
 * (CI, prepack, publish) works from the content a human accepted rather than
 * whatever upstream variant this fetch happens to hit. The live fetch remains
 * for: `force`, the accept flow (`CHANT_ACCEPT_AWS_SPEC=1`, which must sample
 * upstream — and bypasses the 24h cache for the same reason), and checkouts
 * with no archive committed. Uses a local cache with 24h TTL on that path.
 */
export async function fetchSchemaZip(force = false): Promise<Map<string, Buffer>> {
  const accepting = !!process.env[ACCEPT_ENV];
  if (!force && !accepting) {
    const pinned = await loadPinnedSchemas();
    if (pinned) return pinned;
  }
  const zipData = await fetchWithCache(
    { url: SCHEMA_ZIP_URL, cacheFile: CACHE_FILE },
    force || accepting,
  );
  const schemas = await extractRawSchemas(zipData);
  if (accepting) {
    storePinnedArchive(zipData, specContentDigest(schemas));
  }
  return schemas;
}

/**
 * Extract raw JSON schema bytes from the zip, keyed by typeName.
 */
async function extractRawSchemas(zipData: Buffer): Promise<Map<string, Buffer>> {
  const files = await extractFromZip(zipData, (name) => name.endsWith(".json"));

  const schemas = new Map<string, Buffer>();
  for (const [_name, data] of files) {
    try {
      const text = data.toString("utf-8");
      const partial = JSON.parse(text) as { typeName?: string };
      if (!partial.typeName) continue;
      schemas.set(partial.typeName, data);
    } catch {
      // Skip files that can't be parsed
    }
  }

  return schemas;
}

/**
 * Get the cache file path (for testing)
 */
export function getCachePath(): string {
  return CACHE_FILE;
}

/**
 * Clear the cache (for testing)
 */
export function clearCache(): void {
  clearCacheFile(CACHE_FILE);
}
