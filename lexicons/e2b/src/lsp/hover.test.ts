import { describe, expect, it } from "vitest";
import { hover } from "./hover";

const on = (word: string, lineText: string, content = lineText) => ({
  uri: "file:///steward.ts",
  content,
  position: { line: 0, character: 0 },
  word,
  lineText,
});

describe("e2b LSP hover", () => {
  it("describes Template with what it builds into and its properties", () => {
    const info = hover(on("Template", "new Template({})"));
    expect(info?.contents).toContain("E2B::Template");
    expect(info?.contents).toContain("e2b template create");
    expect(info?.contents).toContain("`fromImage: string`");
  });

  it("describes a Template property in a file that builds one", () => {
    const info = hover(on("memoryMB", "  memoryMB: 2048,", 'new Template({\n  memoryMB: 2048,\n})'));
    expect(info?.contents).toContain("even");
  });

  it("stays quiet on unrelated words", () => {
    expect(hover(on("x", "const x = 42"))).toBeUndefined();
    expect(hover(on("name", "const name = 'a'"))).toBeUndefined();
  });
});
