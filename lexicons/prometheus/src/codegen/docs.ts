/**
 * Documentation generation for the prometheus lexicon: the generated
 * reference pages from the core docs pipeline, plus the authored pages in
 * docs/pages/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Prometheus";
}

const overview = `The prometheus lexicon types [Prometheus](https://prometheus.io/) recording and
alerting rules and [Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/)
routing. \`chant build\` emits the rule file Prometheus loads through
\`rule_files:\`, and the \`alertmanager.yml\` Alertmanager reads.

\`\`\`ts
import { RuleGroup, Route, Receiver } from "@intentius/chant-lexicon-prometheus";

export const api = new RuleGroup({
  name: "api",
  rules: [
    { record: "job:http_errors:ratio5m", expr: 'sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))' },
    { alert: "ApiErrors", expr: "job:http_errors:ratio5m > 0.05", for: "10m", labels: { severity: "page" }, annotations: { summary: "5xx ratio above 5%" } },
  ],
});

export const oncall = new Receiver({ name: "oncall", pagerduty_configs: [{ routing_key_file: "/etc/alertmanager/secrets/pd-key" }] });
export const fallback = new Receiver({ name: "fallback", webhook_configs: [{ url: "http://alert-sink:8080/" }] });
export const root = new Route({ receiver: fallback, group_by: ["alertname", "job"], routes: [{ matchers: ['severity="page"'], receiver: oncall }] });
\`\`\`

The same \`RuleGroup\` renders into a Prometheus Operator \`PrometheusRule\`
through the k8s lexicon, so rules are declared once whichever way Prometheus
loads them.

The \`Slo\` composite builds a service level objective to a \`RuleGroup\`:
error ratios per window, the error budget left, and the SRE Workbook's
multiwindow multi-burn-rate alerts. See [SLOs](./slos/).

Checks run at build time: PromQL syntax in every \`expr\` (PROM104), unique
group names (PROM101), valid durations (PROM103), routes that name
declared receivers (PROM201), and every alert severity routed by some route
(PROM202). \`promtool check rules\` and \`amtool check-config\` are wrapped as
helpers for tests and CI, and run when installed.

\`chant import\` turns an existing rule file or \`alertmanager.yml\` into this
TypeScript, and \`chant build\` on the result gives the file back (see
Importing Rule Files and alertmanager.yml).
`;

const outputFormat = `The prometheus lexicon serializes two files:

- **The rule file**, from every \`RuleGroup\` in the build: \`groups:\`, each
  with its \`name\`, optional \`interval\`, \`query_offset\`, \`limit\` and
  \`labels\`, and its \`rules\`. This is the file \`rule_files:\` points at and
  \`promtool check rules\` reads.
- **\`alertmanager.yml\`**, from the \`AlertmanagerSettings\`, \`Route\`,
  \`InhibitRule\`, \`Receiver\` and \`TimeInterval\` entities, in that section
  order: \`global\`, \`templates\`, \`route\`, \`inhibit_rules\`, \`receivers\`,
  \`time_intervals\`, \`tracing\`.

The rule file is the primary output when the build declares any rule
groups, and \`alertmanager.yml\` is written beside it (\`-o dist/rules.yml\`
also writes \`dist/alertmanager.yml\`). A build with only Alertmanager
entities emits \`alertmanager.yml\` as its primary output.

- Rules inside a group and child routes keep the order they are written in,
  which is the order Prometheus evaluates and Alertmanager matches them.
  Groups, receivers and time intervals, whose order carries no meaning, are
  sorted by name, so the files are the same however they were built. Keys
  inside a rule come out in the order Prometheus documents them (\`record\`
  or \`alert\`, \`expr\`, \`for\`, \`keep_firing_for\`, \`labels\`,
  \`annotations\`).
- A route references its receiver and time intervals by name in the output,
  whether the declaration used the entity or a string.
- The root route is the one \`Route\` no other route lists as a child.
- Neither file has a metadata channel, so no ownership marker is stamped.
`;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "prometheus",
    displayName: "Prometheus",
    description: "Typed Prometheus rule groups and Alertmanager routing",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/prometheus/",
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
