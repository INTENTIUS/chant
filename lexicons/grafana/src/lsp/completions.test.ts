import { describe, expect, it } from "vitest";
import { completions } from "./completions";

describe("grafana LSP completions", () => {
  it("offers the panel classes after new", () => {
    const content = 'import { TimeSeriesPanel } from "@intentius/chant-lexicon-grafana";\nconst p = new Time';
    const items = completions({
      uri: "file:///dashboard.ts",
      content,
      position: { line: 1, character: content.split("\n")[1].length },
      wordAtCursor: "Time",
      linePrefix: "const p = new Time",
    });
    expect(items.map((i) => i.label)).toContain("TimeSeriesPanel");
  });

  it("offers the query classes by prefix", () => {
    const items = completions({
      uri: "file:///q.ts",
      content: "new Prom",
      position: { line: 0, character: 8 },
      wordAtCursor: "Prom",
      linePrefix: "new Prom",
    });
    expect(items.map((i) => i.label)).toContain("PromQuery");
  });

  it("returns an array for an empty context", () => {
    expect(Array.isArray(completions({} as never))).toBe(true);
  });
});
