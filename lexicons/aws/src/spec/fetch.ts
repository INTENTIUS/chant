import { homedir } from "os";
import { join } from "path";
import { fetchWithCache, extractFromZip, clearCacheFile } from "@intentius/chant/codegen/fetch";

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
 * Fetch the CloudFormation Registry schema zip and extract per-resource JSON schemas.
 * Returns a Map keyed by typeName (e.g. "AWS::S3::Bucket") to raw JSON bytes.
 *
 * Uses a local cache with 24h TTL.
 */
export async function fetchSchemaZip(force = false): Promise<Map<string, Buffer>> {
  const zipData = await fetchWithCache(
    { url: SCHEMA_ZIP_URL, cacheFile: CACHE_FILE },
    force,
  );
  return extractRawSchemas(zipData);
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
