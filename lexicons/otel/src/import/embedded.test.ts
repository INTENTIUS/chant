import { describe, expect, test } from "vitest";
import { embeddedDocument, type EmbeddedContent } from "@intentius/chant/import/embedded";
import { otelPlugin } from "../plugin";
import { collectorConfigImporter } from "./embedded";

const CONFIG = `receivers:
  otlp:
    protocols:
      grpc: {}
  mycorp: {}
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: [otlp, mycorp]
      exporters: [debug]
`;

const site = (text: string, over: Partial<EmbeddedContent> = {}): EmbeddedContent => ({
  host: "k8s",
  hostType: "K8s::Core::ConfigMap",
  location: 'ConfigMap agent data["config.yaml"]',
  directory: "agent",
  text,
  document: embeddedDocument(text),
  ...over,
});

describe("a collector config embedded in another lexicon's resource (#2962)", () => {
  test("the plugin registers the importer", () => {
    expect(otelPlugin.embeddedImporters?.()).toEqual([collectorConfigImporter]);
  });

  test("matches collector configs held as text, nothing else", () => {
    expect(collectorConfigImporter.matches(site(CONFIG))).toBe(true);
    expect(collectorConfigImporter.matches(site("groups: []\n"))).toBe(false);
    expect(collectorConfigImporter.matches(site(CONFIG, { select: "config" }))).toBe(false);
  });

  test("imports the config as `chant import` does, referenced through collectorYaml", () => {
    const out = collectorConfigImporter.import(site(CONFIG));
    expect(out.files.map((f) => f.path)).toEqual(["custom-components.ts", "receivers.ts", "exporters.ts", "pipelines.ts"]);
    // Every declared component and pipeline, not the custom component's class.
    expect(out.value).toEqual({
      bindings: [
        { from: "receivers.ts", name: "otlp" },
        { from: "receivers.ts", name: "mycorp" },
        { from: "exporters.ts", name: "debug" },
        { from: "pipelines.ts", name: "traces" },
      ],
      shape: "list",
      through: { from: "@intentius/chant-lexicon-otel", name: "collectorYaml" },
    });
  });
});
