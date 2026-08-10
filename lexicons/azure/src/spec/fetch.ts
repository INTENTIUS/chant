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
 *
 * Besides the resource-group-scope `resourceDefinitions`, provider files
 * carry parallel sections for the other deployment scopes. Org-hierarchy and
 * policy resources (management groups, subscription aliases, policy
 * definitions) exist ONLY in those sections (#1545).
 */
export interface ArmProviderSchema {
  id?: string;
  $schema?: string;
  title?: string;
  description?: string;
  resourceDefinitions?: Record<string, ArmResourceDefinition>;
  subscription_resourceDefinitions?: Record<string, ArmResourceDefinition>;
  managementGroup_resourceDefinitions?: Record<string, ArmResourceDefinition>;
  tenant_resourceDefinitions?: Record<string, ArmResourceDefinition>;
  definitions?: Record<string, ArmSchemaDefinition>;
}

/** ARM deployment scopes a resource definition can target. */
export type DeployScope = "resourceGroup" | "subscription" | "managementGroup" | "tenant";

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

/**
 * Pinned commit of Azure/azure-resource-manager-schemas (#1144).
 *
 * The repo has no tagged releases, so unlike gcp (`KCC_VERSION`) or k8s
 * (`K8S_SCHEMA_VERSION`) there is no version tag to pin against — codegen
 * used to fetch `refs/heads/main` directly. That meant a cold cache picked
 * up whatever upstream state had landed since the cache last expired, while
 * a warm cache kept serving whatever was current when it was last filled.
 * Azure republishes per-provider schema files under new dates constantly,
 * and a later date can drop resources an earlier one defined (see
 * PROVIDER_VERSION_OVERRIDES in ./api-versions.ts) — so which resources
 * even exist to generate depends on exactly when you fetch, not just what
 * the fetch URL happens to be. That broke composites/vm-linux.ts at tsc
 * nondeterministically, depending on which runner's cache was warm.
 *
 * Pinning to a commit SHA makes generation reproducible regardless of cache
 * state. Bump policy: #523's scheduled lexicon-upgrade cron (rolling-spec
 * bucket, sub-issue #526) is meant to propose bumps to this constant as a
 * reviewable PR once built. Until then, bump by hand: take the current
 * `main` HEAD sha from
 * https://github.com/Azure/azure-resource-manager-schemas/commits/main,
 * regenerate, fix up any composite left referencing a renamed or vanished
 * export (adding a PROVIDER_VERSION_OVERRIDES entry if a resource dropped
 * out of the naive "latest by date" pick), and update this constant +
 * comment.
 */
export const AZURE_SCHEMA_COMMIT = "0085cb6f3a98e735359807143bcb1667aeec930f";

const TARBALL_URL = `https://github.com/Azure/azure-resource-manager-schemas/archive/${AZURE_SCHEMA_COMMIT}.tar.gz`;
const CACHE_DIR = join(homedir(), ".chant");
// The cache filename embeds the pin so a stale tarball from before a bump
// can never mask the bump: restoring an old ~/.chant (e.g. a CI cache
// partial-key fallback, or a developer's pre-existing cache) simply misses
// this filename and re-downloads, instead of silently serving pre-bump
// schemas under a name that still matches (#1144).
const CACHE_FILE = join(CACHE_DIR, `azure-resource-manager-schemas-${AZURE_SCHEMA_COMMIT}.tar.gz`);

/** Paths to skip (common-types, non-provider files). */
function isProviderSchema(path: string): boolean {
  if (path.includes("common-types/")) return false;
  if (path.includes("test/")) return false;
  if (!path.includes("/schemas/")) return false;
  // Must match schemas/{date}/Microsoft.*.json
  return /schemas\/\d{4}-\d{2}-\d{2}(?:-preview)?\/Microsoft\.[^/]+\.json$/.test(path);
}

/**
 * Normalize schema-file provider name to canonical ARM provider.
 * "Microsoft.Network.NRP" → "Microsoft.Network"
 * "Microsoft.Sql.Legacy"  → "Microsoft.Sql"
 * "Microsoft.Compute"     → "Microsoft.Compute" (unchanged)
 */
function normalizeProvider(fileProvider: string): string {
  const parts = fileProvider.split(".");
  // Microsoft.X.Y... → Microsoft.X
  return parts.length > 2 ? `${parts[0]}.${parts[1]}` : fileProvider;
}

/**
 * Providers whose scope-specific resource definition sections are read in
 * addition to `resourceDefinitions` (#1545).
 *
 * Deliberately an allowlist: reading the scoped sections for every provider
 * would pull hundreds of subscription/tenant-scope resources into the
 * generated surface at once (and back into tsc time — see the #438 bounding
 * story). Only the org-hierarchy and policy providers need them today; grow
 * this set intentionally, checking generated size and azure tsc time after.
 */
const SCOPED_SECTION_PROVIDERS = new Set([
  "Microsoft.Management",
  "Microsoft.Subscription",
  "Microsoft.Authorization",
]);

/** Scope sections of a provider file, in definition-priority order. */
const SCOPE_SECTIONS: Array<{ key: keyof ArmProviderSchema; scope: DeployScope }> = [
  { key: "resourceDefinitions", scope: "resourceGroup" },
  { key: "subscription_resourceDefinitions", scope: "subscription" },
  { key: "managementGroup_resourceDefinitions", scope: "managementGroup" },
  { key: "tenant_resourceDefinitions", scope: "tenant" },
];

/**
 * Explode one provider schema file into per-resource schema entries,
 * writing into `out` keyed by resource type. Resource types already present
 * in `out` are left untouched (first file wins across a multi-version pin).
 *
 * For providers in {@link SCOPED_SECTION_PROVIDERS} all deployment-scope
 * sections are read; the definition comes from the highest-priority section
 * that has it, and `deployScopes` unions every section that defines it.
 */
export function explodeProviderSchema(
  provider: string,
  apiVersion: string,
  providerSchema: ArmProviderSchema,
  out: Map<string, Buffer>,
): void {
  const definitions = providerSchema.definitions ?? {};
  const sections = SCOPED_SECTION_PROVIDERS.has(normalizeProvider(provider))
    ? SCOPE_SECTIONS
    : SCOPE_SECTIONS.slice(0, 1);

  // Gather each resource name's definition (highest-priority section wins)
  // and the union of scopes that define it.
  const byName = new Map<string, { def: ArmResourceDefinition; scopes: DeployScope[] }>();
  for (const { key, scope } of sections) {
    const defs = providerSchema[key] as Record<string, ArmResourceDefinition> | undefined;
    if (!defs) continue;
    for (const [resourceName, resourceDef] of Object.entries(defs)) {
      const existing = byName.get(resourceName);
      if (existing) {
        existing.scopes.push(scope);
      } else {
        byName.set(resourceName, { def: resourceDef, scopes: [scope] });
      }
    }
  }

  for (const [resourceName, { def, scopes }] of byName) {
    const resourceType = `${normalizeProvider(provider)}/${resourceName}`;
    if (out.has(resourceType)) continue;

    // Build a per-resource schema that includes the resource def + shared definitions + apiVersion
    const perResourceSchema = {
      resourceType,
      apiVersion,
      provider,
      resourceName,
      deployScopes: scopes,
      resourceDefinition: def,
      definitions,
    };

    out.set(resourceType, Buffer.from(JSON.stringify(perResourceSchema)));
  }
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

  // Deduplicate: keep only the latest API version per provider, or the pinned
  // versions (in pin order) for providers in PROVIDER_VERSION_OVERRIDES.
  const paths = [...allFiles.keys()];
  const selected = latestVersionPerProvider(paths);

  // Explode: one provider file has N resourceDefinitions → emit N entries.
  // With a multi-version pin the first file that defines a resource wins.
  const schemas = new Map<string, Buffer>();

  for (const [provider, files] of selected) {
    // First-wins applies within one provider's pin list; across providers the
    // pre-#1545 behavior is kept (a later provider file may overwrite a
    // normalized-name collision, e.g. Microsoft.Sql.Legacy vs Microsoft.Sql).
    const providerSchemas = new Map<string, Buffer>();
    for (const { path, apiVersion } of files) {
      const data = allFiles.get(path);
      if (!data) continue;

      try {
        const providerSchema: ArmProviderSchema = JSON.parse(data.toString("utf-8"));
        explodeProviderSchema(provider, apiVersion, providerSchema, providerSchemas);
      } catch {
        // Skip files that can't be parsed
      }
    }
    for (const [resourceType, buf] of providerSchemas) {
      schemas.set(resourceType, buf);
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
