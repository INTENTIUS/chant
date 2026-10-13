/**
 * GRAF118: A panel reads a connector metric no collector in the build emits
 *
 * The prometheus lexicon's PROM301, over dashboards: each panel query and query variable whose datasource resolves to a prometheus datasource, with its template variables replaced as GRAF108 replaces them, goes through `collectorMetricIssues` (prometheus `collector-metrics.ts`). A name under a namespace the build's spanmetrics, servicegraph or GenAI connectors own that no collector config emits is reported, and a by (...) label that is not a declared dimension. Silent for names outside those namespaces, and when the build has no collector config.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { buildCollectorConfigs, collectorMetricIssues, collectorMetrics } from "@intentius/chant-lexicon-prometheus/collector-metrics";
import { grafanaArtifacts } from "./grafana-helpers";
import { knownDatasourcesOf } from "../../validate-output";
import { prometheusQueries, substituteTemplateVariables } from "../../promql-check";

export const graf118: PostSynthCheck = {
  id: "GRAF118",
  description: "A panel reads a connector metric no collector in the build emits",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const artifacts = grafanaArtifacts(ctx);
    if (artifacts.dashboards.length === 0) return [];
    const emitted = collectorMetrics(buildCollectorConfigs(ctx));
    if (!emitted) return [];
    const known = knownDatasourcesOf(artifacts);
    const out: PostSynthDiagnostic[] = [];
    for (const { json: d } of artifacts.dashboards) {
      for (const { where, expr } of prometheusQueries(d, known)) {
        for (const issue of collectorMetricIssues(substituteTemplateVariables(expr).text, emitted)) {
          out.push({
            checkId: "GRAF118",
            severity: "warning",
            message: `Dashboard "${String(d.title ?? d.uid ?? "?")}" ${where} ${issue.message}.`,
            entity: String(d.uid ?? ""),
            lexicon: "grafana",
          });
        }
      }
    }
    return out;
  },
};
