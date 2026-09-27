import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";

/** The grafana lexicon's AI skills, read from src/skills/. */
export const grafanaSkills = createSkillsLoader(import.meta.url, [
  {
    file: "chant-grafana.md",
    name: "chant-grafana",
    description:
      "Declare Grafana dashboards, panels, typed Prometheus/Tempo/Loki queries and datasources as chant entities, and build dashboard JSON Grafana imports as it is",
    triggers: [
      { type: "context" as const, value: "grafana" },
      { type: "context" as const, value: "grafana dashboard" },
      { type: "file-pattern" as const, value: "*.dashboard.ts" },
    ],
    examples: [
      {
        title: "A request-rate panel on a declared Prometheus datasource",
        output:
          'const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });\n' +
          'const rate = new PromQuery({ expr: "sum(rate(http_requests_total[$__rate_interval]))" });\n' +
          'export const overview = new Dashboard({ title: "Overview", panels: [new TimeSeriesPanel({ title: "Rate", datasource: prometheus, targets: [rate] })] });',
      },
    ],
  },
  {
    file: "chant-grafana-provisioning.md",
    name: "chant-grafana-provisioning",
    description: "Load chant-built Grafana dashboards and datasources into a running Grafana through its provisioning directories, in Docker or Kubernetes",
    triggers: [{ type: "context" as const, value: "grafana provisioning" }],
  },
]);
