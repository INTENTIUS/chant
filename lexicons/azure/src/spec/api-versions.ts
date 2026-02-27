/**
 * API version resolution for Azure Resource Manager schemas.
 *
 * ARM schemas are organized by API date:
 *   schemas/{date}/Microsoft.{Provider}.json
 *
 * This module picks the latest API version per provider.
 */

/**
 * Parse an API date string (e.g. "2023-01-01") into a comparable value.
 */
export function parseApiDate(dateStr: string): Date {
  return new Date(dateStr);
}

/**
 * Compare two API date strings. Returns positive if a > b.
 */
export function compareApiDates(a: string, b: string): number {
  return parseApiDate(a).getTime() - parseApiDate(b).getTime();
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
 * Given a set of schema paths, return only the latest API version per provider.
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

    const existing = best.get(parsed.provider);
    if (!existing || compareApiDates(parsed.apiVersion, existing.apiVersion) > 0) {
      best.set(parsed.provider, { path: p, apiVersion: parsed.apiVersion });
    }
  }

  return best;
}
