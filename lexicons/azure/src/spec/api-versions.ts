/**
 * API version resolution for Azure Resource Manager schemas.
 *
 * ARM schemas are organized by API date:
 *   schemas/{date}/Microsoft.{Provider}.json
 *
 * This module picks the latest API version per provider.
 */

/**
 * Parse an API date string (e.g. "2023-01-01" or "2023-01-01-preview").
 * Returns a numeric value for comparison: date timestamp with preview
 * versions ranked below their GA counterpart.
 */
export function parseApiDate(dateStr: string): number {
  const isPreview = dateStr.endsWith("-preview");
  const cleaned = isPreview ? dateStr.replace(/-preview$/, "") : dateStr;
  const ts = new Date(cleaned).getTime();
  // Preview versions sort just below their GA date
  return isPreview ? ts - 1 : ts;
}

/**
 * Compare two API date strings. Returns positive if a > b.
 */
export function compareApiDates(a: string, b: string): number {
  return parseApiDate(a) - parseApiDate(b);
}

/**
 * Extract provider name and API version from a schema file path.
 *
 * Input:  "azure-resource-manager-schemas-main/schemas/2023-01-01/Microsoft.Storage.json"
 * Output: { provider: "Microsoft.Storage", apiVersion: "2023-01-01" }
 */
export function parseSchemaPath(
  path: string,
): { provider: string; apiVersion: string } | null {
  // Match schemas/{date}/Microsoft.{Provider}.json
  const match = path.match(
    /schemas\/(\d{4}-\d{2}-\d{2}(?:-preview)?)\/(Microsoft\.[^/]+)\.json$/,
  );
  if (!match) return null;
  return { apiVersion: match[1], provider: match[2] };
}

/**
 * Per-provider API-version pins.
 *
 * `latestVersionPerProvider` picks the single newest version per provider, but
 * Azure spreads resources across versions — a newer version can DROP a resource
 * an older one defined. Microsoft.Authorization's latest preview no longer
 * includes the plain `roleAssignments` / `roleDefinitions` resources; they live
 * in 2022-04-01, the latest stable that still has them. Pin it so those
 * generate (the naming table maps both). See #223.
 */
export const PROVIDER_VERSION_OVERRIDES: Record<string, string> = {
  "Microsoft.Authorization": "2022-04-01",
};

/**
 * Given a set of schema paths, return only the latest API version per provider,
 * with {@link PROVIDER_VERSION_OVERRIDES} pinning specific providers to a chosen
 * version (used where "latest" drops resources we depend on).
 *
 * Returns a Map of provider → { path, apiVersion }.
 */
export function latestVersionPerProvider(
  paths: string[],
): Map<string, { path: string; apiVersion: string }> {
  const best = new Map<string, { path: string; apiVersion: string }>();

  for (const p of paths) {
    const parsed = parseSchemaPath(p);
    if (!parsed) continue;

    const pinned = PROVIDER_VERSION_OVERRIDES[parsed.provider];
    if (pinned) {
      // Only accept the pinned version for an overridden provider.
      if (parsed.apiVersion === pinned) {
        best.set(parsed.provider, { path: p, apiVersion: parsed.apiVersion });
      }
      continue;
    }

    const existing = best.get(parsed.provider);
    if (!existing || compareApiDates(parsed.apiVersion, existing.apiVersion) > 0) {
      best.set(parsed.provider, { path: p, apiVersion: parsed.apiVersion });
    }
  }

  return best;
}
