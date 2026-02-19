import { describe, test, expect } from "bun:test";
import { awsCompletions } from "./completions";
import type { CompletionContext } from "@intentius/chant/lsp/types";

function makeCtx(overrides: Partial<CompletionContext>): CompletionContext {
  return {
    uri: "file:///test.ts",
    content: "",
    position: { line: 0, character: 0 },
    wordAtCursor: "",
    linePrefix: "",
    ...overrides,
  };
}

describe("awsCompletions", () => {
  test("returns resource completions for `new ` prefix", () => {
    const ctx = makeCtx({
      linePrefix: "const b = new Bucket",
      wordAtCursor: "Bucket",
      content: "const b = new Bucket",
      position: { line: 0, character: 20 },
    });

    const items = awsCompletions(ctx);
    expect(items.length).toBeGreaterThan(0);

    const bucketItem = items.find((i) => i.label === "Bucket");
    expect(bucketItem).toBeDefined();
    expect(bucketItem?.kind).toBe("resource");
    expect(bucketItem?.detail).toContain("AWS::S3::Bucket");
  });

  test("filters resource completions by prefix", () => {
    const ctx = makeCtx({
      linePrefix: "const t = new Table",
      wordAtCursor: "Table",
      content: "const t = new Table",
      position: { line: 0, character: 19 },
    });

    const items = awsCompletions(ctx);
    // All items should start with "Table"
    for (const item of items) {
      expect(item.label.toLowerCase().startsWith("table")).toBe(true);
    }
  });

  test("limits results to 50", () => {
    const ctx = makeCtx({
      linePrefix: "const x = new ",
      wordAtCursor: "",
      content: "const x = new ",
      position: { line: 0, character: 14 },
    });

    const items = awsCompletions(ctx);
    expect(items.length).toBeLessThanOrEqual(50);
  });

  test("returns empty for non-matching context", () => {
    const ctx = makeCtx({
      linePrefix: "const x = 42",
      wordAtCursor: "42",
      content: "const x = 42",
      position: { line: 0, character: 13 },
    });

    const items = awsCompletions(ctx);
    expect(items.length).toBe(0);
  });
});
