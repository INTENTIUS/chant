import { describe, expect, it } from "vitest";
import { hover } from "./hover";

describe("prometheus LSP hover", () => {
  it("describes RuleGroup and the file it lands in", () => {
    const info = hover({
      uri: "file:///rules.ts",
      content: "new RuleGroup({})",
      position: { line: 0, character: 6 },
      word: "RuleGroup",
      lineText: "new RuleGroup({})",
    });
    expect(info?.contents).toContain("Prometheus::Rules::RuleGroup");
    expect(info?.contents).toContain("rule file");
    expect(info?.contents).toContain("v3.15.0");
  });

  it("describes an Alertmanager entity against the Alertmanager pin", () => {
    const info = hover({ uri: "file:///am.ts", content: "new Receiver({})", position: { line: 0, character: 6 }, word: "Receiver", lineText: "new Receiver({})" });
    expect(info?.contents).toContain("alertmanager.yml");
    expect(info?.contents).toContain("v0.34.1");
  });

  it("returns undefined for an unknown word", () => {
    expect(hover({ uri: "file:///x.ts", content: "", position: { line: 0, character: 0 }, word: "Nope", lineText: "" })).toBeUndefined();
  });
});
