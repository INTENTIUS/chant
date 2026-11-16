import { describe, expect, it } from "vitest";
import { completions } from "./completions";

const after = (linePrefix: string, wordAtCursor: string) => ({ uri: "file:///jobs.ts", content: linePrefix, position: { line: 0, character: linePrefix.length }, wordAtCursor, linePrefix });

describe("prow LSP completions", () => {
  it("returns nothing outside a constructor", () => {
    expect(completions(after("const x = 42", "42"))).toHaveLength(0);
  });

  it("completes the job kinds after `new`", () => {
    const labels = completions(after("export const unit = new P", "P")).map((c) => c.label);
    expect(labels).toContain("Presubmit");
    expect(labels).toContain("Postsubmit");
    expect(labels).toContain("Periodic");
  });
});
