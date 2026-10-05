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

/** A datasource provisioning file: `apiVersion` and a `datasources` or `deleteDatasources` list. */
export function looksLikeDatasourceProvisioning(data: unknown): data is { apiVersion: unknown; datasources?: unknown[]; deleteDatasources?: unknown[]; prune?: unknown } {
  return isObject(data) && data.apiVersion !== undefined && (Array.isArray(data.datasources) || Array.isArray(data.deleteDatasources));
}

/** A dashboard provisioning file: `apiVersion` and a `providers` list. */
export function looksLikeDashboardProvisioning(data: unknown): data is { apiVersion: unknown; providers: unknown[] } {
  return isObject(data) && data.apiVersion !== undefined && Array.isArray(data.providers);
}

/** The lists an alerting provisioning file holds (Grafana's `AlertingFileV1`). */
const ALERTING_LISTS = [
  "groups",
  "deleteRules",
  "contactPoints",
  "deleteContactPoints",
  "policies",
  "resetPolicies",
  "muteTimes",
  "deleteMuteTimes",
  "templates",
  "deleteTemplates",
] as const;

/** A Grafana-managed rule group: a `folder`, or rules with `data` (queries), which a Prometheus rule group never has. */
function looksLikeGrafanaRuleGroup(g: unknown): boolean {
  if (!isObject(g)) return false;
  if (typeof g.folder === "string") return true;
  return Array.isArray(g.rules) && g.rules.some((r) => isObject(r) && Array.isArray(r.data));
}

/**
 * An alerting provisioning file (`provisioning/alerting/*.yaml`, or what
 * `/api/v1/provisioning/*\/export` writes): at least one of the alerting
 * lists at the top level and nothing but those and `apiVersion`. A `groups`
 * list must hold Grafana rule groups, so a Prometheus rule file (`groups:`
 * of `name` and `rules` with `expr`) is not mistaken for one.
 */
export function looksLikeAlertingProvisioning(data: unknown): data is Record<string, unknown> {
  if (!isObject(data)) return false;
  const keys = Object.keys(data);
  if (!keys.some((k) => (ALERTING_LISTS as readonly string[]).includes(k) && Array.isArray(data[k]))) return false;
  if (!keys.every((k) => k === "apiVersion" || (ALERTING_LISTS as readonly string[]).includes(k))) return false;
  if (Array.isArray(data.groups) && data.groups.length > 0 && !data.groups.every(looksLikeGrafanaRuleGroup)) return false;
  return data.apiVersion !== undefined || Array.isArray(data.groups);
}

/**
 * The `spec` of a Grafana Operator alerting resource (`GrafanaAlertRuleGroup`,
 * `GrafanaContactPoint`, `GrafanaNotificationPolicy`, `GrafanaMuteTiming`,
 * `GrafanaNotificationTemplate`) as the k8s importer offers it (#3538): every
 * operator resource's spec has an `instanceSelector`, beside the field that
 * holds the alerting content.
 */
export function looksLikeOperatorAlertingSpec(data: unknown): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.instanceSelector !== "object" || d.instanceSelector === null) return false;
  return (
    (typeof d.name === "string" && Array.isArray(d.rules)) ||
    (typeof d.name === "string" && Array.isArray(d.receivers)) ||
    (typeof d.route === "object" && d.route !== null) ||
    (typeof d.name === "string" && Array.isArray(d.time_intervals)) ||
    (typeof d.name === "string" && typeof d.template === "string")
  );
}

/**
 * Template detection for `chant import` and friends: dashboard JSON in any
 * of the shapes above (v2 included, #2947), or a datasource, dashboard or
 * alerting provisioning file.
 */
export function detectTemplate(data: unknown): boolean {
  return (
    looksLikeOperatorAlertingSpec(data) ||
    looksLikeDashboard(data) ||
    looksLikeLegacyRowsDashboard(data) ||
    looksLikeDashboardResource(data) ||
    looksLikeV2Dashboard(data) ||
    looksLikeDashboardApiResponse(data) ||
    looksLikeDatasourceProvisioning(data) ||
    looksLikeDashboardProvisioning(data) ||
    looksLikeAlertingProvisioning(data)
  );
}
