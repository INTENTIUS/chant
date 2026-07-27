import { describe, test, expect } from "vitest";
import { forgejoCompletions } from "./completions";
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

describe("forgejoCompletions", () => {
  test("delegates to github's resource completions after `new `", () => {
    const ctx = makeCtx({
      linePrefix: "const build = new Job",
      wordAtCursor: "Job",
      content: "const build = new Job",
      position: { line: 0, character: 22 },
    });

    const items = forgejoCompletions(ctx);
    const jobItem = items.find((i) => i.label === "Job");
    expect(jobItem).toBeDefined();
    expect(jobItem?.kind).toBe("resource");
    expect(jobItem?.detail).toContain("GitHub::Actions::Job");
  });

  test("returns [] outside a completion context", () => {
    const ctx = makeCtx({});
    expect(forgejoCompletions(ctx)).toEqual([]);
  });
});
