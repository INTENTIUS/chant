/**
 * Documentation generation for the grafana lexicon: the generated reference
 * pages from the core docs pipeline, plus the authored pages in docs/pages/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Grafana";
}

const overview = `The grafana lexicon types what a [Grafana](https://grafana.com/docs/grafana/latest/) dashboard
shows: datasources, dashboards, rows, panels, queries and variables. \`chant build\`
writes one JSON file per dashboard, the JSON Grafana imports as it is, plus the
provisioning files Grafana reads for dashboards and datasources. Grafana server
settings, users and plugins are out of scope.

\`\`\`ts
import { Datasource, PromQuery, TimeSeriesPanel, Dashboard } from "@intentius/chant-lexicon-grafana";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });
const rate = new PromQuery({ expr: "sum(rate(http_requests_total[$__rate_interval]))" });
const requests = new TimeSeriesPanel({ title: "Requests per second", datasource: prometheus, targets: [rate] });

export const overview = new Dashboard({ title: "Overview", panels: [requests] });
\`\`\`

Panels: time series, stat, gauge, table, logs, traces, heatmap and text, plus
rows. Queries: Prometheus (PromQL), Tempo (TraceQL) and Loki (LogQL). Panel
options and query fields are generated from Grafana's own schemas at a pinned
version, corrected against Grafana's CUE, and track Grafana 12.4 and 13.x. Every
build validates the dashboards against the same schemas.
\`definePanel\` and \`defineQuery\` add plugins chant doesn't ship.

Three composites build whole dashboards from declarations in other lexicons:
\`RedDashboard\` from an otel \`spanmetrics\` connector, \`SloDashboard\` from a
prometheus \`Slo\` and \`AgentDashboard\` from the otel GenAI preset. Metric names
come from the declaration, so renaming one moves the panels. See
[Dashboards from Declarations](./composites/).

Checks catch a query aimed at a datasource nobody declared, with
\`Datasource\` or \`ExternalDatasource\` (GRAF101), or of the
wrong type (GRAF102), a \`$variable\` the dashboard doesn't declare (GRAF103),
duplicate uids and ids (GRAF104), panels off the grid or overlapping (GRAF105),
anything Grafana's dashboard schema rejects (GRAF107), PromQL sent to a
Prometheus that doesn't parse (GRAF108), and dashboard providers that load a
dashboard twice or not into its declared folder (GRAF109).
`;

const outputFormat = `The grafana lexicon writes Grafana's own files, keyed by path under the
directory of the \`-o\` output:

- \`dashboards/<uid>.json\`, or \`dashboards/<folder>/<uid>.json\` for a
  dashboard with a \`folder\`: the dashboard JSON, one file per dashboard.
- \`provisioning/datasources/chant.yaml\`: every declared datasource.
- \`provisioning/dashboards/chant.yaml\`: a file provider for the dashboards
  directory; a default one unless a \`DashboardProvider\` is declared.

The primary output (the \`-o\` file itself) is a JSON index of the dashboards,
datasources and files that were built.

- Dashboard JSON carries the pinned schema's \`schemaVersion\`, no numeric \`id\`,
  and every field Grafana's schema requires (link defaults, an empty
  \`annotations.list\`, \`fieldConfig.overrides\`).
- Panels without a position are laid out in declaration order on the 24-column
  grid. Ids and query \`refId\`s are assigned in order unless set.
- A declared \`Datasource\` is written as \`{ type, uid }\` wherever it is
  referenced, and as its uid inside another datasource's \`jsonData\`.
- \`chant build\` rewrites JSON files with sorted keys; Grafana does not care
  about key order.
- The dashboard JSON carries no ownership marker. Grafana keeps who manages a
  dashboard in the resource's metadata on its \`dashboard.grafana.app\` API,
  not in the JSON.
`;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "grafana",
    displayName: "Grafana",
    description: "Typed Grafana dashboards, panels, queries and datasources, built to dashboard JSON and provisioning files",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/grafana/",
    overview,
    outputFormat,
    serviceFromType,
    srcDir: join(pkgDir, "src"),
    examplesDir: join(pkgDir, "examples"),
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
