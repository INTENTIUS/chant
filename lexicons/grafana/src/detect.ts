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

/** A dashboard saved before Grafana 5.0: panels inside a top-level `rows` list. */
export function looksLikeLegacyRowsDashboard(data: unknown): data is Record<string, unknown> {
  return isObject(data) && !Array.isArray(data.panels) && Array.isArray(data.rows) && typeof data.schemaVersion === "number";
}

/** A dashboard as the `dashboard.grafana.app` API serves it: `apiVersion`, `kind: Dashboard` and a `spec`. */
export function looksLikeDashboardResource(data: unknown): data is { apiVersion: string; kind: "Dashboard"; spec: Record<string, unknown> } {
  return (
    isObject(data) &&
    data.kind === "Dashboard" &&
    typeof data.apiVersion === "string" &&
    data.apiVersion.startsWith("dashboard.grafana.app/") &&
    isObject(data.spec)
  );
}

/** A v2 dashboard: a `dashboard.grafana.app/v2*` resource, or a bare v2 spec (`elements` and `layout`). */
export function looksLikeV2Dashboard(data: unknown): boolean {
  if (looksLikeDashboardResource(data)) return /^dashboard\.grafana\.app\/v2/.test(data.apiVersion);
  return isObject(data) && isObject(data.elements) && isObject(data.layout);
}

/** What `GET /api/dashboards/uid/<uid>` returns: `{ dashboard, meta }`. */
export function looksLikeDashboardApiResponse(data: unknown): data is { dashboard: Record<string, unknown>; meta: unknown } {
  return isObject(data) && isObject(data.meta) && (looksLikeDashboard(data.dashboard) || looksLikeLegacyRowsDashboard(data.dashboard));
}

/** A datasource provisioning file: `apiVersion` and a `datasources` list. */
export function looksLikeDatasourceProvisioning(data: unknown): data is { apiVersion: unknown; datasources: unknown[] } {
  return isObject(data) && data.apiVersion !== undefined && Array.isArray(data.datasources);
}

/** A dashboard provisioning file: `apiVersion` and a `providers` list. */
export function looksLikeDashboardProvisioning(data: unknown): data is { apiVersion: unknown; providers: unknown[] } {
  return isObject(data) && data.apiVersion !== undefined && Array.isArray(data.providers);
}

/**
 * Template detection for `chant import` and friends: dashboard JSON in any
 * of the shapes above (v2 included, so the importer can say it does not read
 * v2 yet), or a provisioning file.
 */
export function detectTemplate(data: unknown): boolean {
  return (
    looksLikeDashboard(data) ||
    looksLikeLegacyRowsDashboard(data) ||
    looksLikeDashboardResource(data) ||
    looksLikeV2Dashboard(data) ||
    looksLikeDashboardApiResponse(data) ||
    looksLikeDatasourceProvisioning(data) ||
    looksLikeDashboardProvisioning(data)
  );
}
