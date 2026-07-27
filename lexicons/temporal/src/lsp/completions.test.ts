import { describe, test, expect } from "vitest";
import { temporalCompletions } from "./completions";
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

describe("temporalCompletions", () => {
  test("returns resource completions for `new ` prefix", () => {
    const ctx = makeCtx({
      linePrefix: "const ns = new TemporalNamespace",
      wordAtCursor: "TemporalNamespace",
      content: "const ns = new TemporalNamespace",
      position: { line: 0, character: 33 },
    });

    const items = temporalCompletions(ctx);
    const nsItem = items.find((i) => i.label === "TemporalNamespace");
    expect(nsItem).toBeDefined();
    expect(nsItem?.kind).toBe("resource");
    expect(nsItem?.detail).toBe("Temporal::Namespace");
  });

  test("includes all 4 resources for a bare `new `", () => {
    const ctx = makeCtx({
      linePrefix: "const x = new ",
      wordAtCursor: "",
      content: "const x = new ",
      position: { line: 0, character: 14 },
    });

    const items = temporalCompletions(ctx);
    const labels = items.map((i) => i.label);
    expect(labels).toEqual(
      expect.arrayContaining(["TemporalServer", "TemporalNamespace", "SearchAttribute", "TemporalSchedule"]),
    );
  });

  test("filters by prefix", () => {
    const ctx = makeCtx({
      linePrefix: "const s = new Temporal",
      wordAtCursor: "Temporal",
      content: "const s = new Temporal",
      position: { line: 0, character: 22 },
    });

    const items = temporalCompletions(ctx);
    for (const item of items) {
      expect(item.label.toLowerCase().startsWith("temporal")).toBe(true);
    }
  });

  test("returns [] outside a completion context", () => {
    const ctx = makeCtx({});
    expect(temporalCompletions(ctx)).toEqual([]);
  });
});
