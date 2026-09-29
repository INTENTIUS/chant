/**
 * Where a Kubernetes manifest embeds another lexicon's content, for
 * `chant import` (#2962).
 *
 * The parser offers two kinds of place to core's embedded-content resolver:
 *
 * - every `data` value of a ConfigMap, as text (a collector's `config.yaml`,
 *   a Prometheus rule file, a Grafana dashboard's JSON);
 * - a `monitoring.coreos.com` PrometheusRule's `spec.groups`, as the rule file
 *   `{ groups }` those groups would make.
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

/** The `grafana_dashboard` label the Grafana dashboard sidecar looks for (kube-prometheus-stack, the Grafana Helm chart). */
export const GRAFANA_DASHBOARD_LABEL = "grafana_dashboard";

function looksLikeRuleGroups(groups: unknown): boolean {
  return Array.isArray(groups) && groups.length > 0 && groups.every((g) => isObject(g) && typeof g.name === "string" && Array.isArray(g.rules));
}

/** Whose content a ConfigMap value looks like, by the conventions manifests follow. */
function hintFor(key: string, doc: unknown, labels: Record<string, string>): EmbeddedContent["expectedOwner"] {
  if (!isObject(doc)) return undefined;
  if (Array.isArray(doc.panels) && (GRAFANA_DASHBOARD_LABEL in labels || key.endsWith(".json"))) {
    return { lexicon: "grafana", what: "a Grafana dashboard" };
  }
  if (isObject(doc.service) && isObject(doc.service.pipelines)) {
    return { lexicon: "otel", what: "an OpenTelemetry Collector config" };
  }
  if (looksLikeRuleGroups(doc.groups)) return { lexicon: "prometheus", what: "a Prometheus rule file" };
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
