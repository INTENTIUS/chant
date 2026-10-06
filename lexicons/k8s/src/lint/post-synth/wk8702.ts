/**
 * WK8702: a ServiceMonitor, PodMonitor, Probe or ScrapeConfig that no Prometheus or PrometheusAgent selects
 *
 * A Prometheus or PrometheusAgent scrapes the monitors whose labels match its `serviceMonitorSelector`,
 * `podMonitorSelector`, `probeSelector` or `scrapeConfigSelector`, in the namespaces the matching
 * `*NamespaceSelector` picks. A monitor none selects is accepted and then never scraped.
 *
 * Selection is worked out from the manifests in one build root (chant #1939),
 * by the operator's rules: a null object selector matches nothing, `{}`
 * matches all; a null namespace selector matches only the selecting resource's
 * own namespace, `{}` every namespace. Silent when the build has no Prometheus or PrometheusAgent, since the
 * stack is often installed separately. A selector on a namespace label the
 * build cannot read (the Namespace is not declared in it) counts as selecting.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { describe, monitoringKind, nameOf, selectionContext, unselected } from "./monitoring-selection-helpers";

export const wk8702: PostSynthCheck = {
  id: "WK8702",
  description:
    "A ServiceMonitor, PodMonitor, Probe or ScrapeConfig that no Prometheus or PrometheusAgent in the build selects is never scraped. A null selector matches nothing, {} matches all. Silent when the build has no Prometheus or PrometheusAgent.",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const sc = selectionContext(ctx);
    const selectors = [...monitoringKind(sc.manifests, "Prometheus"), ...monitoringKind(sc.manifests, "PrometheusAgent")];
    const out: PostSynthDiagnostic[] = [];
    for (const [kind, prefix] of [["ServiceMonitor", "serviceMonitor"], ["PodMonitor", "podMonitor"], ["Probe", "probe"], ["ScrapeConfig", "scrapeConfig"]] as const) {
      for (const m of unselected(sc, monitoringKind(sc.manifests, kind), selectors, () => [`${prefix}Selector`, `${prefix}NamespaceSelector`])) {
        out.push({
          checkId: "WK8702",
          severity: "warning",
          message:
            `${describe(m)} is selected by no Prometheus or PrometheusAgent in this build, so it is never scraped. ` +
            `Match its labels (and namespace) with ${prefix}Selector and ${prefix}NamespaceSelector: null selects nothing, {} selects all.`,
          entity: nameOf(m),
          lexicon: "k8s",
        });
      }
    }
    return out;
  },
};
