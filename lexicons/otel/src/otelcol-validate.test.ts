/**
 * The filter, transform and redaction processors and the k8s_cluster and
 * kubeletstats receivers, rendered into one config and checked by the real
 * collector.
 *
 * The `otelcol validate` tests run when `otelcol-contrib` is on PATH (or
 * `OTELCOL_BIN` names a contrib build) and skip otherwise; CI does not install
 * it. The structural tests run everywhere.
 */

import { describe, expect, test } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { collectorYaml } from "./collector";
import { validateCollectorConfig, validateCollectorEntities } from "./validate-config";
import type { CollectorConfig } from "./model";
import { Pipeline } from "./pipeline";
import {
  DebugExporter,
  FilterProcessor,
  K8sClusterReceiver,
  KubeletStatsReceiver,
  OtlpReceiver,
  RedactionProcessor,
  TransformProcessor,
} from "./components";

function findOtelcol(): string | undefined {
  const candidates = [process.env.OTELCOL_BIN, "otelcol-contrib"].filter((c): c is string => !!c);
  for (const bin of candidates) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) return bin;
  }
  return undefined;
}

const OTELCOL = findOtelcol();

function otelcolValidate(yaml: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "chant-otelcol-"));
  try {
    const file = join(dir, "config.yaml");
    writeFileSync(file, yaml);
    // kubeletstats and k8s_cluster are built during validate; auth_type none keeps them off the Kubernetes API.
    const r = spawnSync(OTELCOL!, ["validate", `--config=${file}`], { encoding: "utf-8", timeout: 60_000 });
    return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixture(): Declarable[] {
  const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
  const cluster = new K8sClusterReceiver({
    auth_type: "none",
    collection_interval: "30s",
    node_conditions_to_report: ["Ready", "MemoryPressure"],
    allocatable_types_to_report: ["cpu", "memory", "pods"],
  });
  const kubelet = new KubeletStatsReceiver({
    auth_type: "none",
    endpoint: "http://localhost:10255",
    metric_groups: ["node", "pod", "container"],
    extra_metadata_labels: ["container.id"],
  });
  const dropHealth = new FilterProcessor({
    name: "health",
    error_mode: "ignore",
    traces: { span: ['attributes["http.route"] == "/healthz"'] },
    metrics: { datapoint: ['metric.name == "k8s.pod.phase" and value_int == 0'] },
    logs: { log_record: ["severity_number < SEVERITY_NUMBER_INFO"] },
  });
  const tidy = new TransformProcessor({
    error_mode: "ignore",
    trace_statements: [
      { context: "span", conditions: ["kind == SPAN_KIND_SERVER"], statements: ['set(attributes["tier"], "edge")'] },
      'delete_key(span.attributes, "http.request.header.cookie")',
    ],
    metric_statements: [{ context: "datapoint", statements: ['delete_key(attributes, "pod_ip")'] }],
    log_statements: [{ context: "log", statements: ['set(severity_text, "WARN") where severity_number == 13'] }],
  });
  const scrub = new RedactionProcessor({
    allow_all_keys: true,
    blocked_key_patterns: ["^gen_ai\\.(prompt|completion)"],
    blocked_values: ["4[0-9]{12}(?:[0-9]{3})?"],
    allowed_values: [".+@example\\.com"],
    hash_function: "sha3",
    summary: "silent",
  });
  const debug = new DebugExporter({});
  return [
    otlp,
    cluster,
    kubelet,
    dropHealth,
    tidy,
    scrub,
    debug,
    new Pipeline({ signal: "traces", receivers: [otlp], processors: [dropHealth, tidy, scrub], exporters: [debug] }),
    new Pipeline({ signal: "metrics", receivers: [cluster, kubelet], processors: [dropHealth, tidy], exporters: [debug] }),
    new Pipeline({ signal: "logs", receivers: [otlp], processors: [dropHealth, tidy, scrub], exporters: [debug] }),
  ];
}

describe("rendered config with filter, transform, redaction, k8s_cluster and kubeletstats", () => {
  test("passes the lexicon's own checks", () => {
    const entities = fixture();
    expect(validateCollectorEntities(entities)).toEqual([]);
    const config = load(collectorYaml(entities)) as CollectorConfig;
    expect(validateCollectorConfig(config)).toEqual([]);
    expect(Object.keys(config.receivers ?? {})).toEqual(["otlp", "k8s_cluster", "kubeletstats"]);
    expect(Object.keys(config.processors ?? {})).toEqual(["filter/health", "transform", "redaction"]);
    expect(config.service?.pipelines?.metrics?.receivers).toEqual(["k8s_cluster", "kubeletstats"]);
  });

  test("OTTL and regexes reach the YAML unchanged", () => {
    const config = load(collectorYaml(fixture())) as any;
    expect(config.processors["filter/health"].traces.span).toEqual(['attributes["http.route"] == "/healthz"']);
    expect(config.processors.transform.trace_statements[1]).toBe('delete_key(span.attributes, "http.request.header.cookie")');
    expect(config.processors.redaction.blocked_key_patterns).toEqual(["^gen_ai\\.(prompt|completion)"]);
  });

  test.skipIf(!OTELCOL)("otelcol validate accepts it", () => {
    const { ok, output } = otelcolValidate(collectorYaml(fixture()));
    expect(output).toBe("");
    expect(ok).toBe(true);
  });

  test.skipIf(!OTELCOL)("otelcol validate rejects OTTL written for the wrong context", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const bad = new FilterProcessor({ traces: { span: ['metric.name == "x"'] } });
    const debug = new DebugExporter({});
    const { ok, output } = otelcolValidate(
      collectorYaml([otlp, bad, debug, new Pipeline({ signal: "traces", receivers: [otlp], processors: [bad], exporters: [debug] })]),
    );
    expect(ok).toBe(false);
    expect(output).toContain("unable to parse OTTL condition");
  });
});
