/**
 * What Grafana adds to a dashboard model when it stores one, so a test can
 * compare the model `GET /api/dashboards/uid/:uid` hands back with the JSON
 * chant built.
 *
 * Measured against grafana/grafana 12.4.11 and 13.2.2, for dashboards
 * provisioned from files and for dashboards saved through
 * `POST /api/dashboards/db`: the stored model is the built JSON plus the
 * two top-level keys below, and nothing else. In particular Grafana stores
 * no built-in "Annotations & Alerts" entry, no panel or field-config
 * defaults, and no schemaVersion migration for a model already at the
 * current schemaVersion; the frontend adds those when it opens the
 * dashboard, and they never reach the stored model. So nothing else is
 * normalized: any other difference is a real one.
 */

/** Each key Grafana adds to the stored model, and why it is not a difference. */
export const GRAFANA_INJECTED: ReadonlyArray<{ key: string; reason: string }> = [
  { key: "id", reason: "Grafana's database id for the dashboard, assigned on first store; chant never sets it." },
  { key: "version", reason: "Grafana's save counter, 1 on first store and bumped on every save; chant never sets it." },
];

/** The stored model with Grafana's own keys taken out. */
export function withoutInjected(stored: Record<string, unknown>): Record<string, unknown> {
  const out = { ...stored };
  for (const { key } of GRAFANA_INJECTED) delete out[key];
  return out;
}
