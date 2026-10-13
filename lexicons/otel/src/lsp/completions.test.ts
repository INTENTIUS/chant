import { describe, expect, it } from "vitest";
import { completions } from "./completions";

describe("otel LSP completions", () => {
  it("offers the built-in classes after new", () => {
    const content = 'import { OtlpReceiver } from "@intentius/chant-lexicon-otel";\nconst r = new Otlp';
    const items = completions({
      uri: "file:///collector.ts",
      content,
      position: { line: 1, character: content.split("\n")[1].length },
      wordAtCursor: "Otlp",
      linePrefix: "const r = new Otlp",
    });
    const labels = items.map((i) => i.label);
    expect(labels).toContain("OtlpReceiver");
    expect(labels).toContain("OtlpExporter");
    expect(labels).toContain("OtlpHttpExporter");
  });

  it("returns an array for an empty context", () => {
    expect(Array.isArray(completions({} as never))).toBe(true);
  });
});
