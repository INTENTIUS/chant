/**
 * SchemaStore's `prometheus.json` as a cross-check on the `prometheus.yml`
 * model, in tests only (#3365). The schema is vendored as a fixture
 * (import/testdata/schemastore-prometheus.json) so the tests need no network.
 *
 * It is not what the types are generated from: the schema is strict
 * (`additionalProperties: false`) and behind Prometheus v3.15.0, so a config
 * Prometheus accepts can fail it. The tests walk a document down the schema
 * and report every key a strict object does not list. A key in KNOWN_GAPS is
 * one the schema lacks and the lexicon types; anything else is a mismatch.
 */

import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import { readFileSync } from "fs";
import { join } from "path";
import type { Declarable } from "@intentius/chant/declarable";
import { prometheusConfigYaml } from "./build";
import { PROMETHEUS_CONFIG_SECTIONS, TYPED_SD_KINDS } from "./config-model";
import { PrometheusConfig, ScrapeConfig } from "./prometheus-config";

const testdata = join(import.meta.dirname, "import", "testdata");

type Schema = { [key: string]: unknown };
const SCHEMA = JSON.parse(readFileSync(join(testdata, "schemastore-prometheus.json"), "utf-8")) as Schema;

/**
 * What SchemaStore's schema lacks that Prometheus v3.15.0 and the lexicon have,
 * by the path to the key (`[]` is a list item).
 */
const KNOWN_GAPS = [
  "otlp",
  "runtime",
  "scrape_configs.[].kubernetes_sd_configs.[].attach_metadata",
];

function deref(s: Schema): Schema {
  let cur = s;
  while (typeof cur.$ref === "string") {
    let node: unknown = SCHEMA;
    for (const part of cur.$ref.replace(/^#\//, "").split("/")) node = (node as Schema)[part];
    cur = node as Schema;
  }
  return cur;
}

/** The schema and every `oneOf` / `anyOf` / `allOf` branch of it, references resolved. */
function branches(s: Schema): Schema[] {
  const self = deref(s);
  const out = [self];
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    for (const b of (self[key] as Schema[] | undefined) ?? []) out.push(...branches(b));
  }
  return out;
}

/** Paths of the keys in `value` that a strict object in `schema` does not list. */
function unlistedKeys(value: unknown, schema: Schema, path: string[] = [], out: string[] = []): string[] {
  const bs = branches(schema);
  if (Array.isArray(value)) {
    for (const item of value) {
      for (const b of bs) if (b.items) unlistedKeys(item, b.items as Schema, [...path, "[]"], out);
    }
  } else if (typeof value === "object" && value !== null) {
    const props: Record<string, Schema> = {};
    let strict = false;
    const patterns: Array<[RegExp, Schema]> = [];
    for (const b of bs) {
      Object.assign(props, (b.properties as Record<string, Schema> | undefined) ?? {});
      if (b.additionalProperties === false) strict = true;
      for (const [p, sub] of Object.entries((b.patternProperties as Record<string, Schema> | undefined) ?? {})) {
        patterns.push([new RegExp(p), sub]);
      }
    }
    for (const [key, v] of Object.entries(value)) {
      if (key in props) {
        unlistedKeys(v, props[key], [...path, key], out);
        continue;
      }
      const matched = patterns.filter(([re]) => re.test(key));
      for (const [, sub] of matched) unlistedKeys(v, sub, [...path, key], out);
      if (strict && matched.length === 0) out.push([...path, key].join("."));
    }
  }
  return out;
}

const gapsOf = (yaml: string) => [...new Set(unlistedKeys(load(yaml), SCHEMA))].sort();
const fixture = (name: string) => readFileSync(join(testdata, name), "utf-8");

describe("SchemaStore prometheus.json as a cross-check (#3365)", () => {
  test("the vendored schema is SchemaStore's prometheus.json", () => {
    expect(SCHEMA.$id).toBe("https://json.schemastore.org/prometheus.json");
    expect(SCHEMA.additionalProperties).toBe(false);
  });

  test("the full fixture differs from the schema only by the known gaps", () => {
    expect(gapsOf(fixture("prometheus-full.yml"))).toEqual([...KNOWN_GAPS].sort());
  });

  test("a config built from the typed sections, without the known gaps, has no key the schema lacks", () => {
    const yaml = prometheusConfigYaml([
      new PrometheusConfig({
        global: { scrape_interval: "15s", scrape_timeout: "10s", evaluation_interval: "30s", external_labels: { cluster: "dev" } },
        alerting: { alertmanagers: [{ scheme: "http", api_version: "v2", static_configs: [{ targets: ["alertmanager:9093"] }] }] },
        rule_files: ["rules.yml"],
        remote_write: [
          {
            url: "http://mimir:9009/api/v1/push",
            queue_config: { capacity: 10000 },
            write_relabel_configs: [{ source_labels: ["__name__"], regex: "debug_.*", action: "drop" }],
          },
        ],
      }),
      new ScrapeConfig({
        job_name: "app",
        scrape_interval: "5s",
        params: { format: ["prometheus"] },
        static_configs: [{ targets: ["app:8080"], labels: { tier: "web" } }],
        metric_relabel_configs: [{ source_labels: ["__name__"], regex: "go_.*", action: "drop" }],
      }),
      new ScrapeConfig({ job_name: "dns", dns_sd_configs: [{ names: ["api.service.internal"], type: "A", port: 9100 }] }),
    ] as Declarable[]);
    expect(gapsOf(yaml)).toEqual([]);
  });

  test("the keys the lexicon adds to the top level are the ones the schema lacks", () => {
    const schemaKeys = Object.keys(SCHEMA.properties as Record<string, unknown>);
    // The lexicon types every section the schema has.
    expect(schemaKeys.filter((k) => !PROMETHEUS_CONFIG_SECTIONS.includes(k))).toEqual([]);
    // And three the schema predates.
    expect(PROMETHEUS_CONFIG_SECTIONS.filter((k) => !schemaKeys.includes(k))).toEqual(["otlp", "tracing", "runtime"]);
  });

  test("every typed discovery kind is one the schema lists; the rest are carried untyped", () => {
    const definitions = Object.keys(SCHEMA.definitions as Record<string, unknown>);
    const schemaKinds = definitions.filter((k) => k.endsWith("_sd_configs"));
    expect(schemaKinds).toHaveLength(24);
    expect(TYPED_SD_KINDS.filter((k) => !schemaKinds.includes(k))).toEqual([]);
    expect(schemaKinds.filter((k) => !TYPED_SD_KINDS.includes(k))).toHaveLength(18);
  });
});
