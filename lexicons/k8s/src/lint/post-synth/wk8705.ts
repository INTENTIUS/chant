/**
 * WK8705: a Prometheus whose four monitor selectors are all null
 *
 * A Prometheus picks the ServiceMonitors, PodMonitors, Probes and
 * ScrapeConfigs to scrape with `serviceMonitorSelector`, `podMonitorSelector`,
 * `probeSelector` and `scrapeConfigSelector`. A null selector (absent counts
 * as null) matches nothing, so a Prometheus with all four null selects no
 * monitor at all and scrapes only what `additionalScrapeConfigs` and its own
 * config hold. `{}` matches every monitor in the selected namespaces. This is
 * the usual way a fresh Prometheus ends up scraping nothing.
 *
 * A Prometheus with `additionalScrapeConfigs` set still reports: that
 * is a deliberate setup the finding names, not one it hides. The message says
 * so, and a suppression is the way to accept it.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { describe, monitoringKind, nameOf, selectionContext } from "./monitoring-selection-helpers";

const SELECTORS = ["serviceMonitorSelector", "podMonitorSelector", "probeSelector", "scrapeConfigSelector"] as const;

export const wk8705: PostSynthCheck = {
  id: "WK8705",
  description:
    "A Prometheus whose serviceMonitorSelector, podMonitorSelector, probeSelector and scrapeConfigSelector are all null selects no monitor, so the operator scrapes nothing from ServiceMonitors, PodMonitors, Probes or ScrapeConfigs.",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const { manifests } = selectionContext(ctx);
    return monitoringKind(manifests, "Prometheus")
      .filter((p) => {
        const spec = (p.spec ?? {}) as Record<string, unknown>;
        return SELECTORS.every((k) => spec[k] === null || spec[k] === undefined);
      })
      .map((p) => ({
        checkId: "WK8705",
        severity: "warning" as const,
        message:
          `${describe(p)} has ${SELECTORS.join(", ")} all null, so it selects no ServiceMonitor, PodMonitor, Probe or ScrapeConfig and scrapes only its own config` +
          `${(p.spec as Record<string, unknown> | undefined)?.additionalScrapeConfigs ? " and additionalScrapeConfigs" : ""}. ` +
          `Set the selector for each monitor kind it should pick up ({} selects all in the selected namespaces).`,
        entity: nameOf(p),
        lexicon: "k8s",
      }));
  },
};
