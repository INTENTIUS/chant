import { describe, expect, it } from "vitest";
import { hover } from "./hover";

const ctx = (word: string) => ({ uri: "file:///x.ts", content: "", position: { line: 0, character: 0 }, word, lineText: "" });

describe("systemone hover", () => {
  it("documents decide and its keys", () => {
    expect(hover(ctx("decide"))?.contents).toContain("POST /v1/systemone");
    expect(hover(ctx("read"))?.contents).toContain("read contract");
  });

  it("is quiet for other words", () => {
    expect(hover(ctx("banana"))).toBeUndefined();
  });
});
