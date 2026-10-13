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

  it("names the schema a panel's options come from, or that there is none", () => {
    const at = (word: string) => hover({ uri: "file:///d.ts", content: `new ${word}({})`, position: { line: 0, character: 6 }, word, lineText: `new ${word}({})` })?.contents;
    expect(at("NodeGraphPanel")).toContain("Panel plugin `nodeGraph`. Options typed from");
    expect(at("NodeGraphPanel")).toContain("(`nodegraph`)");
    expect(at("AlertListPanel")).toContain("Grafana publishes no options schema for it");
  });

  it("describes a query and its datasource type", () => {
    const info = hover({ uri: "file:///q.ts", content: "new TempoQuery({})", position: { line: 0, character: 6 }, word: "TempoQuery", lineText: "new TempoQuery({})" });
    expect(info?.contents).toContain("`tempo` datasources");
  });

  it("returns undefined for an unknown word", () => {
    expect(hover({ uri: "file:///x.ts", content: "", position: { line: 0, character: 0 }, word: "Nope", lineText: "" })).toBeUndefined();
  });
});
