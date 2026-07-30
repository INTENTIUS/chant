import { describe, expect, it } from "vitest";
import type { CompletionContext } from "@intentius/chant/lsp/types";
import { completions } from "./completions";

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

describe("LSP completions", () => {
  it("suggests the fountain kinds after `new `", () => {
    const items = completions(ctx({ linePrefix: "export const e = new " }));
    const labels = items.map((i) => i.label);

    expect(labels).toContain("Environment");
    expect(labels).toContain("Vault");
    expect(labels).toContain("Agent");
    expect(items.every((i) => i.kind === "resource")).toBe(true);
  });

  it("narrows on a typed prefix", () => {
    const items = completions(ctx({ linePrefix: "new Env", wordAtCursor: "Env" }));

    expect(items.map((i) => i.label)).toEqual(["Environment"]);
    expect(items[0].detail).toBe("Fountain::V1::Environment");
  });

  it("suggests properties inside a constructor", () => {
    const content = "const a = new Agent({\n  ";
    const items = completions(
      ctx({ content, position: { line: 1, character: 2 }, linePrefix: "  " }),
    );
    const labels = items.map((i) => i.label);

    // Property names come off propertyConstraints — the key the core
    // LexiconEntry contract reads. A rename there silently empties this.
    expect(labels).toContain("runtime");
    expect(labels).toContain("model");
    expect(items.every((i) => i.kind === "property")).toBe(true);
  });

  it("returns nothing in an unrelated position", () => {
    expect(completions(ctx({ linePrefix: "const x = 1" }))).toEqual([]);
  });
});
