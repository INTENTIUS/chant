import { homedir } from "os";
import { dirname, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { fetchWithCache, extractFromZip, clearCacheFile } from "@intentius/chant/codegen/fetch";
import { RELEASE_GATE_ENV } from "@intentius/chant/codegen/validate";
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
 * The pinned-spec store (chant #1511): assets on one dedicated GitHub release,
 * named by content digest, in a public repo — so nothing binary ever enters
 * git history, and the download needs no auth anywhere (CI included).
 *
 * Why a store at all: `prepack` regenerates from upstream, and the registry
 * serves a single mutable "latest" artifact — on 2026-08-05 four distinct
 * contents were observed in one day, two *contradicting* each other about the
 * same resources, so the surface gate compared artifacts built from whichever
 * variant that fetch happened to hit. Publishing aws was a retry lottery
 * (v0.41.1 and v0.41.2 both stranded it). The accepted content itself is the
 * only deterministic input; the accept uploads it, every build downloads it
 * by digest and verifies before trusting it.
 */
const SPEC_PIN_RELEASE_TAG = "aws-spec-pin";
const SPEC_PIN_REPO = "INTENTIUS/chant";
/** Verified-by-digest local copies of pin assets, so repeat builds skip the download. Content-addressed: no TTL, never invalidated. */
const PIN_CACHE_DIR = join(CACHE_DIR, "spec-pin");

/** `<first 12 digest hex>.zip` — the asset (and local cache) name for a pin. */
export function pinAssetName(pin: SpecPin = AWS_SPEC_PIN): string {
  return `${pin.digest.replace(/^sha256:/, "").slice(0, 12)}.zip`;
}

/** Public, unauthenticated download URL for a pin's asset. */
export function pinAssetUrl(pin: SpecPin = AWS_SPEC_PIN): string {
  return `https://github.com/${SPEC_PIN_REPO}/releases/download/${SPEC_PIN_RELEASE_TAG}/${pinAssetName(pin)}`;
}

/** Injectable downloader, so tests never reach the network. Returns undefined on any failure — the caller falls back to the live fetch. */
export type PinAssetDownloader = (url: string) => Promise<Buffer | undefined>;

const downloadPinAsset: PinAssetDownloader = async (url) => {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return undefined;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return undefined;
  }
};

/**
 * Load and verify the pinned spec: the local verified cache first, then the
 * release asset. Returns undefined when neither is available (offline and
 * cold, or the accept never uploaded) — the caller falls back to the live
 * fetch and the pin's existing advisory drift report. Content that does not
 * digest to the pin throws: a tampered or half-uploaded asset must never
 * silently pass as the accepted spec, wherever it came from.
 */
export async function loadPinnedSchemas(
  options: { pin?: SpecPin; cacheDir?: string; download?: PinAssetDownloader } = {},
): Promise<Map<string, Buffer> | undefined> {
  const pin = options.pin ?? AWS_SPEC_PIN;
  const cacheDir = options.cacheDir ?? PIN_CACHE_DIR;
  const cachePath = join(cacheDir, pinAssetName(pin));

  const verify = async (zipData: Buffer, source: string): Promise<Map<string, Buffer>> => {
    const schemas = await extractRawSchemas(zipData);
    const digest = specContentDigest(schemas);
    if (digest !== pin.digest) {
      throw new Error(
        `pinned spec from ${source} extracts to ${digest}, but the pin declares ${pin.digest} — ` +
          `refusing to build from it. Re-run the accept (${ACCEPT_ENV}=1 npm run generate) to ` +
          `upload the content the pin actually names.`,
      );
    }
    return schemas;
  };

  if (existsSync(cachePath)) {
    return verify(readFileSync(cachePath), cachePath);
  }

  const url = pinAssetUrl(pin);
  const zipData = await (options.download ?? downloadPinAsset)(url);
  if (zipData === undefined) return undefined;
  const schemas = await verify(zipData, url);
  // Cache only after verification, so the cache can never hold a bad copy.
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, zipData);
  return schemas;
}

/**
 * The accept flow's upload half: push the just-accepted zip to the pin
 * release via `gh` (dev-machine path — publishes never upload). Creates the
 * rolling `aws-spec-pin` release on first use. Assets are content-addressed
 * and never overwritten. A missing/unauthenticated `gh` degrades to printing
 * the exact command to run by hand — the accept still completes, and the pin
 * block still prints.
 */
async function uploadPinAsset(zipData: Buffer, digest: string): Promise<void> {
  const pin: SpecPin = { ...AWS_SPEC_PIN, digest };
  mkdirSync(PIN_CACHE_DIR, { recursive: true });
  const localPath = join(PIN_CACHE_DIR, pinAssetName(pin));
  writeFileSync(localPath, zipData);

  const run = promisify(execFile);
  try {
    try {
      await run("gh", ["release", "view", SPEC_PIN_RELEASE_TAG, "--repo", SPEC_PIN_REPO]);
    } catch {
      await run("gh", [
        "release", "create", SPEC_PIN_RELEASE_TAG,
        "--repo", SPEC_PIN_REPO,
        "--title", "aws spec pin assets",
        "--notes", "Content-addressed CloudFormation registry archives, one per accepted spec pin (chant #1511). Uploaded by the accept flow; downloaded and digest-verified by every build. Not a chant release.",
      ]);
    }
    await run("gh", ["release", "upload", SPEC_PIN_RELEASE_TAG, localPath, "--repo", SPEC_PIN_REPO]);
    console.error(`Accepted spec uploaded: ${pinAssetUrl(pin)}`);
  } catch (err) {
    console.error(
      `Could not upload the accepted spec via gh (${err instanceof Error ? err.message.split("\n")[0] : String(err)}).\n` +
        `Upload it yourself before merging the pin:\n` +
        `  gh release upload ${SPEC_PIN_RELEASE_TAG} ${localPath} --repo ${SPEC_PIN_REPO}`,
    );
  }
}

/**
 * Fetch the CloudFormation Registry schema zip and extract per-resource JSON schemas.
 * Returns a Map keyed by typeName (e.g. "AWS::S3::Bucket") to raw JSON bytes.
 *
 * chant #1511 — the pinned release asset is the primary source: when it
 * resolves and digest-verifies, generation uses the content a human accepted
 * rather than whatever upstream variant this fetch happens to hit, so every
 * build (CI, prepack, publish) is deterministic. The live fetch remains for:
 * `force`, the accept flow (`CHANT_ACCEPT_AWS_SPEC=1`, which must sample
 * upstream — and bypasses the 24h cache for the same reason), and when the
 * asset is unreachable. The live path keeps its 24h local cache.
 *
 * chant #1481 — the fallback is what made two workflows disagree about one
 * commit. The live archive is served from CloudFront and two fetches seconds
 * apart can get different variants; under the release gate, building from
 * it would ship a surface nobody reviewed on a retry lottery, so the gate
 * refuses instead. Anywhere else the fallback stays, but says so, because a
 * silent fallback is indistinguishable from the pinned path in a CI log.
 */
export async function fetchSchemaZip(
  force = false,
  options: { env?: NodeJS.ProcessEnv; download?: PinAssetDownloader; pinCacheDir?: string } = {},
): Promise<Map<string, Buffer>> {
  const env = options.env ?? process.env;
  const accepting = !!env[ACCEPT_ENV];
  if (!force && !accepting) {
    const pinned = await loadPinnedSchemas({ download: options.download, cacheDir: options.pinCacheDir });
    if (pinned) return pinned;
    if (env[RELEASE_GATE_ENV] === "1") {
      throw new Error(
        `${RELEASE_GATE_ENV}=1 and the pinned spec asset could not be loaded (${pinAssetUrl()}) — ` +
          `refusing to build a release from the live CloudFormation archive, which is not the content ` +
          `the pin was reviewed against. Check the asset exists on the ${SPEC_PIN_RELEASE_TAG} release ` +
          `(the accept flow uploads it: ${ACCEPT_ENV}=1 npm run generate).`,
      );
    }
    console.error(`pinned spec asset unavailable (${pinAssetUrl()}); falling back to the live CloudFormation archive`);
  }
  const zipData = await fetchWithCache(
    { url: SCHEMA_ZIP_URL, cacheFile: CACHE_FILE },
    force || accepting,
  );
  const schemas = await extractRawSchemas(zipData);
  if (accepting) {
    await uploadPinAsset(zipData, specContentDigest(schemas));
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
