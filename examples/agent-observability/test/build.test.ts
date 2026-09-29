/**
 * The agent-observability example builds into the stack #2904 describes, and
 * each rendered config says what the example claims it does. Always runs:
 * no cluster and no network. The real tools run when they are installed
 * (`otelcol-contrib` or `OTELCOL_BIN`, `promtool`, `amtool`) and each check
 * says it skipped otherwise; the on-demand e2e (stack.e2e.test.ts) runs all
 * three from their images against the same output, then runs the stack.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { dump, load } from "js-yaml";
import { validateCollectorConfig, GENAI_CONTENT_ATTRIBUTES, genAiMetrics, spanMetricsNames } from "@intentius/chant-lexicon-otel";
import {
  amtoolCheckConfig,
  promtoolCheckRules,
  sloMetrics,
  validateAlertmanagerConfig,
  validateRuleFile,
  validateSeverityRouting,
  type AlertmanagerConfig,
  type RuleFileConfig,
} from "@intentius/chant-lexicon-prometheus";
import { validateGrafanaOutput, DATASOURCES_FILE } from "@intentius/chant-lexicon-grafana";
import { agentRuns } from "../src/slo";
import { red as redConnector } from "../src/gateway-metrics";
import { scrapeEndpoint } from "../src/gateway-components";
import { buildExample, find, images, type Built } from "./built";

function findOtelcol(): string | undefined {
  for (const bin of [process.env.OTELCOL_BIN, "otelcol-contrib"].filter((b): b is string => !!b)) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf-8" });
    if (!r.error && r.status === 0) return bin;
  }
  return undefined;
}
const OTELCOL = findOtelcol();

function otelcolValidate(yaml: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "chant-agent-obs-"));
  try {
    const file = join(dir, "config.yaml");
    writeFileSync(file, yaml);
    const r = spawnSync(OTELCOL!, ["validate", `--config=${file}`], { encoding: "utf-8", timeout: 60_000 });
    return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let built: Built;

beforeAll(async () => {
  built = await buildExample();
}, 120_000);

describe("agent-observability builds", () => {
  test("with no errors, into all four outputs", () => {
    expect(built.errors).toEqual([]);
    expect(built.k3dYaml).toContain("kind: Simple");
    expect(built.k8sYaml).not.toBe("");
    expect(built.rulesYaml).toContain("groups:");
    expect(built.alertmanagerYaml).toContain("route:");
    expect(Object.keys(built.grafanaFiles)).toContain(DATASOURCES_FILE);
  });

  test("a k3d cluster with a server and an agent node, leaving the default kubeconfig alone", () => {
    const cluster = load(built.k3dYaml) as { servers: number; agents: number; image: string; options: { kubeconfig: { updateDefaultKubeconfig: boolean } } };
    expect(cluster.servers).toBe(1);
    expect(cluster.agents).toBe(1);
    expect(cluster.image).toMatch(/^rancher\/k3s:v/);
    expect(cluster.options.kubeconfig.updateDefaultKubeconfig).toBe(false);
  });

  test("every image is pinned to a tag, none from Helm", () => {
    const all = images(built.manifests);
    expect(all.length).toBeGreaterThanOrEqual(7);
    for (const image of all) expect(image, image).toMatch(/:[\w.-]+$/);
    for (const image of all) expect(image, image).not.toMatch(/:latest$/);
    expect(built.k8sYaml).not.toMatch(/helm\.sh\//);
  });
});

describe("the collectors", () => {
  test("an agent DaemonSet and a two-replica gateway Deployment, with their roles recorded", () => {
    const agent = find(built.manifests, "DaemonSet", "otel-agent");
    const gateway = find(built.manifests, "Deployment", "otel-gateway");
    expect(agent.metadata.annotations?.["otel.chant.dev/role"]).toBe("agent");
    expect(gateway.metadata.annotations?.["otel.chant.dev/role"]).toBe("gateway");
    expect(gateway.spec?.replicas).toBe(2);
    expect(find(built.manifests, "Service", "otel-gateway-headless").spec?.clusterIP).toBe("None");
  });

  test("the agent routes traces by trace id to the gateway's headless Service, and the rest to its ClusterIP Service", () => {
    const { exporters = {}, service } = built.agentConfig;
    const lb = exporters["loadbalancing/gateway"] as { routing_key: string; resolver: { k8s: { service: string } } };
    expect(lb.routing_key).toBe("traceID");
    expect(lb.resolver.k8s.service).toBe("otel-gateway-headless.observability");
    expect(service.pipelines.traces.exporters).toEqual(["loadbalancing/gateway"]);
    expect(service.pipelines.metrics.exporters).toEqual(["otlp/gateway"]);
    expect(service.pipelines.logs.exporters).toEqual(["otlp/gateway"]);
    // The Role the k8s resolver needs to watch the gateway's Endpoints.
    expect(find(built.manifests, "Role", "otel-agent-endpoints").metadata.namespace).toBe("observability");
  });

  test("the gateway counts every span before it samples: spanmetrics and the GenAI branch sit ahead of tail_sampling", () => {
    const { pipelines } = built.gatewayConfig.service;
    expect(pipelines.traces.exporters).toEqual(["spanmetrics", "forward/genai", "forward/sampled"]);
    expect(pipelines.traces.processors).not.toContain("tail_sampling");
    expect(pipelines["traces/sampled"].receivers).toEqual(["forward/sampled"]);
    expect(pipelines["traces/sampled"].processors).toEqual(["tail_sampling", "batch"]);
    expect(pipelines["traces/sampled"].exporters).toEqual(["otlp/tempo"]);
    expect(pipelines["traces/genai"].exporters).toEqual(["spanmetrics/genai", "sum/genai_tokens"]);
    expect(pipelines.metrics.receivers).toEqual(["otlp", "spanmetrics", "spanmetrics/genai", "sum/genai_tokens"]);
    expect(pipelines.metrics.exporters).toEqual(["prometheus"]);
    expect(pipelines.logs.exporters).toEqual(["otlphttp/loki"]);
  });

  test("tail sampling keeps errors and slow traces, and a probabilistic share of the rest", () => {
    const sampling = built.gatewayConfig.processors?.tail_sampling as { policies: Array<{ type: string }> };
    expect(sampling.policies.map((p) => p.type)).toEqual(["status_code", "latency", "probabilistic"]);
  });

  test("GenAI content is deleted on the way in, on traces and logs", () => {
    const transform = JSON.stringify(built.gatewayConfig.processors?.["transform/genai_content"]);
    for (const key of GENAI_CONTENT_ATTRIBUTES) expect(transform).toContain(key);
    expect(built.gatewayConfig.service.pipelines.traces.processors).toContain("transform/genai_content");
    expect(built.gatewayConfig.service.pipelines.logs.processors).toContain("transform/genai_content");
  });

  test("the otel lexicon's import round-trip fixtures are these two configs as built", () => {
    // lexicons/otel/src/import/roundtrip.test.ts imports both; keep its copies current.
    const fixture = (name: string) =>
      readFileSync(join(import.meta.dirname, "../../../lexicons/otel/src/import/testdata", name), "utf-8")
        .split("\n")
        .slice(3)
        .join("\n");
    expect(fixture("agent-observability-agent.yaml")).toBe(built.agentConfigYaml);
    expect(fixture("agent-observability-gateway.yaml")).toBe(built.gatewayConfigYaml);
  });

  test("both configs pass the otel lexicon's config checks (OTEL101-OTEL106, OTEL112)", () => {
    for (const config of [built.agentConfig, built.gatewayConfig]) {
      expect(validateCollectorConfig(config).filter((i) => i.severity === "error")).toEqual([]);
    }
  });

  test.skipIf(!OTELCOL)(`both configs pass otelcol validate${OTELCOL ? "" : " (skipped: otelcol-contrib is not installed)"}`, () => {
    // The agent's k8s resolver builds a Kubernetes client when the pipeline
    // is built, which fails off-cluster; validate it with the dns resolver
    // naming the same Service instead. The e2e validates the real one inside
    // the cluster.
    const offCluster = structuredClone(built.agentConfig);
    const lb = offCluster.exporters!["loadbalancing/gateway"] as { resolver: Record<string, unknown> };
    lb.resolver = { dns: { hostname: "otel-gateway-headless.observability.svc", port: "4317" } };
    for (const yaml of [dump(offCluster), built.gatewayConfigYaml]) {
      const r = otelcolValidate(yaml);
      expect(r.ok, r.output).toBe(true);
    }
  });
});

describe("rules and routing", () => {
  test("the cluster runs the rule file and alertmanager.yml the prometheus build writes", () => {
    expect(find(built.manifests, "ConfigMap", "prometheus-config").data?.["rules.yml"]).toBe(built.rulesYaml);
    expect(find(built.manifests, "ConfigMap", "alertmanager-config").data?.["alertmanager.yml"]).toBe(built.alertmanagerYaml);
  });

  test("the SLO records its error ratios and burns on both tiers, over the RED metrics", () => {
    const slo = sloMetrics(agentRuns);
    expect(slo.burnRates.map((b) => b.tier)).toEqual(["page", "page", "ticket", "ticket"]);
    expect(built.rulesYaml).toContain(slo.errorRatio["5m"]);
    expect(built.rulesYaml).toContain("traces_span_metrics_calls_total");
    const rules = load(built.rulesYaml) as RuleFileConfig;
    expect(validateRuleFile(rules).filter((i) => i.severity === "error")).toEqual([]);
  });

  test("Alertmanager routes page and ticket to their receivers, and a page mutes its tickets", () => {
    const am = load(built.alertmanagerYaml) as AlertmanagerConfig;
    const rules = load(built.rulesYaml) as RuleFileConfig;
    expect(validateAlertmanagerConfig(am).filter((i) => i.severity === "error")).toEqual([]);
    expect(validateSeverityRouting([rules], am)).toEqual([]);
    expect(am.route?.routes?.map((r) => [r.matchers, r.receiver])).toEqual([
      [['severity="page"'], "oncall"],
      [['severity="ticket"'], "tickets"],
    ]);
    expect(am.inhibit_rules).toHaveLength(1);
  });

  test("Prometheus scrapes each gateway replica through the headless Service", () => {
    const prometheusYml = find(built.manifests, "ConfigMap", "prometheus-config").data!["prometheus.yml"];
    expect(prometheusYml).toContain("otel-gateway-headless.observability.svc.cluster.local");
    expect(built.gatewayConfig.exporters?.prometheus).toEqual(expect.objectContaining({ endpoint: "0.0.0.0:8889" }));
  });

  test("promtool check rules", () => {
    const r = promtoolCheckRules(built.rulesYaml);
    if (!r.ran) return console.log("promtool is not installed; skipped `promtool check rules`");
    expect(r.ok, r.output).toBe(true);
  });

  test("amtool check-config", () => {
    const r = amtoolCheckConfig(built.alertmanagerYaml);
    if (!r.ran) return console.log("amtool is not installed; skipped `amtool check-config`");
    expect(r.ok, r.output).toBe(true);
  });
});

describe("Grafana", () => {
  test("provisions Prometheus, Tempo and Loki, and the ConfigMap carries every file the grafana build writes", () => {
    expect(built.grafanaIndex.datasources.map((d) => d.type).sort()).toEqual(["loki", "prometheus", "tempo"]);
    const data = find(built.manifests, "ConfigMap", "grafana-files").data ?? {};
    expect(Object.keys(data)).toHaveLength(Object.keys(built.grafanaFiles).length);
    for (const key of Object.keys(data)) expect(key).toMatch(/^[-._a-zA-Z0-9]+$/);
    // Each file is mounted back at its own path, under the directory Grafana reads it from.
    const pod = find(built.manifests, "Deployment", "grafana").spec?.template.spec;
    const mounts = pod.containers[0].volumeMounts as Array<{ name: string; mountPath: string }>;
    const roots = { "/etc/grafana/provisioning": "provisioning", "/var/lib/grafana/dashboards": "dashboards" } as const;
    const mounted: string[] = [];
    for (const volume of pod.volumes as Array<{ name: string; configMap?: { name: string; items: Array<{ key: string; path: string }> } }>) {
      if (volume.configMap?.name !== "grafana-files") continue;
      const at = mounts.find((m) => m.name === volume.name)!.mountPath;
      const root = Object.entries(roots).find(([dir]) => at === dir || at.startsWith(`${dir}/`))!;
      const prefix = `${root[1]}${at.slice(root[0].length)}/`;
      for (const item of volume.configMap.items) {
        expect(data[item.key], item.path).toBe(built.grafanaFiles[prefix + item.path]);
        mounted.push(prefix + item.path);
      }
    }
    expect(mounted.sort()).toEqual(Object.keys(built.grafanaFiles).sort());
  });

  test("the dashboards pass the grafana lexicon's output checks (GRAF1xx)", () => {
    const dashboards = Object.entries(built.grafanaFiles)
      .filter(([path]) => path.endsWith(".json"))
      .map(([source, text]) => ({ source, json: JSON.parse(text) as Record<string, unknown> }));
    const datasources = (load(built.grafanaFiles[DATASOURCES_FILE]) as { datasources: never[] }).datasources;
    expect(validateGrafanaOutput({ dashboards, datasources }).filter((i) => i.severity === "error")).toEqual([]);
  });

  test("the RED, SLO and agent dashboards, in one folder", () => {
    expect(built.grafanaIndex.dashboards.map((d) => d.uid).sort()).toEqual(["genai-agents", "red-traces-span-metrics", "slo-support-agent-runs"]);
  });

  test("each dashboard queries the names its source declaration emits", () => {
    const text = (uid: string) => built.grafanaFiles[built.grafanaIndex.dashboards.find((d) => d.uid === uid)!.file];
    const genai = genAiMetrics();
    const red = spanMetricsNames(redConnector, scrapeEndpoint);
    const slo = sloMetrics(agentRuns);
    expect(text("red-traces-span-metrics")).toContain(red.calls.prometheus);
    expect(text("red-traces-span-metrics")).toContain(red.duration!.prometheus);
    expect(text("slo-support-agent-runs")).toContain(slo.errorBudgetRemaining);
    expect(text("genai-agents")).toContain(genai.calls.prometheus);
    expect(text("genai-agents")).toContain(genai.inputTokens.prometheus);
    // And the SLO's SLI reads the same RED series the dashboard does.
    expect(built.rulesYaml).toContain(red.calls.prometheus);
  });
});
