import { afterEach, describe, expect, test } from "vitest";
import { propertiesAt, propertyPosition, setPropertyTrees } from "./properties";
import { completions } from "./completions";
import { hover } from "./hover";

const TREES = {
  OtlpReceiver: {
    protocols: {
      type: "object",
      description: "Protocols is the configuration for the supported protocols.",
      properties: {
        grpc: { type: "object", properties: { endpoint: { type: "string", description: "Endpoint to listen on." } } },
        http: { type: "object" },
      },
    },
  },
  TailSamplingProcessor: {
    decision_wait: { type: "duration" },
    policies: { type: "object[]", properties: { name: { type: "string" }, latency: { type: "object", properties: { threshold_ms: { type: "number" } } } } },
    num_traces: { type: "number", deprecated: true },
  },
};

afterEach(() => setPropertyTrees(undefined));

describe("property positions", () => {
  test("the keys of the objects around the cursor, through lists", () => {
    expect(propertyPosition("new OtlpReceiver({ ")).toEqual({ className: "OtlpReceiver", path: [] });
    expect(propertyPosition("new OtlpReceiver({ protocols: { grpc: { ")).toEqual({ className: "OtlpReceiver", path: ["protocols", "grpc"] });
    expect(propertyPosition('new OtlpReceiver({ protocols: { http: {}, "grpc": { ')).toEqual({ className: "OtlpReceiver", path: ["protocols", "grpc"] });
    expect(propertyPosition('new TailSamplingProcessor({ policies: [{ name: "a" }, { latency: { ')).toEqual({
      className: "TailSamplingProcessor",
      path: ["policies", "latency"],
    });
    expect(propertyPosition("new OtlpReceiver({ protocols: {} });\nconst x = { ")).toBeUndefined();
    expect(propertyPosition("const x = { ")).toBeUndefined();
  });

  test("the properties at a path", () => {
    setPropertyTrees(TREES);
    expect(Object.keys(propertiesAt({ className: "OtlpReceiver", path: ["protocols"] })!)).toEqual(["grpc", "http"]);
    expect(propertiesAt({ className: "OtlpReceiver", path: ["nope"] })).toBeUndefined();
  });
});

describe("completion and hover", () => {
  const at = (content: string, word = "") => {
    const lines = content.split("\n");
    return { uri: "file:///c.ts", content, position: { line: lines.length - 1, character: lines[lines.length - 1].length }, wordAtCursor: word, linePrefix: lines[lines.length - 1] };
  };

  test("offers the properties at the cursor's depth, with upstream's description", () => {
    setPropertyTrees(TREES);
    const items = completions(at("const r = new OtlpReceiver({ protocols: { grpc: { "));
    expect(items.map((i) => i.label)).toEqual(["endpoint"]);
    expect(items[0].documentation).toContain("Endpoint to listen on.");
    const top = completions(at("new TailSamplingProcessor({ num", "num"));
    expect(top).toEqual([expect.objectContaining({ label: "num_traces", detail: "number", deprecated: true })]);
  });

  test("still offers the classes after new", () => {
    setPropertyTrees(TREES);
    expect(completions(at("const r = new Otlp", "Otlp")).map((i) => i.label)).toContain("OtlpReceiver");
  });

  test("hovers a property with its description", () => {
    setPropertyTrees(TREES);
    const content = "new OtlpReceiver({ protocols";
    const info = hover({ uri: "file:///c.ts", content, position: { line: 0, character: 19 }, word: "protocols", lineText: content });
    expect(info?.contents).toContain("Protocols is the configuration for the supported protocols.");
  });
});
