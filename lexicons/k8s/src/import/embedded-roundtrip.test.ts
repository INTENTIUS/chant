/**
 * Embedded content through `chant import` (#2962): a manifest holding a
 * collector config, rule groups or dashboard JSON imports as the owning
 * lexicon's typed declarations, referenced from the k8s resource, and
 * `chant build` gives back the same content.
 *
 * Fixtures (testdata/embedded/, provenance in its README.md): the
 * opentelemetry-collector Helm chart's rendered daemonset-only example, the
 * node-exporter PrometheusRule of kube-prometheus, a kube-prometheus
 * dashboard ConfigMap with the Grafana sidecar label, and the k8s build
 * output of examples/agent-observability.
 *
 * "The same" is per owner: a collector config equal as parsed YAML, rule
 * groups equal as parsed YAML, a dashboard equal after the grafana lexicon's
 * `normalizeDashboard` with its importer's edits applied (the grafana round
 * trip's own measure). Content no lexicon claims must come back as the same
 * text. embedded-types.e2e.test.ts type-checks the generated source.
 */

import { describe, expect, test } from "vitest";
import { join } from "path";
import { load, loadAll } from "js-yaml";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { otelSerializer } from "@intentius/chant-lexicon-otel";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus";
import { grafanaSerializer } from "@intentius/chant-lexicon-grafana";
import { parseGrafana, type DashboardResourceMetadata } from "@intentius/chant-lexicon-grafana/import/parser";
import { applyEdits } from "@intentius/chant-lexicon-grafana/import/edits";
import { normalizeDashboard } from "@intentius/chant-lexicon-grafana/import/normalize";
import { k8sSerializer } from "../serializer";
import { importManifest, read, removeDir, type Imported } from "./testdata/embedded/fixtures";

type Json = Record<string, unknown>;

interface RoundTrip extends Imported {
  /** The source manifest's documents. */
  input: Json[];
  /** The rebuilt k8s documents. */
  output: Json[];
  buildErrors: unknown[];
}

function primary(out: string | SerializerResult | undefined): string {
  if (out === undefined) return "";
  return typeof out === "string" ? out : out.primary;
}

async function roundTrip(fixture: string): Promise<RoundTrip> {
  const yaml = read(fixture);
  const imported = await importManifest(yaml);
  try {
    expect(imported.result.error).toBeUndefined();
    expect(imported.result.success).toBe(true);
    const result = await build(imported.srcDir, [k8sSerializer, otelSerializer, prometheusSerializer, grafanaSerializer]);
    return {
      ...imported,
      input: (loadAll(yaml) as Json[]).filter((d) => d),
      output: (loadAll(primary(result.outputs.get("k8s"))) as Json[]).filter((d) => d),
      buildErrors: result.errors,
    };
  } finally {
    removeDir(imported.dir);
  }
}

function find(docs: Json[], kind: string, name: string): Json {
  const doc = docs.find((d) => d.kind === kind && (d.metadata as Json | undefined)?.name === name);
  if (!doc) throw new Error(`no ${kind} ${name}`);
  return doc;
}

/** A collector config as the collector reads it: an empty component is `{}` whether written `{}` or left null. */
function collectorConfig(text: string): Json {
  const doc = (load(text) ?? {}) as Json;
  for (const section of ["receivers", "processors", "exporters", "connectors", "extensions"]) {
    const s = doc[section] as Json | undefined;
    if (!s) continue;
    for (const id of Object.keys(s)) if (s[id] === null) s[id] = {};
  }
  return doc;
}

/** A dashboard as the grafana round trip compares it: the importer's edits applied to the source, both normalized. */
function dashboards(source: string, rebuilt: string): { expected: Json; actual: Json } {
  const [resource] = parseGrafana(source).resources;
  const meta = resource.metadata as unknown as DashboardResourceMetadata;
  return {
    expected: normalizeDashboard(applyEdits(meta.source as Json, meta.edits)),
    actual: normalizeDashboard(JSON.parse(rebuilt) as Json),
  };
}

/** The directories of the generated source holding an owner's modules. */
function embeddedDirs(files: Record<string, string>): string[] {
  return [...new Set(Object.keys(files).filter((p) => p.includes("/")).map((p) => p.split("/")[0]))].sort();
}

describe("manifest -> TypeScript -> manifest, with embedded content imported by its owner", () => {
  test("a collector's ConfigMap becomes typed otel declarations, and the DaemonSet comes back whole", async () => {
    const out = await roundTrip("otel-collector-daemonset.yaml");
    expect(out.buildErrors).toEqual([]);
    expect(out.result.warnings).toEqual([]);

    const main = out.files["main.ts"];
    expect(main).toContain('import { collectorYaml } from "@intentius/chant-lexicon-otel";');
    expect(main).toMatch(/relay: collectorYaml\(\[\s+jaeger,/);
    expect(main).toContain('from "./example-opentelemetry-collector-agent/receivers";');
    expect(out.files["example-opentelemetry-collector-agent/receivers.ts"]).toContain("new OtlpReceiver(");
    expect(out.files["example-opentelemetry-collector-agent/pipelines.ts"]).toContain("new Pipeline(");

    const name = "example-opentelemetry-collector-agent";
    const before = find(out.input, "ConfigMap", name).data as Json;
    const after = find(out.output, "ConfigMap", name).data as Json;
    expect(collectorConfig(after.relay as string)).toEqual(collectorConfig(before.relay as string));

    // The whole DaemonSet comes back, pod template included. The chart renders
    // `spec:` followed by a whitespace-only line, which core's YAML reader
    // used to read as the end of the template's spec, moving its keys up to
    // the DaemonSet's spec (#2991).
    const daemonSet = find(out.output, "DaemonSet", name);
    expect(daemonSet).toEqual(find(out.input, "DaemonSet", name));
    const template = (daemonSet.spec as Json).template as Json;
    expect((template.spec as Json).serviceAccountName).toBe("example-opentelemetry-collector");
  });

  test("a PrometheusRule's spec.groups become prometheus RuleGroups", async () => {
    const out = await roundTrip("node-exporter-prometheusrule.yaml");
    expect(out.buildErrors).toEqual([]);
    expect(out.result.warnings).toEqual([]);

    const main = out.files["main.ts"];
    expect(main).toContain('from "./node-exporter-rules/rules";');
    expect(main).toMatch(/groups: \[[\s\S]*nodeExporter/);
    expect(out.files["node-exporter-rules/rules.ts"]).toContain("new RuleGroup(");

    const before = find(out.input, "PrometheusRule", "node-exporter-rules");
    const after = find(out.output, "PrometheusRule", "node-exporter-rules");
    expect(after).toEqual(before);
  });

  test("a dashboard ConfigMap with the sidecar label becomes a grafana Dashboard", async () => {
    const out = await roundTrip("grafana-dashboard-configmap.yaml");
    expect(out.buildErrors).toEqual([]);

    const main = out.files["main.ts"];
    expect(main).toContain('import { dashboardJson } from "@intentius/chant-lexicon-grafana";');
    expect(main).toMatch(/"alertmanager-overview\.json": dashboardJson\(\w+\)/);
    expect(out.files["grafana-dashboard-alertmanager-overview/dashboard.ts"]).toContain("new Dashboard(");

    const name = "grafana-dashboard-alertmanager-overview";
    const before = find(out.input, "ConfigMap", name);
    const after = find(out.output, "ConfigMap", name);
    expect(after.metadata).toEqual(before.metadata);
    const { expected, actual } = dashboards(
      (before.data as Json)["alertmanager-overview.json"] as string,
      (after.data as Json)["alertmanager-overview.json"] as string,
    );
    expect(actual).toEqual(expected);
  });

  test("examples/agent-observability's k8s output: every ConfigMap value comes back, the owned ones typed", async () => {
    const out = await roundTrip("agent-observability.yaml");
    expect(out.buildErrors).toEqual([]);
    expect(embeddedDirs(out.files)).toEqual([
      "grafana-dashboard-genai-agents",
      "grafana-dashboard-red-traces-span-metrics",
      "grafana-dashboard-slo-support-agent-runs",
      "otel-agent-config",
      "otel-gateway-config",
      "prometheus-config-rules",
    ]);
    // The rule group an Slo() built comes back as that Slo, referenced by its rules.
    expect(out.files["prometheus-config-rules/slos.ts"]).toContain("Slo(");
    expect(Object.values(out.files).join("\n")).toMatch(/ruleFileYaml\(\[\w+\.rules\]\)/);

    const configMaps = out.input.filter((d) => d.kind === "ConfigMap");
    expect(configMaps.length).toBeGreaterThanOrEqual(7);
    for (const before of configMaps) {
      const name = (before.metadata as Json).name as string;
      const after = find(out.output, "ConfigMap", name);
      const data = before.data as Record<string, string>;
      expect(Object.keys(after.data as Json).sort(), name).toEqual(Object.keys(data).sort());
      for (const [key, text] of Object.entries(data)) {
        const rebuilt = (after.data as Record<string, string>)[key];
        const at = `${name} ${key}`;
        if (key.endsWith(".json")) {
          const { expected, actual } = dashboards(text, rebuilt);
          expect(actual, at).toEqual(expected);
        } else if (name.startsWith("otel-")) {
          expect(collectorConfig(rebuilt), at).toEqual(collectorConfig(text));
        } else {
          expect(load(rebuilt), at).toEqual(load(text));
        }
      }
    }
  });

  test("a detected manifest delegates the same way", async () => {
    const imported = await importManifest(read("node-exporter-prometheusrule.yaml"), { detect: true });
    try {
      expect(imported.result.lexicon).toBe("k8s");
      expect(imported.result.detected).toBe(true);
      expect(imported.result.generatedFiles).toEqual(["main.ts", "node-exporter-rules/rules.ts"]);
    } finally {
      removeDir(imported.dir);
    }
  });

  test("the owners' modules lint clean", async () => {
    const yaml = [
      read("otel-collector-daemonset.yaml"),
      read("node-exporter-prometheusrule.yaml"),
      read("grafana-dashboard-configmap.yaml"),
    ].join("\n---\n");
    const imported = await importManifest(yaml);
    try {
      const dirs = embeddedDirs(imported.files);
      expect(dirs).toEqual(["example-opentelemetry-collector-agent", "grafana-dashboard-alertmanager-overview", "node-exporter-rules"]);
      for (const dir of dirs) {
        const lint = await lintCommand({ path: join(imported.srcDir, dir), format: "stylish" });
        if (lint.errorCount + lint.warningCount > 0) console.log(lint.output);
        expect(lint.errorCount, dir).toBe(0);
        expect(lint.warningCount, dir).toBe(0);
      }
    } finally {
      removeDir(imported.dir);
    }
  });
});
