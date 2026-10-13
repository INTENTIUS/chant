import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";

/** The prometheus lexicon's AI skills, read from src/skills/. */
export const prometheusSkills = createSkillsLoader(import.meta.url, [
  {
    file: "chant-prometheus.md",
    name: "chant-prometheus",
    description: "Declare Prometheus recording and alerting rule groups as typed chant entities and build a rule file that passes promtool",
    triggers: [
      { type: "context" as const, value: "prometheus rules" },
      { type: "context" as const, value: "alerting rule" },
      { type: "context" as const, value: "recording rule" },
    ],
    examples: [
      {
        title: "A recording rule and an alert on it",
        output:
          "export const api = new RuleGroup({\n" +
          '  name: "api",\n' +
          "  rules: [\n" +
          '    { record: "job:http_errors:ratio5m", expr: \'sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))\' },\n' +
          '    { alert: "ApiErrors", expr: "job:http_errors:ratio5m > 0.05", for: "10m", labels: { severity: "page" }, annotations: { summary: "5xx ratio above 5%" } },\n' +
          "  ],\n" +
          "});",
      },
    ],
  },
  {
    file: "chant-prometheus-alertmanager.md",
    name: "chant-prometheus-alertmanager",
    description: "Declare Alertmanager routing (routes, receivers, inhibit rules, time intervals) and keep every alert severity routed",
    triggers: [
      { type: "context" as const, value: "alertmanager" },
      { type: "context" as const, value: "alert routing" },
    ],
  },
  {
    file: "chant-prometheus-kubernetes.md",
    name: "chant-prometheus-kubernetes",
    description: "Render the same RuleGroups into a Prometheus Operator PrometheusRule, or into ConfigMaps for a plain Prometheus and Alertmanager on Kubernetes",
    triggers: [{ type: "context" as const, value: "PrometheusRule" }],
  },
]);
