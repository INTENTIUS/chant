import { describe, expect, it } from "vitest";
import { completions } from "./completions";

describe("prometheus LSP completions", () => {
  it("offers the entity classes after new", () => {
    const content = 'import { RuleGroup } from "@intentius/chant-lexicon-prometheus";\nconst g = new R';
    const items = completions({
      uri: "file:///rules.ts",
      content,
      position: { line: 1, character: content.split("\n")[1].length },
      wordAtCursor: "R",
      linePrefix: "const g = new R",
    });
    const labels = items.map((i) => i.label);
    expect(labels).toContain("RuleGroup");
    expect(labels).toContain("Route");
    expect(labels).toContain("Receiver");
  });

  it("returns an array for an empty context", () => {
    expect(Array.isArray(completions({} as never))).toBe(true);
  });
});
