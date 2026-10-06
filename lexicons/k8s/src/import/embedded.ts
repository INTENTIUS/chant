/**
 * Where a Kubernetes manifest embeds another lexicon's content, for
 * `chant import` (#2962).
 *
 * The parser offers two kinds of place to core's embedded-content resolver:
 *
 * - every `data` value of a ConfigMap, as text (a collector's `config.yaml`,
 *   a Prometheus rule file, an `alertmanager.yml`, a Grafana dashboard's
 *   JSON);
 * - a `monitoring.coreos.com` PrometheusRule's `spec.groups`, as the rule file
 *   `{ groups }` those groups would make;
 * - an OpenTelemetry Operator `OpenTelemetryCollector`'s `spec.config` (v1beta1,
 *   a structured object), offered as `{ config, header }` with the `# chant:`
 *   header lines kept in the `otel.chant.dev/header` annotation (#3367);
 * - a Grafana Operator `GrafanaDashboard`'s `spec.json`, as text (#3015);
 * - the alerting content of the Grafana Operator's `GrafanaAlertRuleGroup`
 *   (`spec.rules`), `GrafanaContactPoint` (`spec.receivers`),
 *   `GrafanaNotificationPolicy` (`spec.route`), `GrafanaNotificationPolicyRoute`
 *   (the whole `spec`, offered as `route`), `GrafanaMuteTiming`
 *   (`spec.time_intervals`) and `GrafanaNotificationTemplate`
 *   (`spec.template`), each with the whole `spec` as the document so the
 *   owner can read the fields beside it (#3538).
 *
 * Which lexicon imports the content is decided by core at run time, from the
 * lexicons that register an `embeddedImporters()`; this module names none of
 * them as a dependency. The `expectedOwner` hints below are the conventions
 * k8s manifests follow, used only to warn when the owner is not installed.
 */

import type { EmbeddedContent, EmbeddedContentResolver } from "@intentius/chant/import/embedded";
import { embeddedDocument } from "@intentius/chant/import/embedded";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The annotation `OtelCollectorCR` keeps the collector config's `# chant:` header lines in (see OTEL_COLLECTOR_ANNOTATIONS). */
const OTEL_HEADER_ANNOTATION = "otel.chant.dev/header";

/** The `grafana_dashboard` label the Grafana dashboard sidecar looks for (kube-prometheus-stack, the Grafana Helm chart). */
export const GRAFANA_DASHBOARD_LABEL = "grafana_dashboard";

/** The Grafana Operator alerting kinds, and the `spec` field holding what the grafana lexicon imports. */
const GRAFANA_ALERTING_FIELDS: Record<string, { field: string; what: string }> = {
  "K8s::Grafana::GrafanaAlertRuleGroup": { field: "rules", what: "Grafana alert rules" },
  "K8s::Grafana::GrafanaContactPoint": { field: "receivers", what: "Grafana contact point receivers" },
  "K8s::Grafana::GrafanaNotificationPolicy": { field: "route", what: "a Grafana notification policy" },
  "K8s::Grafana::GrafanaMuteTiming": { field: "time_intervals", what: "Grafana mute timing intervals" },
  "K8s::Grafana::GrafanaNotificationTemplate": { field: "template", what: "a Grafana notification template" },
};

function looksLikeRuleGroups(groups: unknown): boolean {
  return Array.isArray(groups) && groups.length > 0 && groups.every((g) => isObject(g) && typeof g.name === "string" && Array.isArray(g.rules));
}

/** Whose content a ConfigMap value looks like, by the conventions manifests follow. */
function hintFor(key: string, doc: unknown, labels: Record<string, string>): EmbeddedContent["expectedOwner"] {
  if (!isObject(doc)) return undefined;
  if (Array.isArray(doc.panels) && (GRAFANA_DASHBOARD_LABEL in labels || key.endsWith(".json"))) {
    return { lexicon: "grafana", what: "a Grafana dashboard" };
  }
  const v2Dashboard =
    (doc.kind === "Dashboard" && typeof doc.apiVersion === "string" && doc.apiVersion.startsWith("dashboard.grafana.app/")) ||
    (isObject(doc.elements) && isObject(doc.layout));
  if (v2Dashboard && (GRAFANA_DASHBOARD_LABEL in labels || key.endsWith(".json"))) {
    return { lexicon: "grafana", what: "a Grafana dashboard" };
  }
  if (isObject(doc.service) && isObject(doc.service.pipelines)) {
    return { lexicon: "otel", what: "an OpenTelemetry Collector config" };
  }
  if (looksLikeRuleGroups(doc.groups)) return { lexicon: "prometheus", what: "a Prometheus rule file" };
  if ((isObject(doc.route) || Array.isArray(doc.receivers)) && !("apiVersion" in doc) && !("kind" in doc)) {
    return { lexicon: "prometheus", what: "an Alertmanager config" };
  }
  return undefined;
}

function stringLabels(metadata: unknown): Record<string, string> {
  const labels = isObject(metadata) && isObject(metadata.labels) ? metadata.labels : {};
  return Object.fromEntries(Object.entries(labels).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/**
 * Offer the embedded content of one resource to `embedded`, replacing each
 * value an owner imports with the reference it returns. `properties` is the
 * resource's IR properties, changed in place (with fresh copies of the
 * objects on the way down).
 */
export function delegateEmbedded(
  type: string,
  kind: string,
  properties: Record<string, unknown>,
  embedded: EmbeddedContentResolver,
): void {
  const metadata = properties.metadata;
  const name = isObject(metadata) && typeof metadata.name === "string" ? metadata.name : kind.toLowerCase();
  const labels = stringLabels(metadata);

  if (type === "K8s::Core::ConfigMap" && isObject(properties.data)) {
    const keys = Object.keys(properties.data);
    const data: Record<string, unknown> = { ...properties.data };
    for (const key of keys) {
      const text = data[key];
      if (typeof text !== "string") continue;
      const doc = embeddedDocument(text);
      if (!isObject(doc)) continue;
      const ref = embedded.resolve({
        host: "k8s",
        hostType: type,
        location: `ConfigMap ${name} data[${JSON.stringify(key)}]`,
        directory: keys.length === 1 ? name : `${name}-${key.replace(/\.[^.]*$/, "")}`,
        text,
        document: doc,
        labels,
        expectedOwner: hintFor(key, doc, labels),
      });
      if (ref) data[key] = ref;
    }
    properties.data = data;
    return;
  }

  if (type === "K8s::Grafana::GrafanaDashboard" && isObject(properties.spec) && typeof properties.spec.json === "string") {
    const text = properties.spec.json;
    const doc = embeddedDocument(text);
    if (!isObject(doc)) return;
    const ref = embedded.resolve({
      host: "k8s",
      hostType: type,
      location: `GrafanaDashboard ${name} spec.json`,
      directory: name,
      text,
      document: doc,
      labels,
      expectedOwner: { lexicon: "grafana", what: "a Grafana dashboard" },
    });
    if (ref) properties.spec = { ...properties.spec, json: ref };
    return;
  }

  // A GrafanaNotificationPolicyRoute's spec is the route itself, so the whole spec is offered (as `route`) and replaced.
  if (type === "K8s::Grafana::GrafanaNotificationPolicyRoute" && isObject(properties.spec) && typeof properties.spec.receiver === "string") {
    const ref = embedded.resolve({
      host: "k8s",
      hostType: type,
      location: `${kind} ${name} spec`,
      directory: name,
      document: { route: properties.spec },
      select: "route",
      labels,
      expectedOwner: { lexicon: "grafana", what: "a Grafana notification policy route" },
    });
    if (ref) properties.spec = ref as unknown as Record<string, unknown>;
    return;
  }

  const alerting = GRAFANA_ALERTING_FIELDS[type];
  if (alerting && isObject(properties.spec) && properties.spec[alerting.field] !== undefined) {
    const spec = properties.spec;
    const ref = embedded.resolve({
      host: "k8s",
      hostType: type,
      location: `${kind} ${name} spec.${alerting.field}`,
      directory: name,
      document: spec,
      select: alerting.field,
      labels,
      expectedOwner: { lexicon: "grafana", what: alerting.what },
    });
    if (ref) properties.spec = { ...spec, [alerting.field]: ref };
    return;
  }

  // The CR holds the config as an object, so the owner is asked for an object (`select: "config"`,
  // answered with `collectorConfig([...])`) rather than for text, which would put a string where the CRD wants a map.
  if (type === "K8s::OpenTelemetry::OpenTelemetryCollector" && isObject(properties.spec) && isObject(properties.spec.config)) {
    const spec = properties.spec;
    const raw = isObject(metadata) && isObject(metadata.annotations) ? metadata.annotations[OTEL_HEADER_ANNOTATION] : undefined;
    const header = typeof raw === "string" ? raw.split("\n").filter((l) => l.length > 0) : [];
    const ref = embedded.resolve({
      host: "k8s",
      hostType: type,
      location: `OpenTelemetryCollector ${name} spec.config`,
      directory: name,
      document: { config: spec.config, header },
      select: "config",
      labels,
      expectedOwner: { lexicon: "otel", what: "an OpenTelemetry Collector config" },
    });
    if (ref) properties.spec = { ...spec, config: ref };
    return;
  }

  if (type === "K8s::Monitoring::PrometheusRule" && isObject(properties.spec) && Array.isArray(properties.spec.groups)) {
    const groups = properties.spec.groups;
    const ref = embedded.resolve({
      host: "k8s",
      hostType: type,
      location: `PrometheusRule ${name} spec.groups`,
      directory: name,
      document: { groups },
      select: "groups",
      labels,
      expectedOwner: { lexicon: "prometheus", what: "Prometheus rule groups" },
    });
    if (ref) properties.spec = { ...properties.spec, groups: ref };
  }
}
