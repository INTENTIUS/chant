/**
 * The extension point: a component chant doesn't ship, defined by a team,
 * serializes and lints exactly like a built-in, and carries its schema pin.
 */
import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { otelSerializer } from "./serializer";
import { postSynthChecks } from "./lint/post-synth";
import { BatchProcessor, OtlpExporter, OtlpReceiver } from "./components";
import { COLLECTOR_PIN, defineComponent, definitionFor, isOTelComponent } from "./define";
import { Pipeline } from "./pipeline";
import { collectorTopologyOf } from "./topology";

interface VendorExporterConfig {
  api: { key: string; site?: string };
  queue_size?: number;
}

const VendorExporter = defineComponent<VendorExporterConfig>()({
  kind: "exporter",
  type: "vendor2559",
  pin: { source: "@acme/otel-vendor-exporter", version: "1.4.2", digest: "sha256:0f1e2d" },
  description: "Sends telemetry to Vendor",
  validate: (c) => (c.api.key.includes("${") ? [] : ["api.key must be an ${env:...} reference"]),
  endpoints: (c) => [`https://intake.${c.api.site ?? "vendor.example"}`],
});

/** A zod-compatible validator, without depending on zod. */
const RedactProcessor = defineComponent<{ patterns: string[] }>()({
  kind: "processor",
  type: "redact2559",
  pin: { source: "github.com/acme/otel-redact", version: "v0.3.0" },
  validate: {
    safeParse: (v: unknown) =>
      Array.isArray((v as { patterns?: unknown }).patterns) && (v as { patterns: unknown[] }).patterns.length > 0
        ? { success: true }
        : { success: false, error: { issues: [{ path: ["patterns"], message: "needs at least one pattern" }] } },
  },
});

function build(list: unknown[]) {
  const entities = new Map(list.map((e, i) => [`e${i}`, e as Declarable]));
  const out = otelSerializer.serialize(entities);
  const yaml = typeof out === "string" ? out : out.primary;
  const ctx = makePostSynthCtx("otel", yaml, entities);
  const diags = postSynthChecks.flatMap((c) => c.check(ctx));
  return { yaml, diags, entities };
}

describe("defineComponent", () => {
  test("a custom component is a component like any built-in", () => {
    const v = new VendorExporter({ name: "eu", api: { key: "${env:VENDOR_KEY}", site: "vendor.eu" } });
    expect(isOTelComponent(v)).toBe(true);
    expect(v.componentId).toBe("vendor2559/eu");
    expect(v.entityType).toBe("OTel::Exporter::vendor2559");
    expect(v.lexicon).toBe("otel");
    expect(definitionFor(v.entityType)?.builtin).toBe(false);
  });

  test("it serializes under its section with a # chant: pin header", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const v = new VendorExporter({ name: "eu", api: { key: "${env:VENDOR_KEY}" }, queue_size: 500 });
    const { yaml, diags } = build([otlp, v, new Pipeline({ signal: "traces", receivers: [otlp], exporters: [v] })]);
    expect(yaml.split("\n")[0]).toBe("# chant: exporter vendor2559/eu schema @acme/otel-vendor-exporter@1.4.2 sha256:0f1e2d");
    const parsed = load(yaml) as any;
    expect(parsed.exporters["vendor2559/eu"]).toEqual({ api: { key: "${env:VENDOR_KEY}" }, queue_size: 500 });
    expect(parsed.service.pipelines.traces.exporters).toEqual(["vendor2559/eu"]);
    expect(diags).toEqual([]);
  });

  test("built-ins get no header line", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const x = new OtlpExporter({ endpoint: "x:4317" });
    const { yaml } = build([otlp, x, new Pipeline({ signal: "traces", receivers: [otlp], exporters: [x] })]);
    expect(yaml.startsWith("receivers:")).toBe(true);
  });

  test("its own validate runs as OTEL107, function or safeParse", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const v = new VendorExporter({ api: { key: "plaintext" } });
    const r = new RedactProcessor({ patterns: [] });
    const { diags } = build([otlp, r, v, new Pipeline({ signal: "logs", receivers: [otlp], processors: [r], exporters: [v] })]);
    expect(diags.map((d) => [d.checkId, d.message])).toEqual([
      ["OTEL107", 'processor "redact2559": patterns: needs at least one pattern'],
      ["OTEL107", 'exporter "vendor2559": api.key must be an ${env:...} reference'],
    ]);
  });

  test("the reference and pipeline checks apply to it unchanged", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const unused = new VendorExporter({ name: "idle", api: { key: "${env:K}" } });
    const batch = new BatchProcessor({});
    const { diags } = build([
      otlp,
      batch,
      unused,
      new Pipeline({ signal: "traces", receivers: [otlp], processors: [batch], exporters: ["vendor2559/missing"] }),
    ]);
    expect(diags.map((d) => [d.checkId, d.entity])).toEqual([
      ["OTEL101", "vendor2559/missing"],
      ["OTEL103", "vendor2559/idle"],
    ]);
  });

  test("topology reports its endpoints and its pin", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const v = new VendorExporter({ name: "eu", api: { key: "${env:K}", site: "vendor.eu" } });
    const topo = collectorTopologyOf([otlp, v, new Pipeline({ signal: "metrics", receivers: [otlp], exporters: [v] })]);
    const component = topo.components.find((c) => c.id === "vendor2559/eu")!;
    expect(component.builtin).toBe(false);
    expect(component.schema).toEqual({ source: "@acme/otel-vendor-exporter", version: "1.4.2", digest: "sha256:0f1e2d" });
    expect(topo.exporters).toEqual([
      { id: "vendor2559/eu", type: "vendor2559", endpoints: ["https://intake.vendor.eu"], pipelines: ["metrics"], signals: ["metrics"] },
    ]);
    expect(topo.components.find((c) => c.id === "otlp")!.schema).toEqual({ ...COLLECTOR_PIN });
  });

  test("a built-in type cannot be redefined", () => {
    expect(() =>
      defineComponent<{ endpoint: string }>()({ kind: "exporter", type: "otlp", pin: { source: "x", version: "1" } }),
    ).toThrow(/built in/);
  });

  test("a type that is not collector syntax is refused", () => {
    expect(() =>
      defineComponent<object>()({ kind: "exporter", type: "has-dash", pin: { source: "x", version: "1" } }),
    ).toThrow(/not a collector type/);
  });
});
