/**
 * ARM deployment-scope metadata (#1545).
 *
 * The generated lexicon records `deployScopes` for resources that exist
 * somewhere other than plain resource-group scope (management groups,
 * subscription aliases, policy definitions). This module loads that map and
 * resolves which deployment scope a template targets, shared by the
 * serializer (picks the template $schema) and AZR030 (flags resources
 * emitted at a scope their schema does not define).
 *
 * Lazy-loaded and cached for the lifetime of the process.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export type DeployScope = "resourceGroup" | "subscription" | "managementGroup" | "tenant";

/** Template $schema URL per deployment scope. */
export const TEMPLATE_SCHEMAS: Record<DeployScope, string> = {
  resourceGroup: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  subscription: "https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#",
  managementGroup: "https://schema.management.azure.com/schemas/2019-08-01/managementGroupDeploymentTemplate.json#",
  tenant: "https://schema.management.azure.com/schemas/2019-08-01/tenantDeploymentTemplate.json#",
};

const RESOURCE_GROUP_ONLY: DeployScope[] = ["resourceGroup"];

interface LexiconEntry {
  kind: string;
  resourceType: string;
  deployScopes?: DeployScope[];
  [key: string]: unknown;
}

let _cached: Map<string, DeployScope[]> | undefined;

const __dirname_ = dirname(fileURLToPath(import.meta.url));

/**
 * Load per-resource deployment scopes from the lexicon JSON.
 * Only resources with a non-default scope set appear; everything else is
 * plain resource-group scope. Result is cached after first call.
 */
export function loadDeployScopes(): Map<string, DeployScope[]> {
  if (_cached) return _cached;

  const map = new Map<string, DeployScope[]>();
  try {
    let content: string | undefined;
    // Try generated/ (dev) first, then dist/meta.json (installed package)
    for (const candidate of [
      join(__dirname_, "generated", "lexicon-azure.json"),
      join(__dirname_, "..", "dist", "meta.json"),
    ]) {
      try { content = readFileSync(candidate, "utf-8"); break; } catch {}
    }
    if (content) {
      const data = JSON.parse(content) as Record<string, LexiconEntry>;
      for (const entry of Object.values(data)) {
        if (entry.kind === "resource" && entry.resourceType && entry.deployScopes?.length) {
          map.set(entry.resourceType, entry.deployScopes);
        }
      }
    }
  } catch {
    // Lexicon not available — every resource reads as resource-group scope
  }

  _cached = map;
  return map;
}

/** Deployment scopes for one ARM resource type (defaults to resource group). */
export function deployScopesFor(resourceType: string): DeployScope[] {
  return loadDeployScopes().get(resourceType) ?? RESOURCE_GROUP_ONLY;
}

/**
 * Resolve the deployment scope for a template containing the given resource
 * types: the scopes every resource supports, intersected.
 *
 * Resource-group scope wins whenever the intersection allows it (the
 * pre-#1545 behavior for every template that could already be emitted).
 * Otherwise the scope closest to a resource group is chosen. An empty
 * intersection has no valid single-template answer; resource-group scope is
 * returned and AZR030 reports the resources that cannot deploy there.
 */
export function resolveTemplateScope(resourceTypes: Iterable<string>): DeployScope {
  let candidates: Set<DeployScope> | undefined;
  for (const type of resourceTypes) {
    const scopes = deployScopesFor(type);
    if (!candidates) {
      candidates = new Set(scopes);
    } else {
      for (const scope of [...candidates]) {
        if (!scopes.includes(scope)) candidates.delete(scope);
      }
    }
  }
  if (!candidates || candidates.size === 0) return "resourceGroup";
  for (const scope of ["resourceGroup", "subscription", "managementGroup", "tenant"] as DeployScope[]) {
    if (candidates.has(scope)) return scope;
  }
  return "resourceGroup";
}

/** Map a template $schema URL back to its deployment scope. */
export function scopeForTemplateSchema(schema: unknown): DeployScope {
  if (typeof schema === "string") {
    if (schema.includes("subscriptionDeploymentTemplate")) return "subscription";
    if (schema.includes("managementGroupDeploymentTemplate")) return "managementGroup";
    if (schema.includes("tenantDeploymentTemplate")) return "tenant";
  }
  return "resourceGroup";
}
