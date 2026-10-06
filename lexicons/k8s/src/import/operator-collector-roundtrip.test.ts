/**
 * An OpenTelemetryCollector through `chant import` (#3367): the CR
 * `OtelOperatorCollector` writes imports as otel declarations, `spec.config`
 * becomes `collectorConfig([...])` (an object, not the text `collectorYaml`
 * makes), and `chant build` gives back the same resource.
 *
 * The CR is written by `OtelOperatorCollector` itself, so the test holds the
 * writer and the reader to each other. The custom component's pin travels in
 * the `otel.chant.dev/header` annotation and comes back as the pin in the
 * imported `custom-components.ts`.
 */

import { describe, expect, test } from "vitest";
import { loadAll } from "js-yaml";
import { build } from "@intentius/chant/build";
import { expandComposite } from "@intentius/chant/composite";
import type { SerializerResult } from "@intentius/chant/serializer";
import {
  DebugExporter,
  LoadBalancingExporter,
  OtlpReceiver,
  Pipeline,
  TailSamplingProcessor,
  defineComponent,
  otelSerializer,
} from "@intentius/chant-lexicon-otel";
import { k8sSerializer } from "../serializer";
import { OtelOperatorCollector } from "../composites/otel-operator-collector";
import { importManifest, removeDir } from "./testdata/embedded/fixtures";

type Json = Record<string, unknown>;

function primary(out: string | SerializerResult | undefined): string {
  if (out === undefined) return "";
  return typeof out === "string" ? out : out.primary;
}

const Mycorp = defineComponent<{ endpoint: string }>()({
  kind: "receiver",
  type: "mycorp",
  pin: { source: "github.com/mycorp/otel", version: "v1.2.3" },
});

function manifest(): string {
  const config = [
    new Pipeline({
      signal: "traces",
      receivers: [new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } }), new Mycorp({ endpoint: "0.0.0.0:9999" })],
      processors: [
        new TailSamplingProcessor({
          decision_wait: "5s",
          policies: [{ name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } }],
        }),
      ],
      exporters: [
        new DebugExporter({}),
        new LoadBalancingExporter({
          routing_key: "traceID",
          protocol: { otlp: { tls: { insecure: true } } },
          resolver: { dns: { hostname: "gw-headless.observability.svc" } },
        }),
      ],
    }),
  ];
  const instance = OtelOperatorCollector({ name: "gw", mode: "deployment", replicas: 2, config });
  return primary(k8sSerializer.serialize(new Map(expandComposite("gw", instance as never))));
}

function find(docs: Json[], kind: string): Json {
  const doc = docs.find((d) => d.kind === kind);
  if (!doc) throw new Error(`no ${kind}`);
  return doc;
}

describe("OtelOperatorCollector -> chant import -> chant build", () => {
  test("spec.config is imported as otel declarations and builds back to the same resource", async () => {
    const yaml = manifest();
    const input = (loadAll(yaml) as Json[]).filter((d) => d);
    expect(((find(input, "OpenTelemetryCollector").spec as Json).config as Json).service).toBeDefined();

    const imported = await importManifest(yaml);
    try {
      expect(imported.result.error).toBeUndefined();
      expect(imported.result.success).toBe(true);

      // An object, so `collectorConfig`; `collectorYaml` would put text in a field the CRD types as a map.
      const sources = Object.values(imported.files).join("\n");
      expect(sources).toContain("collectorConfig(");
      expect(sources).not.toContain("collectorYaml(");
      expect(sources).toContain("new OtlpReceiver(");
      expect(sources).toContain("new TailSamplingProcessor(");
      expect(sources).toContain("new Pipeline(");
      // The pin the annotation carried is back on the custom component.
      expect(sources).toContain("github.com/mycorp/otel");

      const result = await build(imported.srcDir, [k8sSerializer, otelSerializer]);
      expect(result.errors).toEqual([]);
      const output = (loadAll(primary(result.outputs.get("k8s"))) as Json[]).filter((d) => d);
      expect(find(output, "OpenTelemetryCollector")).toEqual(find(input, "OpenTelemetryCollector"));
      for (const kind of ["ServiceAccount", "ClusterRole", "ClusterRoleBinding"]) expect(find(output, kind)).toEqual(find(input, kind));
    } finally {
      removeDir(imported.dir);
    }
  });
});
