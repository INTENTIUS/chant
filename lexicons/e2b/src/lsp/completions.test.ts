import { describe, expect, it } from "vitest";
import { completions } from "./completions";

const at = (linePrefix: string, wordAtCursor = "") => ({
  uri: "file:///steward.ts",
  content: linePrefix,
  position: { line: 0, character: linePrefix.length },
  wordAtCursor,
  linePrefix,
});

describe("e2b LSP completions", () => {
  it("offers Template after new", () => {
    const items = completions(at("const s = new T", "T"));
    expect(items.map((i) => i.label)).toEqual(["Template"]);
    expect(items[0].detail).toBe("E2B::Template");
  });

  it("offers Template's properties inside its object", () => {
    const labels = completions(at("new Template({ ")).map((i) => i.label);
    for (const p of ["name", "fromImage", "run", "cpuCount", "memoryMB"]) expect(labels).toContain(p);
  });
});
