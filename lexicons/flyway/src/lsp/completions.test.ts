import { describe, test, expect } from "vitest";
import { flywayCompletions } from "./completions";
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

describe("flywayCompletions", () => {
  test("returns resource completions for `new FlywayP` prefix", () => {
    const ctx = makeCtx({
      linePrefix: "const p = new FlywayP",
      wordAtCursor: "FlywayP",
      content: "const p = new FlywayP",
      position: { line: 0, character: 21 },
    });

    const items = flywayCompletions(ctx);
    expect(items.length).toBeGreaterThan(0);

    const projectItem = items.find((i) => i.label === "FlywayProject");
    expect(projectItem).toBeDefined();
    expect(projectItem?.kind).toBe("resource");
    expect(projectItem?.detail).toContain("Flyway::Project");
  });

  test("returns empty for non-constructor context", () => {
    const ctx = makeCtx({
      linePrefix: "const x = 42",
      wordAtCursor: "42",
      content: "const x = 42",
      position: { line: 0, character: 13 },
    });

    const items = flywayCompletions(ctx);
    expect(items.length).toBe(0);
  });

  test("filters by prefix correctly", () => {
    const ctx = makeCtx({
      linePrefix: "const e = new Env",
      wordAtCursor: "Env",
      content: "const e = new Env",
      position: { line: 0, character: 17 },
    });

    const items = flywayCompletions(ctx);
    for (const item of items) {
      expect(item.label.toLowerCase().startsWith("env")).toBe(true);
    }
  });

  test("limits results to 50", () => {
    const ctx = makeCtx({
      linePrefix: "const x = new ",
      wordAtCursor: "",
      content: "const x = new ",
      position: { line: 0, character: 14 },
    });

    const items = flywayCompletions(ctx);
    expect(items.length).toBeLessThanOrEqual(50);
  });
});
