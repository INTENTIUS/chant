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
 *
 * Microsoft.Compute has the same issue (#1144): at the schema commit pinned
 * in ../spec/fetch.ts, the newest dated `Microsoft.Compute.json` (2026-03-02)
 * is a narrow disk-only delta that drops `virtualMachines`,
 * `virtualMachineScaleSets`, and `availabilitySets` entirely — not a rename,
 * an omission, since Azure alternates between a "VM flavor" and a "disk
 * flavor" of this file across dates rather than publishing one cumulative
 * file. 2026-03-01 is the most recent date that still has the VM family
 * (validate.ts's REQUIRED_NAMES and composites/vm-linux.ts depend on it);
 * it drops the disk-only resources (disks, diskAccesses, diskEncryptionSets,
 * snapshots), which nothing here currently references.
 *
 * A pin can list several versions (#1545): Azure publishes some providers as
 * per-family deltas, so no single date carries every resource we need. The
 * files merge in the order listed — the first file that defines a resource
 * name wins, later files only contribute resources not yet seen.
 * Microsoft.Authorization needs three: 2022-04-01 for roleAssignments /
 * roleDefinitions (#223), 2026-06-01 (latest stable policy file) for
 * policyAssignments / policyDefinitions / policySetDefinitions and their
 * _versions children, and 2022-07-01-preview for policyExemptions, which has
 * no GA date and whose newer preview files (2024-12-01-preview and later)
 * drag in policy variables we don't want yet.
 *
 * Microsoft.Management and Microsoft.Subscription are pinned to their latest
 * GA dates: the naive latest for both is a preview (2024-02-01-preview adds
 * serviceGroups; 2025-11-01-preview adds changeTenantRequest), and the
 * management-group hierarchy should not author against preview apiVersions.
 */
export const PROVIDER_VERSION_OVERRIDES: Record<string, readonly string[]> = {
  "Microsoft.Authorization": ["2022-04-01", "2026-06-01", "2022-07-01-preview"],
  "Microsoft.Compute": ["2026-03-01"],
  "Microsoft.Management": ["2023-04-01"],
  "Microsoft.Subscription": ["2021-10-01"],
};

/**
 * Given a set of schema paths, return the schema files to generate from, per
 * provider: the single latest API version, unless
 * {@link PROVIDER_VERSION_OVERRIDES} pins the provider to one or more chosen
 * versions (used where "latest" drops resources we depend on). For pinned
 * providers the array preserves the pin order — callers merge the files
 * first-wins per resource name.
 *
 * Returns a Map of provider → [{ path, apiVersion }, ...].
 */
export function latestVersionPerProvider(
  paths: string[],
): Map<string, Array<{ path: string; apiVersion: string }>> {
  const best = new Map<string, Array<{ path: string; apiVersion: string }>>();

  for (const p of paths) {
    const parsed = parseSchemaPath(p);
    if (!parsed) continue;

    const pinned = PROVIDER_VERSION_OVERRIDES[parsed.provider];
    if (pinned) {
      // Only accept the pinned versions for an overridden provider,
      // slotted into pin order.
      if (pinned.includes(parsed.apiVersion)) {
        const files = best.get(parsed.provider) ?? [];
        files.push({ path: p, apiVersion: parsed.apiVersion });
        files.sort((a, b) => pinned.indexOf(a.apiVersion) - pinned.indexOf(b.apiVersion));
        best.set(parsed.provider, files);
      }
      continue;
    }

    const existing = best.get(parsed.provider);
    if (!existing || compareApiDates(parsed.apiVersion, existing[0].apiVersion) > 0) {
      best.set(parsed.provider, [{ path: p, apiVersion: parsed.apiVersion }]);
    }
  }

  return best;
}
