/**
 * Azure Resource Manager schema fetching.
 *
 * Downloads the azure-resource-manager-schemas repo tarball,
 * extracts provider JSON schemas, deduplicates by latest API version,
 * and "explodes" multi-resource files into one entry per resource.
 */

import { homedir } from "os";
import { join } from "path";
import { fetchWithCache, extractFromTar, clearCacheFile } from "@intentius/chant/codegen/fetch";
import { latestVersionPerProvider } from "./api-versions";

/**
 * Top-level ARM JSON Schema for a provider file.
 */
export interface ArmProviderSchema {
  id?: string;
  $schema?: string;
  title?: string;
  description?: string;
  resourceDefinitions?: Record<string, ArmResourceDefinition>;
  definitions?: Record<string, ArmSchemaDefinition>;
}

/**
 * A single resource definition within a provider schema.
 */
export interface ArmResourceDefinition {
  type?: string;
  description?: string;
  properties?: Record<string, ArmSchemaProperty>;
  required?: string[];
}

/**
 * A property in an ARM schema.
 */
export interface ArmSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: string[];
  $ref?: string;
  items?: ArmSchemaProperty;
  properties?: Record<string, ArmSchemaProperty>;
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
  readOnly?: boolean;
}

/**
 * A named type within the definitions section.
 */
export interface ArmSchemaDefinition {
  type?: string | string[];
  description?: string;
  enum?: string[];
  properties?: Record<string, ArmSchemaProperty>;
  required?: string[];
  items?: ArmSchemaProperty;
}

const TARBALL_URL =
  "https://github.com/Azure/azure-resource-manager-schemas/archive/refs/heads/main.tar.gz";
const CACHE_DIR = join(homedir(), ".chant");
const CACHE_FILE = join(CACHE_DIR, "azure-resource-manager-schemas.tar.gz");

/** Paths to skip (common-types, non-provider files). */
function isProviderSchema(path: string): boolean {
  if (path.includes("common-types/")) return false;
  if (path.includes("test/")) return false;
  if (!path.includes("/schemas/")) return false;
  // Must match schemas/{date}/Microsoft.*.json
  return /schemas\/\d{4}-\d{2}-\d{2}(?:-preview)?\/Microsoft\.[^/]+\.json$/.test(path);
}

/**
 * Fetch ARM schemas and return a Map keyed by resource type
 * (e.g. "Microsoft.Storage/storageAccounts") to raw JSON bytes.
 *
 * Each provider file is "exploded" so that every resourceDefinition
 * becomes its own entry with the shared definitions included.
 */
export async function fetchArmSchemas(force = false): Promise<Map<string, Buffer>> {
  const tarGz = await fetchWithCache(
    { url: TARBALL_URL, cacheFile: CACHE_FILE },
    force,
  );

  // Gunzip
  const { gunzipSync } = await import("fflate");
  const tarData = gunzipSync(new Uint8Array(tarGz));

  // Extract all provider schema files
  const allFiles = extractFromTar(tarData, isProviderSchema);

  // Deduplicate: keep only latest API version per provider
  const paths = [...allFiles.keys()];
  const latest = latestVersionPerProvider(paths);

  // Explode: one provider file has N resourceDefinitions → emit N entries
  const schemas = new Map<string, Buffer>();

  for (const [provider, { path, apiVersion }] of latest) {
    const data = allFiles.get(path);
    if (!data) continue;

    try {
      const providerSchema: ArmProviderSchema = JSON.parse(data.toString("utf-8"));
      const definitions = providerSchema.definitions ?? {};
      const resourceDefs = providerSchema.resourceDefinitions ?? {};

      for (const [resourceName, resourceDef] of Object.entries(resourceDefs)) {
        const resourceType = `${provider}/${resourceName}`;

        // Build a per-resource schema that includes the resource def + shared definitions + apiVersion
        const perResourceSchema = {
          resourceType,
          apiVersion,
          provider,
          resourceName,
          resourceDefinition: resourceDef,
          definitions,
        };

        schemas.set(resourceType, Buffer.from(JSON.stringify(perResourceSchema)));
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  return schemas;
}

/**
 * Get the cache file path (for testing).
 */
export function getCachePath(): string {
  return CACHE_FILE;
}

/**
 * Clear the cache (for testing).
 */
export function clearCache(): void {
  clearCacheFile(CACHE_FILE);
}
