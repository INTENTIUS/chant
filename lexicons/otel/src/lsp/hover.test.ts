import { describe, expect, it } from "vitest";
import { hover } from "./hover";

describe("otel LSP hover", () => {
  it("describes a built-in component and its id", () => {
    const info = hover({
      uri: "file:///collector.ts",
      content: "new BatchProcessor({})",
      position: { line: 0, character: 6 },
      word: "BatchProcessor",
      lineText: "new BatchProcessor({})",
    });
    expect(info?.contents).toContain("OTel::Processor::batch");
    expect(info?.contents).toContain("`batch/<name>`");
  });

  it("returns undefined for an unknown word", () => {
    expect(hover({ uri: "file:///x.ts", content: "", position: { line: 0, character: 0 }, word: "Nope", lineText: "" })).toBeUndefined();
  });
});
