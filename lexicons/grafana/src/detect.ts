/**
 * What a parsed Grafana document looks like. Kept free of the plugin and the
 * TypeScript compiler so it bundles for edge runtimes, like the other
 * lexicons' `detect` modules.
 */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Dashboard JSON: a `panels` array plus a `schemaVersion` or a `templating` block. */
export function looksLikeDashboard(data: unknown): data is Record<string, unknown> {
  if (!isObject(data)) return false;
  return Array.isArray(data.panels) && (typeof data.schemaVersion === "number" || isObject(data.templating));
}

/** A datasource provisioning file: `apiVersion` and a `datasources` list. */
export function looksLikeDatasourceProvisioning(data: unknown): data is { apiVersion: unknown; datasources: unknown[] } {
  return isObject(data) && data.apiVersion !== undefined && Array.isArray(data.datasources);
}

/** A dashboard provisioning file: `apiVersion` and a `providers` list. */
export function looksLikeDashboardProvisioning(data: unknown): data is { apiVersion: unknown; providers: unknown[] } {
  return isObject(data) && data.apiVersion !== undefined && Array.isArray(data.providers);
}

/** Template detection for `chant import` and friends: any of the three. */
export function detectTemplate(data: unknown): boolean {
  return looksLikeDashboard(data) || looksLikeDatasourceProvisioning(data) || looksLikeDashboardProvisioning(data);
}
