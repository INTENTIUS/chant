import { describe, test, expect } from "vitest";
import { dockerCompletions } from "./completions";
import type { CompletionContext } from "@intentius/chant/lsp/types";

// The context these tests build must match the real CompletionContext.
// They previously used an older shape (word / isConstructorContext / prefix /
// fileContent) the interface no longer has — vitest strips types without
// checking them, so every assertion passed while exercising no completion
// path at all.
function ctx(partial: Partial<CompletionContext>): CompletionContext {
  return {
    uri: "file:///infra.ts",
    content: "",
    position: { line: 0, character: 0 },
    wordAtCursor: "",
    linePrefix: "",
    ...partial,
  };
}

describe("dockerCompletions", () => {
  test("suggests resource class names after `new `", () => {
    const items = dockerCompletions(ctx({ linePrefix: "const s = new " }));

    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.label)).toContain("Service");
    expect(items.every((i) => i.kind === "resource")).toBe(true);
  });

  test("narrows on a typed prefix", () => {
    const items = dockerCompletions(ctx({ linePrefix: "new Serv", wordAtCursor: "Serv" }));

    expect(items.map((i) => i.label)).toContain("Service");
    expect(items.every((i) => i.label.toLowerCase().startsWith("serv"))).toBe(true);
  });

  test("returns nothing in an unrelated position", () => {
    expect(dockerCompletions(ctx({ linePrefix: "const x = 1" }))).toEqual([]);
  });
});
