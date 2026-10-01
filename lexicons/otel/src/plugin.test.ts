import { describe, expect, it } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { otelPlugin } from "./plugin";
import { otelAuditCatalog } from "./lint/audit-catalog";

describe("otel plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(otelPlugin)).toBe(true);
  });

  it("is named otel and serializes under the OTEL prefix", () => {
    expect(otelPlugin.name).toBe("otel");
    expect(otelPlugin.serializer.name).toBe("otel");
    expect(otelPlugin.serializer.rulePrefix).toBe("OTEL");
  });

  it("ships lint rules and post-synth checks, all under the OTEL prefix", () => {
    const ids = [...otelPlugin.lintRules!().map((r) => r.id), ...otelPlugin.postSynthChecks!().map((c) => c.id)];
    expect(ids).toEqual([
      "OTEL001",
      "OTEL002",
      "OTEL101",
      "OTEL102",
      "OTEL103",
      "OTEL104",
      "OTEL105",
      "OTEL106",
      "OTEL107",
      "OTEL108",
      "OTEL109",
      "OTEL112",
      "OTEL113",
      "OTEL114",
      "OTEL115",
    ]);
    for (const id of ids) expect(id.startsWith("OTEL")).toBe(true);
  });

  it("catalogues every post-synth check for chant audit", () => {
    for (const check of otelPlugin.postSynthChecks!()) expect(otelAuditCatalog[check.id]).toBeDefined();
  });

  it("detects a collector config and nothing else", () => {
    expect(otelPlugin.detectTemplate!({ receivers: { otlp: {} }, service: { pipelines: { traces: {} } } })).toBe(true);
    expect(otelPlugin.detectTemplate!({ apiVersion: "v1", kind: "ConfigMap" })).toBe(false);
    expect(otelPlugin.detectTemplate!({ services: { web: {} } })).toBe(false);
  });

  it("loads its skills with content", () => {
    const skills = otelPlugin.skills!();
    expect(skills.map((s) => s.name)).toEqual(["chant-otel", "chant-otel-custom-components", "chant-otel-platforms"]);
    for (const s of skills) expect(s.content.length).toBeGreaterThan(100);
  });

  it("registers namespaced MCP contributions", () => {
    expect(otelPlugin.mcpTools!().map((t) => t.name)).toEqual(["otel:diff"]);
    expect(otelPlugin.mcpResources!().map((r) => r.uri)).toEqual(["otel:resource-catalog"]);
  });

  it("reports the collector topology for the graph, and nothing for a project without one", async () => {
    const { OtlpReceiver, DebugExporter } = await import("./components");
    const { Pipeline } = await import("./pipeline");
    expect(otelPlugin.graphMeta!(new Map())).toBeUndefined();
    expect(otelPlugin.graphMeta!(new Map([["other", { lexicon: "k8s", entityType: "Pod" } as never]]))).toBeUndefined();
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const debug = new DebugExporter({});
    const meta = otelPlugin.graphMeta!(new Map<string, never>([["otlp", otlp as never], ["debug", debug as never], ["p", new Pipeline({ signal: "traces", receivers: [otlp], exporters: [debug] }) as never]]));
    const collector = meta!.collector as { pipelines: { id: string }[]; exporters: { id: string; signals: string[] }[] };
    expect(collector.pipelines.map((p) => p.id)).toEqual(["traces"]);
    expect(collector.exporters.map((e) => [e.id, e.signals])).toEqual([["debug", ["traces"]]]);
  });
});
