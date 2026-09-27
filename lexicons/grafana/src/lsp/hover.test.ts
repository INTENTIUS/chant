import { describe, expect, it } from "vitest";
import { hover } from "./hover";

describe("grafana LSP hover", () => {
  it("describes a panel and its plugin id", () => {
    const info = hover({
      uri: "file:///dashboard.ts",
      content: "new StatPanel({})",
      position: { line: 0, character: 6 },
      word: "StatPanel",
      lineText: "new StatPanel({})",
    });
    expect(info?.contents).toContain("Grafana::Panel::stat");
    expect(info?.contents).toContain("Panel plugin `stat`");
  });

  it("describes a query and its datasource type", () => {
    const info = hover({ uri: "file:///q.ts", content: "new TempoQuery({})", position: { line: 0, character: 6 }, word: "TempoQuery", lineText: "new TempoQuery({})" });
    expect(info?.contents).toContain("`tempo` datasources");
  });

  it("returns undefined for an unknown word", () => {
    expect(hover({ uri: "file:///x.ts", content: "", position: { line: 0, character: 0 }, word: "Nope", lineText: "" })).toBeUndefined();
  });
});
