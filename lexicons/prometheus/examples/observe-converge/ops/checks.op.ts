// The built files through the upstream tools, before anything ships them:
// promtool over the rule file, with tests generated from the SLO (each
// burn-rate pair fires at its rate and not below it), and the collector
// binary over its config, at the version chant's config types follow.
//
// Each step fails the run when its tool is missing or rejects the file.
import { Op, phase } from "@intentius/chant/op";
import { otelcolComponents, otelcolValidate } from "@intentius/chant-lexicon-otel";
import { promtoolCheckRules, promtoolTestRules } from "@intentius/chant-lexicon-prometheus/op/builders";
import { checkout } from "../src/slo";

export const checks = Op({
  name: "observability-checks",
  overview: "Check the built rule file and collector config with promtool and otelcol",
  phases: [
    phase("Rules", [
      promtoolCheckRules({ rules: "dist/rules.yml" }),
      promtoolTestRules({
        rules: "dist/rules.yml",
        slos: [{ slo: checkout, good: 'http_requests_total{job="checkout",code="200"}', bad: 'http_requests_total{job="checkout",code="500"}' }],
      }),
    ]),
    phase("Collector", [otelcolValidate({ config: "dist/collector.yaml" }), otelcolComponents({ config: "dist/collector.yaml" })]),
  ],
});
